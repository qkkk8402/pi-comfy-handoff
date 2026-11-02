import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { loadConfig, matchingLlamaUrl, saveManagerUrl } from './config.js';
import { ComfyClient } from './comfy.js';
import { ManagerClient, ManagerHttpError, type RunState } from './manager-client.js';
import { projectFile, readProjectJson, writeProjectJson } from './files.js';
import { applyWorkflowPatch, summarizeApiWorkflow, validateApiWorkflow, type WorkflowPatch } from './workflow.js';
import type { Workflow } from './types.js';

const text = (value: unknown): { content: [{ type: 'text'; text: string }]; details: unknown; terminate?: boolean } => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], details: value });
const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
interface LocalRun { version: 1; id: string; startedAt: number; downloaded: Record<string, string> }
interface Runtime { manager: ManagerClient; comfy: ComfyClient }
type AuthContext = { modelRegistry?: { getProviderAuth?: (provider: string) => Promise<{ auth?: { apiKey?: string; baseUrl?: string }; env?: Record<string, string> } | undefined> } };

export default function extension(pi: ExtensionAPI): void {
  const runtimes = new Map<string, Runtime>();
  const runtime = (cwd: string) => {
    let value = runtimes.get(cwd);
    if (!value) {
      const config = loadConfig(cwd);
      value = {
        manager: new ManagerClient(config),
        comfy: new ComfyClient(`${config.managerUrl}/comfy`, { outputDir: config.outputDir, apiKey: config.apiKey, requestMs: config.timeouts.requestMs, generationMs: 0 }),
      };
      runtimes.set(cwd, value);
    }
    return value;
  };

  const refreshAuth = async (ctx: AuthContext, cwd: string, client = runtime(cwd)) => {
    const fallback = loadConfig(cwd).apiKey;
    let apiKey = fallback;
    try {
      const auth = await ctx.modelRegistry?.getProviderAuth?.('llama.cpp');
      const key = auth?.auth?.apiKey;
      if (key && key !== 'local') {
        const llamaUrl = auth?.env?.LLAMA_BASE_URL;
        const matches = llamaUrl !== undefined
          ? matchingLlamaUrl(client.manager.baseUrl, llamaUrl)
          : matchingLlamaUrl(client.manager.baseUrl, auth?.auth?.baseUrl, true);
        if (matches) apiKey = key;
      }
    } catch { /* Keep using the explicitly configured manager token. */ }
    client.manager.setApiKey(apiKey);
    client.comfy.setApiKey(apiKey);
    return client;
  };

  pi.registerTool({
    name: 'comfy_upload', label: 'Upload ComfyUI input', executionMode: 'sequential',
    description: 'Upload a project-local input file through the VRAM manager. Use the returned name and subfolder in workflow inputs.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      const client = await refreshAuth(ctx, ctx.cwd);
      return text(await client.comfy.uploadInput(await projectFile(ctx.cwd, args.path)));
    },
  });
  pi.registerTool({
    name: 'comfy_inspect', label: 'Inspect ComfyUI',
    description: 'List available ComfyUI node classes, or inspect one class and its inputs/model choices.',
    parameters: Type.Object({ nodeClass: Type.Optional(Type.String()) }),
    async execute(_id, args, _signal, _update, ctx) {
      const info = await (await refreshAuth(ctx, ctx.cwd)).comfy.objectInfo();
      if (args.nodeClass) {
        if (!Object.hasOwn(info, args.nodeClass)) throw new Error(`Unknown node class: ${args.nodeClass}`);
        return text(info[args.nodeClass]);
      }
      return text({ classes: Object.keys(info).sort(), hint: 'Pass nodeClass to inspect inputs, outputs and model choices.' });
    },
  });
  pi.registerTool({
    name: 'comfy_workflow', label: 'Edit ComfyUI workflow', executionMode: 'sequential',
    description: 'Inspect, create, or patch a project-local API-format workflow JSON. Patch operations: setInput(nodeId,input,value), addNode(nodeId,node), removeNode(nodeId,disconnect?), connect(sourceNodeId,outputIndex,targetNodeId,input), disconnect(targetNodeId,input).',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('inspect'), Type.Literal('create'), Type.Literal('patch')]),
      path: Type.String(), workflow: Type.Optional(Type.Unknown()), patches: Type.Optional(Type.Array(Type.Unknown())),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (args.action === 'inspect') return text(summarizeApiWorkflow(await readProjectJson(ctx.cwd, args.path)));
      let workflow: unknown = args.workflow;
      if (args.action === 'patch') {
        if (!args.patches?.length) throw new Error('patches is required for patch');
        workflow = applyWorkflowPatch(await readProjectJson(ctx.cwd, args.path), args.patches as WorkflowPatch[]);
      }
      const check = validateApiWorkflow(workflow);
      if (!check.valid) throw new Error(JSON.stringify(check.errors));
      const path = await writeProjectJson(ctx.cwd, args.path, workflow);
      return text({ path, summary: summarizeApiWorkflow(workflow), validation: 'Structure checked; use comfy_validate to check live node definitions before generating.' });
    },
  });
  pi.registerTool({
    name: 'comfy_validate', label: 'Validate ComfyUI workflow',
    description: 'Validate an API-format workflow against live ComfyUI node definitions and model choices.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      return text(validateApiWorkflow(await readProjectJson(ctx.cwd, args.path), await (await refreshAuth(ctx, ctx.cwd)).comfy.objectInfo()));
    },
  });
  pi.registerTool({
    name: 'comfy_generate', label: 'Generate with ComfyUI', executionMode: 'sequential',
    description: 'Submit one or more prepared API workflows through the VRAM manager. Waits for completion, downloads output to the project, and never cancels a host job when Pi waiting is interrupted. Resume with /comfy resume.',
    promptGuidelines: ['Inspect node definitions and validate the workflow first.', 'Use exact installed model filenames and prepare inputs before generation.', 'Do not call ComfyUI or llama-server endpoints directly.'],
    parameters: Type.Object({ path: Type.Optional(Type.String()), paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 32 })) }),
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      const { manager, comfy } = await refreshAuth(ctx, ctx.cwd);
      if (Boolean(args.path) === Boolean(args.paths)) throw new Error('Specify exactly one of path or paths');
      const local = await manager.readLocalRun<LocalRun>();
      if (local) throw new Error(`A previous run ${local.id} needs /comfy resume or /comfy recover before generating`);
      const paths = args.paths ?? [args.path!];
      const info = await comfy.objectInfo();
      const workflows: Workflow[] = [];
      for (const path of paths) {
        const workflow = await readProjectJson(ctx.cwd, path);
        const checked = validateApiWorkflow(workflow, info);
        if (!checked.valid) throw new Error(`${path}: ${JSON.stringify(checked.errors)}`);
        workflows.push(workflow as Workflow);
      }
      const id = createHash('sha256').update(`${ctx.cwd}\0${toolCallId}`).digest('hex');
      const record: LocalRun = { version: 1, id, startedAt: Date.now(), downloaded: {} };
      const before = await manager.status();
      if (busy(before)) throw new Error(`VRAM manager run ${before.id ?? ''} must finish before a new generation`);
      if (signal?.aborted) return { ...text({ state: 'cancelled', message: 'Generation was cancelled before submission.' }), terminate: true };
      await manager.saveLocalRun(record);
      onUpdate?.(text({ id, state: 'starting', message: 'VRAM managerへ生成を依頼しました。完了までPiは待機します。' }));
      try {
        let accepted: RunState;
        let attempted = false;
        while (true) {
          if (signal?.aborted) {
            if (attempted) return interrupted(ctx, { id, state: 'running', phase: 'submitting', completed: [] });
            await manager.clearLocalRun();
            return { ...text({ id, state: 'cancelled', message: 'Generation was cancelled before submission.' }), terminate: true };
          }
          try {
            attempted = true;
            accepted = await manager.generate({ id, modelId: ctx.model?.id, workflows }, signal);
            break;
          } catch (error) {
            if (signal?.aborted) return interrupted(ctx, { id, state: 'running', phase: 'submitting', completed: [] });
            if (!retryable(error)) {
              if (definitelyRejected(error)) await manager.clearLocalRun();
              throw error;
            }
            await delay(manager.config.timeouts.pollMs, signal);
          }
        }
        if (accepted.id && accepted.id !== id) throw new Error('VRAM manager accepted a different run ID');
        return await waitForRun(manager, comfy, record, accepted, signal, ctx);
      } catch (error) {
        if (signal?.aborted) return interrupted(ctx, { id, state: 'running', phase: 'waiting', completed: [] });
        if (definitelyRejected(error)) {
          ctx.abort();
          return { ...text({ id, state: 'failed', error: errorMessage(error) }), terminate: true };
        }
        ctx.abort();
        return { ...text({ id, state: 'recovery_required', error: errorMessage(error), message: 'State is uncertain. Use /comfy resume or recover.' }), terminate: true };
      }
    },
  });

  pi.registerCommand('comfy', {
    description: 'VRAM manager: status | cancel | recover | resume | connect [MODEL_ID] | setup | reset',
    async handler(args, ctx) {
      try {
        const [command = 'status', id] = args.trim().split(/\s+/);
        if (command === 'setup' || command === 'reset') {
          if (!ctx.hasUI) throw new Error('Interactive setup requires Pi UI mode');
          const initial = runtime(ctx.cwd);
          await refreshAuth(ctx, ctx.cwd, initial);
          await ensureSetupAllowed(ctx, initial);
          const config = loadConfig(ctx.cwd);
          const defaultUrl = 'http://127.0.0.1:8090';
          const value = command === 'reset'
            ? await ctx.ui.input(`VRAM manager URL (Enter resets to ${defaultUrl})`, '')
            : await ctx.ui.input(`VRAM manager URL (Enter: ${config.managerUrl})`, config.managerUrl);
          if (value === undefined) return;
          await ensureSetupAllowed(ctx, initial);
          await saveManagerUrl(ctx.cwd, value.trim() || (command === 'reset' ? defaultUrl : config.managerUrl));
          runtimes.delete(ctx.cwd);
          ctx.ui.notify('VRAM manager接続先を保存しました。llama.cppのログインURLも変更する場合は /login llama.cpp を実行してください。', 'info');
          return;
        }
        const { manager } = await refreshAuth(ctx, ctx.cwd);
        let result: unknown;
        if (command === 'status') result = await manager.status();
        else if (command === 'cancel') result = await manager.cancel(id);
        else if (command === 'recover') {
          result = await manager.recover(id);
          const local = await manager.readLocalRun<LocalRun>();
          if (local && (!id || id === local.id)) {
            const current = await manager.status();
            const terminal = TERMINAL.has(current.state) || current.state === 'idle';
            if (terminal && current.id !== local.id) {
              await manager.clearLocalRun();
              result = { result, localRun: 'cleared', message: '保存されたPi待機記録だけを削除しました。生成は再送していません。' };
            }
          }
        }
        else if (command === 'resume') {
          const local = await manager.readLocalRun<LocalRun>();
          const current = await manager.status();
          if (!local && !busy(current)) { result = current; }
          else {
            const saved: LocalRun = local ?? { version: 1, id: current.id ?? '', startedAt: Date.now(), downloaded: {} };
            if (!saved.id) throw new Error('VRAM manager has no resumable run');
            if (!local) await manager.saveLocalRun(saved);
            if (current.id !== saved.id) throw new Error(`VRAM manager does not have saved run ${saved.id}; it will not be resubmitted`);
            result = await waitForRun(manager, runtime(ctx.cwd).comfy, saved, current, ctx.signal, ctx);
          }
        }
        else if (command === 'connect') result = await manager.connect(id ?? ctx.model?.id);
        else throw new Error('Usage: /comfy status | cancel | recover | resume | connect [MODEL_ID] | setup | reset');
        ctx.ui.notify(JSON.stringify(result, null, 2), 'info');
      } catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
    },
  });

  pi.on('input', async (_event, ctx) => {
    const manager = (await refreshAuth(ctx, ctx.cwd)).manager;
    const local = await manager.readLocalRun<LocalRun>();
    let state: RunState;
    try { state = await manager.status(); }
    catch { if (local) { ctx.ui.notify('生成状態を確認できません。/comfy resumeで待機を再開してください。', 'warning'); return { action: 'handled' as const }; } return { action: 'continue' as const }; }
    if (local || busy(state)) {
      ctx.ui.notify('ComfyUI処理が実行中か復旧待ちです。/comfy status、resume、recoverのいずれかを使用してください。', 'warning');
      return { action: 'handled' as const };
    }
    return { action: 'continue' as const };
  });

  async function ensureSetupAllowed(ctx: { cwd: string; isIdle(): boolean }, initial: Runtime): Promise<void> {
    if (!ctx.isIdle()) throw new Error('Cannot change the manager URL while Pi is running a turn or tool');
    if (runtimes.get(ctx.cwd) !== initial) throw new Error('Runtime changed during setup; run /comfy setup again');
    const { manager } = initial;
    const local = await manager.readLocalRun<LocalRun>();
    if (local) throw new Error('A saved run exists; resume or recover it before changing the manager URL');
    try { if (busy(await manager.status())) throw new Error('Cannot change the manager URL during an active or unresolved run'); }
    catch (error) { if (error instanceof Error && error.message.includes('Cannot change')) throw error; }
  }
}

async function waitForRun(
  manager: ManagerClient, comfy: ComfyClient, local: LocalRun, initial: RunState, signal: AbortSignal | undefined,
  ctx: { abort(): void; hasUI?: boolean; ui?: { setStatus?: (key: string, value: string | undefined) => void } },
): Promise<ReturnType<typeof text>> {
  try { return await waitForRunImpl(manager, comfy, local, initial, signal, ctx); }
  finally { if (ctx.hasUI) ctx.ui?.setStatus?.('comfy', undefined); }
}

async function waitForRunImpl(
  manager: ManagerClient, comfy: ComfyClient, local: LocalRun, initial: RunState, signal: AbortSignal | undefined,
  ctx: { abort(): void; hasUI?: boolean; ui?: { setStatus?: (key: string, value: string | undefined) => void } },
): Promise<ReturnType<typeof text>> {
  let state = initial;
  let retry = manager.config.timeouts.pollMs;
  const started = local.startedAt;
  while (!TERMINAL.has(state.state)) {
    if (state.state === 'recovery_required') {
      ctx.abort();
      return { ...text(state), terminate: true };
    }
    if (signal?.aborted) return interrupted(ctx, state);
    updateWaitStatus(ctx, state, started);
    await delay(manager.config.timeouts.pollMs, signal);
    if (signal?.aborted) return interrupted(ctx, state);
    try {
      state = await manager.status();
      if (state.id !== local.id) throw new Error(`VRAM manager is tracking a different run (${state.id || 'idle'})`);
      retry = manager.config.timeouts.pollMs;
    } catch (error) {
      if (!retryable(error)) {
        ctx.abort();
        return { ...text({ id: local.id, state: 'recovery_required', error: errorMessage(error) }), terminate: true };
      }
      updateWaitStatus(ctx, { id: local.id, state: 'running', phase: 'manager_unavailable' }, started);
      await delay(retry, signal);
      retry = Math.min(15_000, Math.max(retry * 2, manager.config.timeouts.pollMs));
    }
  }

  const completed: Array<{ promptId: string; outputs: Array<Record<string, unknown>> }> = [];
  try {
    for (const result of state.completed ?? []) {
      const outputs: Array<Record<string, unknown>> = [];
      for (const [index, ref] of result.outputs.entries()) {
        const key = `${result.promptId}:${index}`;
        let path = local.downloaded[key];
        if (!path) {
          const downloaded = await comfy.downloadOutput(result.promptId, ref, index, signal);
          if (!downloaded.path) throw new Error('Output directory is not configured');
          path = downloaded.path;
        }
        local.downloaded[key] = path;
        await manager.saveLocalRun(local);
        outputs.push({ ...ref, path });
      }
      completed.push({ promptId: result.promptId, outputs });
    }
    await manager.clearLocalRun();
    return text({ ...state, completed });
  } catch (error) {
    if (signal?.aborted) return interrupted(ctx, state);
    updateWaitStatus(ctx, { ...state, phase: 'download_retry' }, started);
    ctx.abort();
    return { ...text({ ...state, state: 'recovery_required', error: errorMessage(error) }), terminate: true };
  }
}

function interrupted(ctx: { abort(): void; hasUI?: boolean; ui?: { setStatus?: (key: string, value: string | undefined) => void } }, state: RunState): ReturnType<typeof text> {
  ctx.abort();
  return { ...text({ ...state, state: 'recovery_required', phase: 'waiting_on_host', message: 'Piの待機を中断しました。ホスト生成は継続中です。/comfy resumeで再開できます。' }), terminate: true };
}
function updateWaitStatus(ctx: { hasUI?: boolean; ui?: { setStatus?: (key: string, text: string | undefined) => void } }, state: RunState, started: number): void {
  if (!ctx.hasUI) return;
  const elapsed = Math.floor((Date.now() - started) / 60_000);
  const phase = state.phase ? ` · ${state.phase}` : '';
  ctx.ui?.setStatus?.('comfy', `生成待機 ${elapsed}分${phase}`);
}
function busy(state: RunState): boolean { return state.state === 'running' || state.state === 'recovery_required'; }
function retryable(error: unknown): boolean {
  return error instanceof ManagerHttpError ? error.status === 429 || error.status >= 500
    : error instanceof TypeError || (error instanceof Error && error.name === 'AbortError');
}
function definitelyRejected(error: unknown): boolean { return error instanceof ManagerHttpError && error.status >= 400 && error.status < 500 && error.status !== 429; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Aborted')); return; }
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Aborted')); };
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
