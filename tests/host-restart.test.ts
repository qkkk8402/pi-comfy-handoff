import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createManager } from '../src/manager.js';
import { parseManagerConfig } from '../src/manager-config.js';
import type { ComfyClient } from '../src/comfy.js';
import type { LlamaRouterClient } from '../src/llama.js';

// A process restart must never turn a persisted job into another submission.
test('host restart blocks inference and model changes until the persisted job is recovered', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'host-restart-'));
  const config = { ...parseManagerConfig({ stateDir: cwd, timeouts: { pollMs: 1 } }, cwd, {}), listenPort: 0 };
  let submitted = 0; let loaded = false; const operations: string[] = [];
  const workflow = { '1': { class_type: 'Fixture', inputs: {} } };
  await writeFile(join(cwd, 'runner-state.json'), JSON.stringify({
    version: 1, id: 'persisted-job', phase: 'generating', state: 'running', model: 'fixture', completed: [],
    updatedAt: Date.now(), comfyuiUrl: config.comfyuiUrl, llamaServerUrl: config.llamaServerUrl,
    snapshot: [{ name: 'fixture', status: 'loaded' }], workflows: [workflow], index: 0, promptId: 'existing-prompt',
  }));
  const manager = createManager(config, {
    comfy: {
      async queue() { return { running: [], pending: [] }; },
      async submit() { submitted++; return 'unexpected'; },
      async wait(promptId: string) { operations.push('wait'); return { promptId, outputs: [] }; },
      async free() { operations.push('free'); }, async cancel() {},
    } as unknown as ComfyClient,
    llama: {
      async listModels() { return [{ name: 'fixture', status: loaded ? 'loaded' : 'unloaded' }]; },
      async load() { loaded = true; operations.push('load'); }, async unload() { loaded = false; },
    } as unknown as LlamaRouterClient,
    vram: {
      async read() { return { source: 'amdgpu', device: 'fixture', totalMiB: 24000, usedMiB: 1000, freeMiB: 23000 }; },
      async waitForRelease() { operations.push('memory'); return { source: 'amdgpu', device: 'fixture', totalMiB: 24000, usedMiB: 1000, freeMiB: 23000 }; },
    },
    fetchImpl: async () => new Response(JSON.stringify({ models_autoload: false }), { status: 200 }),
  });
  try {
    await manager.start();
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await (await fetch(base + '/status')).json()).state, 'recovery_required');
    assert.equal((await post('/llama/v1/chat/completions', {})).status, 503);
    assert.equal((await post('/llama/models/load', { model: 'fixture' })).status, 409);
    assert.equal(loaded, false);
    assert.equal((await post('/cancel', { id: 'another-job' })).status, 409);
    assert.equal((await post('/recover', { id: 'another-job' })).status, 409);
    assert.equal((await post('/recover', { id: 'persisted-job' })).status, 202);
    let state;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(base + '/status')).json();
      if (state.state === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(state.state, 'complete');
    assert.equal(submitted, 0);
    assert.equal(loaded, true);
    assert.deepEqual(operations, ['wait', 'free', 'memory', 'load']);
    const stored = JSON.parse(await readFile(join(cwd, 'runner-state.json'), 'utf8'));
    assert.equal(stored.state, 'complete');
  } finally { await manager.close(); await rm(cwd, { recursive: true, force: true }); }
});
