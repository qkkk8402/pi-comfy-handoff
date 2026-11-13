import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Runner } from '../src/runner.js';
import { OutcomeUnknown, type ComfyAdapter, type HostConfig, type LlamaAdapter, type ModelState, type QueueState, type Workflow } from '../src/types.js';

const workflow: Workflow = { '1': { class_type: 'EmptyLatentImage', inputs: { width: 512 } } };
class Llama implements LlamaAdapter {
  models: ModelState[] = [{ name: 'pi-model', status: 'loaded' }];
  calls: string[] = [];
  async listModels() { return structuredClone(this.models); }
  async unload(name: string) { this.calls.push(`unload:${name}`); this.models = this.models.map(m => m.name === name ? { ...m, status: 'unloaded' } : m); }
  async load(name: string) { this.calls.push(`load:${name}`); this.models = this.models.map(m => m.name === name ? { ...m, status: 'loaded' } : m); }
}
class Comfy implements ComfyAdapter {
  q: QueueState = { running: [], pending: [] };
  calls: string[] = [];
  unknown = false;
  unknownAfterCancel = false;
  waitStarted?: () => void;
  gate?: Promise<void>;
  async queue() { return structuredClone(this.q); }
  async submit(_wf: Workflow, id: string) { this.calls.push(`submit:${id}`); if (this.unknown) throw new OutcomeUnknown('response lost'); const prompt = `p-${id}`; this.q.running = [prompt]; return prompt; }
  async wait(promptId: string, _progress?: (value: unknown) => void, _signal?: AbortSignal) { this.calls.push(`wait:${promptId}`); this.waitStarted?.(); await this.gate; if (this.unknownAfterCancel) throw new OutcomeUnknown('cancelled prompt has no history'); this.q.running = []; return { promptId, outputs: [`${promptId}.png`] }; }
  async cancel(id: string) { this.calls.push(`cancel:${id}`); this.q = { running: [], pending: [] }; }
  async free() { this.calls.push('free'); }
  async waitForRelease() { this.calls.push('released'); }
}
async function setup(fn: (runner: Runner, llama: Llama, comfy: Comfy, config: HostConfig) => Promise<void>) {
  const stateDir = await mkdtemp(join(process.cwd(), 'work', 'runner-test-'));
  try {
    const config: HostConfig = { comfyuiUrl: 'http://127.0.0.1:8188', llamaServerUrl: 'http://127.0.0.1:8080', stateDir, timeouts: { requestMs: 100, modelMs: 100, generationMs: 100, settleMs: 100, pollMs: 1 } };
    const llama = new Llama(); const comfy = new Comfy(); await fn(new Runner(config, { llama, comfy }), llama, comfy, config);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('generation reports the llama model catalog stage when initial preflight fails', async () => {
  await setup(async (runner, llama) => {
    const cause = new Error('request failed code=ECONNRESET cause=socket closed');
    llama.listModels = async () => { throw cause; };
    await assert.rejects(runner.generate([workflow]), error => {
      assert.match((error as Error).message, /Generation preflight failed at llama model catalog/);
      assert.equal((error as Error & { cause?: unknown }).cause, cause);
      return true;
    });
  });
});

test('single and batch generation unloads once, frees ComfyUI, then restores the loaded model', async () => {
  await setup(async (runner, llama, comfy) => {
    const state = await runner.generate([workflow, workflow]);
    assert.equal(state.state, 'complete'); assert.equal(state.completed.length, 2);
    assert.deepEqual(llama.calls, ['unload:pi-model', 'load:pi-model']);
    assert.deepEqual(comfy.calls.filter(x => x === 'free' || x === 'released'), ['released', 'free', 'released']);
    assert.deepEqual((await runner.status()).state, 'complete');
  });
});

test('a release failure leaves the LLM unloaded until explicit recovery succeeds', async () => {
  await setup(async (runner, llama, comfy) => {
    let releases = 0;
    const release = comfy.waitForRelease.bind(comfy);
    comfy.waitForRelease = async () => {
      releases++;
      if (releases === 2) throw new OutcomeUnknown('memory state unavailable after ComfyUI release');
      await release();
    };
    const result = await runner.generate([workflow]);
    assert.equal(result.state, 'recovery_required');
    assert.equal(llama.models[0]!.status, 'unloaded');
    await assert.rejects(runner.connect(), /Unresolved/);
    comfy.waitForRelease = release;
    const recovered = await runner.recover();
    assert.equal(recovered.state, 'complete');
    assert.equal(llama.models[0]!.status, 'loaded');
    assert.equal(comfy.calls.filter(value => value.startsWith('submit:')).length, 1);
  });
});

test('partial unload failure restores the saved model and never submits generation', async () => {
  await setup(async (runner, llama, comfy) => {
    const unload = llama.unload.bind(llama);
    llama.unload = async name => { await unload(name); throw new Error('response lost after unloading'); };
    const result = await runner.generate([workflow]);
    assert.equal(result.state, 'failed');
    assert.equal(llama.models[0]!.status, 'loaded');
    assert.equal(comfy.calls.some(value => value.startsWith('submit:')), false);
  });
});

test('model restoration must finish before the run becomes terminal', async () => {
  await setup(async (runner, llama) => {
    let restoring!: () => void; const started = new Promise<void>(resolve => { restoring = resolve; });
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const load = llama.load.bind(llama);
    llama.load = async name => { restoring(); await gate; await load(name); };
    const running = runner.generate([workflow]);
    await started;
    assert.equal((await runner.status()).state, 'running');
    await assert.rejects(runner.connect(), /active/);
    finish();
    assert.equal((await running).state, 'complete');
  });
});

test('AbortSignal alone cancels an active prompt and performs cleanup without the aborted signal', async () => {
  await setup(async (runner, llama, comfy) => {
    let begun!: () => void; const started = new Promise<void>(resolve => { begun = resolve; });
    comfy.wait = async (_id, _progress, signal) => {
      begun();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      throw new OutcomeUnknown('wait interrupted');
    };
    const controller = new AbortController();
    const running = runner.generate([workflow], { signal: controller.signal });
    await started; controller.abort();
    assert.equal((await running).state, 'cancelled');
    assert.equal(comfy.calls.filter(value => value.startsWith('cancel:')).length, 1);
    assert.equal(llama.models[0]!.status, 'loaded');
    assert.ok(comfy.calls.includes('released'));
  });
});

test('unknown prompt status remains unresolved while queued and explicit empty-queue recovery does not resubmit', async () => {
  await setup(async (runner, llama, comfy) => {
    comfy.wait = async () => { throw new OutcomeUnknown('connection lost'); };
    const result = await runner.generate([workflow]);
    assert.equal(result.state, 'recovery_required');
    assert.equal(llama.models[0]!.status, 'unloaded');
    assert.equal((await runner.recover()).state, 'recovery_required');
    comfy.q.running = [];
    assert.equal((await runner.recover()).state, 'failed');
    assert.equal(llama.models[0]!.status, 'loaded');
    assert.equal(comfy.calls.filter(value => value.startsWith('submit:')).length, 1);
  });
});

test('failed recovery persists a retryable recovery_required state without loading or resubmitting', async () => {
  await setup(async (runner, llama, comfy) => {
    comfy.wait = async () => { throw new OutcomeUnknown('connection lost'); };
    const initial = await runner.generate([workflow]);
    assert.equal(initial.state, 'recovery_required');
    const submissions = comfy.calls.filter(value => value.startsWith('submit:')).length;
    const queue = comfy.queue.bind(comfy);
    comfy.queue = async () => { throw new Error('ComfyUI is unavailable'); };

    const failedRecovery = await runner.recover();
    assert.equal(failedRecovery.state, 'recovery_required');
    assert.equal(failedRecovery.phase, 'recovery_required');
    assert.match(failedRecovery.error ?? '', /Recovery failed: ComfyUI is unavailable/);
    assert.deepEqual(await runner.status(), failedRecovery);
    assert.equal(llama.models[0]!.status, 'unloaded');
    assert.equal(comfy.calls.filter(value => value.startsWith('submit:')).length, submissions);

    comfy.queue = queue;
    comfy.wait = async promptId => {
      comfy.q.running = [];
      return { promptId, outputs: [`${promptId}.png`] };
    };
    const retried = await runner.recover();
    assert.equal(retried.state, 'complete');
    assert.equal(llama.models[0]!.status, 'loaded');
    assert.equal(comfy.calls.filter(value => value.startsWith('submit:')).length, submissions);
  });
});

test('restarting a runner preserves unresolved state and rejects changed endpoints', async () => {
  await setup(async (runner, llama, comfy, config) => {
    comfy.unknown = true;
    await runner.generate([workflow]);
    const changed = new Runner({ ...config, comfyuiUrl: 'http://another-host:8188' }, { llama, comfy });
    await assert.rejects(changed.recover(), /endpoints differ/);
    await assert.rejects(changed.cancel(), /endpoints differ/);
    const restarted = new Runner(config, { llama, comfy });
    assert.equal((await restarted.status()).state, 'recovery_required');
    assert.equal((await restarted.recover()).state, 'failed');
    assert.equal(llama.models[0]!.status, 'loaded');
  });
});

test('ambiguous submission remains unresolved and is never retried or blindly freed', async () => {
  await setup(async (runner, _llama, comfy) => {
    comfy.unknown = true;
    const state = await runner.generate([workflow]);
    assert.equal(state.state, 'recovery_required');
    assert.equal(comfy.calls.filter(x => x.startsWith('submit:')).length, 1);
    assert.equal(comfy.calls.includes('free'), false);
    await assert.rejects(runner.generate([workflow]), /Unresolved run/);
    await assert.rejects(runner.connect(), /Unresolved run/);
    const recovered = await runner.recover();
    assert.equal(recovered.state, 'failed');
    assert.equal(comfy.calls.includes('free'), true);
  });
});

test('cancel confirmation is not repeated when wait reports missing history afterward', async () => {
  await setup(async (runner, _llama, comfy) => {
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let release!: () => void;
    comfy.gate = new Promise<void>(resolve => { release = resolve; });
    comfy.waitStarted = signalStarted;
    comfy.unknownAfterCancel = true;
    const controller = new AbortController();
    const run = runner.generate([workflow], { signal: controller.signal });
    await started;
    controller.abort();
    await runner.cancel();
    release();
    const state = await run;
    assert.equal(state.state, 'cancelled');
    assert.equal(comfy.calls.filter(call => call.startsWith('cancel:')).length, 1);
  });
});

test('ambiguous model selection is rejected without changing either service', async () => {
  await setup(async (runner, llama, comfy) => {
    llama.models.push({ name: 'other', status: 'loaded' });
    await assert.rejects(runner.generate([workflow]), /Multiple llama-server models/);
    await assert.rejects(runner.generate([workflow], { modelId: 'pi-model' }), /Other llama-server models are resident/);
    assert.deepEqual(llama.calls, []); assert.deepEqual(comfy.calls, []);
  });
});
