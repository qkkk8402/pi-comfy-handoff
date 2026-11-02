import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComfyAdapter, HostConfig, GenerationResult, LlamaAdapter, ModelState, Workflow } from './types.js';
import { OutcomeUnknown } from './types.js';

export interface RunState {
  id: string;
  phase: string;
  state: 'running' | 'complete' | 'failed' | 'cancelled' | 'recovery_required';
  model?: string;
  promptId?: string;
  completed: GenerationResult[];
  error?: string;
  updatedAt: number;
}
export interface RunnerOptions {
  signal?: AbortSignal;
  onProgress?: (value: unknown) => void;
  modelId?: string;
  idempotencyKey?: string;
  onAccepted?: (state: RunState) => Promise<void> | void;
}
type Snapshot = ModelState[];
type Journal = RunState & { version: 1; comfyuiUrl: string; llamaServerUrl: string; snapshot: Snapshot; workflows: Workflow[]; index: number; submitUnknown?: boolean; cancelledPromptId?: string };
const TERMINAL = new Set(['complete', 'failed', 'cancelled']);

export class Runner {
  private active = false;
  private current?: Journal;
  private cancelRequested = false;
  private readonly confirmedCancellations = new Set<string>();
  private cancellation?: { id: string; promise: Promise<void> };
  private writes: Promise<void> = Promise.resolve();
  private readonly journalPath: string;
  constructor(private readonly config: HostConfig, private readonly adapters: { llama: LlamaAdapter; comfy: ComfyAdapter; waitForVramRelease?: (minFreeMiB?: number) => Promise<void> }) {
    this.journalPath = join(config.stateDir, 'runner-state.json');
  }

  get isBusy(): boolean { return this.active; }

  async connect(modelId?: string): Promise<void> {
    await this.exclusive(async () => {
      const journal = await this.readJournal();
      if (journal && !TERMINAL.has(journal.state)) throw new Error(`Unresolved run ${journal.id}; call recover before connecting`);
      await this.ensureComfyIdle();
      const models = await this.adapters.llama.listModels();
      const target = this.resolveTarget(models, modelId);
      if (!target) throw new Error('No llama-server model is available');
      if (models.some(item => item.name !== target.name && item.status !== 'unloaded')) throw new Error('Other llama-server models are resident');
      if (target.status !== 'loaded') await this.adapters.llama.load(target.name);
    });
  }

  async status(): Promise<RunState | { state: 'idle'; phase: 'idle' }> {
    if (this.active) await this.writes;
    const state = this.active ? this.current : await this.readJournal();
    return state ? this.publicState(state) : { state: 'idle', phase: 'idle' };
  }

  async markInterrupted(): Promise<void> {
    const journal = await this.readJournal();
    if (!journal || TERMINAL.has(journal.state) || journal.state === 'recovery_required') return;
    journal.phase = 'recovery_required'; journal.state = 'recovery_required';
    journal.error = 'Manager restarted during this generation; explicit recovery is required';
    await this.persist(journal);
  }

  async generate(workflows: Workflow[], options: RunnerOptions = {}): Promise<RunState> {
    if (!Array.isArray(workflows) || workflows.length < 1 || workflows.length > 32) throw new Error('generate expects 1 to 32 workflows');
    return this.exclusive(async () => {
      const prior = await this.readJournal();
      if (prior && !TERMINAL.has(prior.state)) throw new Error(`Unresolved run ${prior.id}; call recover before starting another`);
      const id = options.idempotencyKey || randomUUID();
      if (prior?.id === id) {
        if (JSON.stringify(prior.workflows) !== JSON.stringify(workflows)) throw new Error('The same call ID was used with different workflows');
        await options.onAccepted?.(this.publicState(prior));
        return this.publicState(prior);
      }
      const models = await this.adapters.llama.listModels();
      const target = this.resolveTarget(models, options.modelId);
      if (!target) throw new Error('No llama-server model is available');
      if (target.status !== 'loaded') throw new Error(`Model ${target.name} is ${target.status}; connect it before generating`);
      const resident = models.filter(model => model.name !== target.name && model.status !== 'unloaded');
      if (resident.length) throw new Error(`Other llama-server models are resident: ${resident.map(model => `${model.name} (${model.status})`).join(', ')}`);
      const journal: Journal = {
        version: 1, id, phase: 'starting', state: 'running', model: target.name, completed: [], updatedAt: Date.now(),
        comfyuiUrl: this.config.comfyuiUrl, llamaServerUrl: this.config.llamaServerUrl,
        snapshot: models.map(({ name, status }) => ({ name, status })), workflows: structuredClone(workflows), index: 0,
      };
      this.current = journal; this.cancelRequested = false; this.confirmedCancellations.clear();
      await this.persist(journal);
      await options.onAccepted?.(this.publicState(journal));
      try {
        await this.ensureComfyIdle();
        if (options.signal?.aborted || this.cancelRequested) throw new CancelRequested();
        if (target.status === 'loaded') {
          journal.phase = 'unloading_llm'; await this.persist(journal);
          await this.adapters.llama.unload(target.name);
          if (this.adapters.waitForVramRelease) await this.adapters.waitForVramRelease();
          else if (this.adapters.comfy.waitForRelease) await this.adapters.comfy.waitForRelease();
        }
        journal.phase = 'generating'; await this.persist(journal);
        for (let i = 0; i < workflows.length; i++) {
          if (options.signal?.aborted || this.cancelRequested) throw new CancelRequested();
          journal.index = i; await this.persist(journal);
          let promptId: string;
          try { promptId = await this.adapters.comfy.submit(workflows[i]!, `${id}-${i}`); }
          catch (error) {
            if (error instanceof OutcomeUnknown) journal.submitUnknown = true;
            await this.persist(journal);
            throw error;
          }
          journal.promptId = promptId; journal.submitUnknown = false; await this.persist(journal);
          if (this.cancelRequested) { await this.cancelAndConfirm(promptId); journal.promptId = undefined; throw new CancelRequested(); }
          try {
            const result = await this.adapters.comfy.wait(promptId, options.onProgress, options.signal);
            if (options.signal?.aborted || this.cancelRequested) { await this.cancelAndConfirm(promptId); journal.promptId = undefined; throw new CancelRequested(); }
            journal.completed.push(result); journal.promptId = undefined; await this.persist(journal);
          } catch (error) {
            if (this.confirmedCancellations.has(promptId)) throw new CancelRequested();
            if (isAbort(error, options.signal) || this.cancelRequested) {
              await this.cancelAndConfirm(promptId);
              journal.promptId = undefined;
              throw new CancelRequested();
            }
            if (error instanceof OutcomeUnknown) {
              journal.phase = 'recovery_required'; journal.state = 'recovery_required'; journal.error = `Prompt outcome unknown: ${message(error)}`;
              await this.persist(journal); return this.publicState(journal);
            }
            throw error;
          }
        }
        journal.error = undefined;
      } catch (error) {
        if (error instanceof CancelRequested) journal.error = undefined;
        else { journal.error = message(error); }
        if (journal.submitUnknown) {
          journal.phase = 'recovery_required'; journal.state = 'recovery_required';
          journal.error = `Submission outcome unknown: ${message(error)}`;
          await this.persist(journal); return this.publicState(journal);
        }
      }
      const finalState = journal.error ? 'failed' : this.cancelRequested || options.signal?.aborted ? 'cancelled' : 'complete';
      await this.cleanup(journal, finalState);
      return this.publicState(journal);
    });
  }

  async cancel(): Promise<void> {
    if (this.active) {
      this.cancelRequested = true;
      const state = this.current;
      if (state && (state.comfyuiUrl !== this.config.comfyuiUrl || state.llamaServerUrl !== this.config.llamaServerUrl)) throw new Error('Configured endpoints differ from active run');
      if (state?.promptId) await this.cancelAndConfirm(state.promptId);
      return;
    }
    await this.exclusive(async () => {
      const state = await this.readJournal();
      if (!state || TERMINAL.has(state.state)) return;
      if (state.comfyuiUrl !== this.config.comfyuiUrl || state.llamaServerUrl !== this.config.llamaServerUrl) throw new Error('Configured endpoints differ from unresolved journal');
      if (!state.promptId) throw new Error('No known prompt is active; recovery is required before cleanup');
      await this.cancelAndConfirm(state.promptId);
      state.promptId = undefined;
      await this.cleanup(state, 'cancelled');
    });
  }

  async recover(): Promise<RunState> {
    return this.exclusive(async () => {
      const state = await this.readJournal();
      if (!state) return { id: '', phase: 'idle', state: 'complete', completed: [], updatedAt: Date.now() };
      this.current = state;
      if (state.comfyuiUrl !== this.config.comfyuiUrl || state.llamaServerUrl !== this.config.llamaServerUrl) throw new Error('Configured endpoints differ from unresolved journal');
      if (TERMINAL.has(state.state)) return this.publicState(state);
      state.phase = 'recovering'; await this.persist(state);
      if (state.promptId) {
        const knownPromptId = state.promptId;
        if (state.cancelledPromptId === knownPromptId) {
          await this.waitQueueAbsent(knownPromptId);
          state.promptId = undefined;
          await this.cleanup(state, 'cancelled');
          return this.publicState(state);
        }
        try {
          const result = await this.adapters.comfy.wait(knownPromptId);
          if (!state.completed.some(item => item.promptId === result.promptId)) state.completed.push(result);
          state.promptId = undefined; state.submitUnknown = false;
        } catch (error) {
          if (error instanceof OutcomeUnknown) {
            const queue = await this.adapters.comfy.queue();
            if (queue.running.length || queue.pending.length) {
              state.phase = 'recovery_required'; state.state = 'recovery_required'; state.error = message(error); await this.persist(state); return this.publicState(state);
            }
            state.error = `Prompt outcome is unknown; empty queue confirmed during explicit recovery: ${message(error)}`;
            state.promptId = undefined;
            await this.cleanup(state, 'failed');
            return this.publicState(state);
          }
          const promptId = knownPromptId;
          const q = await this.adapters.comfy.queue();
          if (q.running.includes(promptId) || q.pending.includes(promptId)) {
            await this.adapters.comfy.cancel(promptId); await this.waitQueueAbsent(promptId);
          }
          state.promptId = undefined;
          if (!(error instanceof OutcomeUnknown)) state.error = message(error);
        }
      } else if (state.submitUnknown) {
        const q = await this.adapters.comfy.queue();
        if (q.running.length || q.pending.length) { state.phase = 'recovery_required'; state.state = 'recovery_required'; await this.persist(state); return this.publicState(state); }
        state.error = 'Unknown submission was not retried; ComfyUI queue is empty during explicit recovery';
        await this.cleanup(state, 'failed');
        return this.publicState(state);
      } else if (!state.state) state.state = 'failed';
      const recoveredState = state.state === 'cancelled' ? 'cancelled' : state.completed.length === state.workflows.length ? 'complete' : 'failed';
      if (recoveredState === 'complete') state.error = undefined;
      else if (recoveredState === 'failed' && !state.error) state.error = 'Interrupted batch; remaining workflows were not submitted';
      await this.cleanup(state, recoveredState);
      return this.publicState(state);
    });
  }

  private async cleanup(state: Journal, finalState: RunState['state']): Promise<void> {
    state.phase = 'freeing_comfy'; await this.persist(state);
    try {
      await this.ensureComfyIdle();
      await this.adapters.comfy.free();
      const observed = await this.adapters.llama.listModels();
      const needsLoad = state.snapshot.some(model => model.status === 'loaded' && observed.find(item => item.name === model.name)?.status !== 'loaded');
      if (needsLoad) {
        if (this.adapters.waitForVramRelease) await this.adapters.waitForVramRelease(this.config.minFreeMiB);
        else if (this.adapters.comfy.waitForRelease) await this.adapters.comfy.waitForRelease(this.config.minFreeMiB);
      }
      state.phase = 'restoring_llm'; await this.persist(state);
      for (const model of state.snapshot) {
        if (model.status === 'loaded') {
          const now = await this.adapters.llama.listModels();
          if (now.find(item => item.name === model.name)?.status !== 'loaded') await this.adapters.llama.load(model.name);
        }
      }
      state.state = finalState; state.phase = finalState; state.updatedAt = Date.now(); await this.persist(state);
    } catch (error) {
      state.state = 'recovery_required'; state.phase = 'recovery_required'; state.error = `Cleanup failed: ${message(error)}`;
      await this.persist(state);
    }
  }
  private async ensureComfyIdle(): Promise<void> {
    const q = await this.adapters.comfy.queue();
    if (q.running.length || q.pending.length) throw new Error('ComfyUI queue is not empty; refusing to modify GPU models');
  }
  private async cancelAndConfirm(id: string): Promise<void> {
    if (this.confirmedCancellations.has(id)) return;
    if (this.cancellation?.id === id) return this.cancellation.promise;
    const promise = (async () => {
      await this.adapters.comfy.cancel(id);
      await this.waitQueueAbsent(id);
      this.confirmedCancellations.add(id);
      if (this.current) { this.current.cancelledPromptId = id; await this.persist(this.current); }
    })();
    this.cancellation = { id, promise };
    try { await promise; } finally { if (this.cancellation?.promise === promise) this.cancellation = undefined; }
  }
  private async waitQueueAbsent(id: string): Promise<void> {
    const deadline = Date.now() + this.config.timeouts.settleMs;
    while (Date.now() < deadline) {
      const q = await this.adapters.comfy.queue();
      if (!q.running.includes(id) && !q.pending.includes(id)) return;
      await delay(Math.min(this.config.timeouts.pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`ComfyUI prompt ${id} remains queued after cancellation`);
  }
  private resolveTarget(models: ModelState[], requested?: string): ModelState | undefined {
    const name = requested || this.config.llamaModel;
    if (name) {
      const found = models.find(item => item.name === name);
      if (!found) throw new Error(`llama-server model not found: ${name}`);
      return found;
    }
    const loaded = models.filter(item => item.status === 'loaded');
    if (loaded.length === 1) return loaded[0];
    if (loaded.length > 1) throw new Error('Multiple llama-server models are loaded; specify modelId');
    if (models.length === 1) return models[0];
    if (models.length > 1) throw new Error('Multiple llama-server models are available; specify modelId');
    return undefined;
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('Another runner operation is active');
    this.active = true; try { return await fn(); } finally { this.active = false; }
  }
  private async readJournal(): Promise<Journal | undefined> {
    try {
      const value = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal;
      if (value.version !== 1 || !Array.isArray(value.snapshot) || !Array.isArray(value.workflows) || !Array.isArray(value.completed) ||
          typeof value.comfyuiUrl !== 'string' || typeof value.llamaServerUrl !== 'string' || typeof value.id !== 'string') {
        throw new Error('Invalid runner state; inspect the state file before recovery');
      }
      this.current = value; return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async persist(state: Journal): Promise<void> {
    state.updatedAt = Date.now(); this.current = state;
    const data = JSON.stringify(state);
    const write = this.writes.then(async () => {
      await mkdir(this.config.stateDir, { recursive: true });
      const tmp = `${this.journalPath}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, this.journalPath);
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
  private publicState(state: Journal): RunState { const { id, phase, state: status, model, promptId, completed, error, updatedAt } = state; return { id, phase, state: status, model, promptId, completed: structuredClone(completed), error, updatedAt }; }
}
class CancelRequested extends Error {}
function isAbort(error: unknown, signal?: AbortSignal): boolean { return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError'); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
