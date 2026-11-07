import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createManager } from '../src/manager.js';
import { parseManagerConfig } from '../src/manager-config.js';
import type { ComfyAdapter, QueueState, Workflow } from '../src/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

test('manager gates new inference and drains a disconnected response before unloading the LLM', async () => {
  await mkdirWork();
  const cwd = resolve('work/manager-live');
  const events: string[] = [];
  const chatStarted = deferred(); const finishChat = deferred(); const unloadStarted = deferred();
  let model = 'loaded';
  const llamaServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/props') { res.end('{"models_autoload":false}'); return; }
    if (url.pathname === '/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-model', status: { value: model } }] })); return; }
    if (url.pathname === '/models/unload') { unloadStarted.resolve(); events.push('llm-unload'); model = 'unloaded'; res.end('{"success":true}'); return; }
    if (url.pathname === '/models/load') { events.push('llm-load'); model = 'loaded'; res.end('{"success":true}'); return; }
    if (url.pathname === '/v1/chat/completions') {
      for await (const _chunk of req) { /* accept the full inference request */ }
      events.push('inference-start'); chatStarted.resolve();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      await finishChat.promise;
      events.push('inference-end');
      res.end('data: [DONE]\n\n'); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  const llamaUrl = await listen(llamaServer);
  const comfyUrl = 'http://127.0.0.1:8188';
  const promptSubmitted = deferred();
  const fakeComfy = {
    async queue(): Promise<QueueState> { return { running: [], pending: [] }; },
    async submit(_workflow: Workflow, _job: string) { events.push('comfy-submit'); promptSubmitted.resolve(); return 'fixture-prompt'; },
    async wait() { return { promptId: 'fixture-prompt', outputs: [{ nodeId: '7', filename: 'image.png', subfolder: '', type: 'output', path: '/host/private.png', viewUrl: 'http://host.internal/view?filename=image.png' }] }; },
    async cancel() {}, async free() { events.push('comfy-free'); },
  } as unknown as ComfyAdapter;
  const waitForRelease = deferred();
  const logLines: string[] = [];
  const manager = createManager({
    ...parseManagerConfig({ comfyuiUrl: comfyUrl, llamaServerUrl: llamaUrl, stateDir: join(cwd, '.state'), logLevel: 'debug', timeouts: { requestMs: 2_000, modelMs: 2_000, generationMs: 0, settleMs: 100, pollMs: 5 } }),
    comfyApiKey: 'comfy-key-secret', llamaApiKey: 'llama-key-secret',
    listenPort: 0,
  }, {
    comfy: fakeComfy as any,
    logSink: line => logLines.push(line),
    vram: { async read() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 24560, usedMiB: 1024, freeMiB: 23536 }; }, async waitForRelease() { events.push('vram-stable'); waitForRelease.resolve(); return { source: 'amdgpu' as const, device: 'card1', totalMiB: 24560, usedMiB: 1024, freeMiB: 23536 }; } },
  });
  try {
    await manager.start();
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const abort = new AbortController();
    const inference = fetch(`${base}/llama/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }] }), signal: abort.signal,
    }).catch(error => error);
    await chatStarted.promise;
    const workflow: Workflow = { '7': { class_type: 'SaveImage', inputs: { images: ['1', 0], prompt: 'PRIVATE_PROMPT_SECRET' } } };
    const accepted = await fetch(`${base}/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'stable-job-id', modelId: 'fixture-model', workflows: [workflow] }),
    });
    assert.equal(accepted.status, 202);
    const acceptedState = await accepted.json() as { id: string; state: string };
    assert.equal(acceptedState.id, 'stable-job-id');
    assert.equal(acceptedState.state, 'running');
    assert.equal(events.includes('llm-unload'), false);
    const blocked = await fetch(`${base}/llama/v1/chat/completions`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(blocked.status, 503);

    abort.abort(); await inference;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(events.includes('llm-unload'), false, 'a client disconnect must not release the inference lease');
    finishChat.resolve();
    await unloadStarted.promise;
    await promptSubmitted.promise;
    await waitForRelease.promise;

    const duplicate = await fetch(`${base}/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'stable-job-id', modelId: 'fixture-model', workflows: [workflow] }),
    });
    assert.ok([200, 202].includes(duplicate.status));
    assert.equal(events.filter(value => value === 'comfy-submit').length, 1);
    let completed = false;
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${base}/status`)).json() as any;
      if (state.state === 'complete') {
        assert.deepEqual(Object.keys(state.completed[0].outputs[0]).sort(), ['filename', 'nodeId', 'subfolder', 'type']);
        assert.ok(events.indexOf('inference-end') < events.indexOf('llm-unload'));
        assert.ok(events.indexOf('vram-stable') < events.indexOf('comfy-submit'));
        assert.ok(events.indexOf('comfy-free') < events.lastIndexOf('vram-stable'));
        assert.ok(events.lastIndexOf('vram-stable') < events.indexOf('llm-load'));
        completed = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(completed, true, 'generation and LLM restoration should finish');
    assert.equal(model, 'loaded');
    const capturedLogs = logLines.join('\n');
    assert.ok(logLines.some(line => line.includes('generation accepted run=stable-job-id workflows=1')));
    assert.ok(logLines.some(line => line.includes('phase=generating')));
    assert.ok(!capturedLogs.includes('PRIVATE_PROMPT_SECRET'));
    assert.ok(!capturedLogs.includes('comfy-key-secret'));
    assert.ok(!capturedLogs.includes('llama-key-secret'));
  } finally {
    finishChat.resolve();
    await manager.close();
    await close(llamaServer);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('model operation errors retain diagnostics while redacting configured credentials', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-redaction-'));
  const secret = 'llama-key-secret';
  const upstream = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://upstream').pathname;
    res.setHeader('content-type', 'application/json');
    if (path === '/props') { res.end('{"models_autoload":false}'); return; }
    if (path === '/models') { res.end('{"data":[{"id":"fixture-model","status":{"value":"unloaded"}}]}'); return; }
    if (path === '/models/load') { res.statusCode = 500; res.end(JSON.stringify({ error: `load failed with credential ${secret}` })); return; }
    res.statusCode = 404; res.end('{}');
  });
  const llamaUrl = await listen(upstream);
  const manager = createManager({
    ...parseManagerConfig({ comfyuiUrl: 'http://127.0.0.1:8188', llamaServerUrl: llamaUrl, stateDir: cwd, timeouts: { requestMs: 2_000, modelMs: 2_000, generationMs: 0, settleMs: 100, pollMs: 5 } }),
    llamaApiKey: secret, listenPort: 0,
  }, {
    comfy: { async queue() { return { running: [], pending: [] }; }, async free() {} } as any,
    vram: { async read() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 1000, usedMiB: 100, freeMiB: 900 }; }, async waitForRelease() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 1000, usedMiB: 100, freeMiB: 900 }; } },
  });
  try {
    await manager.start();
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    for (const [path, body, status] of [['/llama/models/load', { model: 'fixture-model' }, 409], ['/connect', { modelId: 'fixture-model' }, 502]] as const) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, status);
      const message = (await response.json() as any).error.message as string;
      assert.match(message, /load failed with credential \[redacted\]/);
      assert.ok(!message.includes(secret));
    }
  } finally {
    await manager.close();
    await close(upstream);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a rejected preflight can be retried with the same job ID after loading the model', async () => {
  await mkdirWork();
  const cwd = resolve('work/manager-preflight');
  let model = 'unloaded';
  let submissions = 0;
  const llamaServer = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://upstream').pathname;
    res.setHeader('content-type', 'application/json');
    if (path === '/props') { res.end('{"models_autoload":false}'); return; }
    if (path === '/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-model', status: { value: model } }] })); return; }
    if (path === '/models/load') { model = 'loaded'; res.end('{"success":true}'); return; }
    if (path === '/models/unload') { model = 'unloaded'; res.end('{"success":true}'); return; }
    res.statusCode = 404; res.end('{}');
  });
  const llamaUrl = await listen(llamaServer);
  const fakeComfy = {
    async queue(): Promise<QueueState> { return { running: [], pending: [] }; },
    async submit() { submissions++; return 'fixture-prompt'; },
    async wait() { return { promptId: 'fixture-prompt', outputs: [] }; },
    async cancel() {}, async free() {},
  } as unknown as ComfyAdapter;
  const manager = createManager({
    ...parseManagerConfig({ comfyuiUrl: 'http://127.0.0.1:8188', llamaServerUrl: llamaUrl, stateDir: join(cwd, '.state'), timeouts: { requestMs: 2_000, modelMs: 2_000, generationMs: 0, settleMs: 100, pollMs: 5 } }),
    listenPort: 0,
  }, { comfy: fakeComfy as any, vram: {
    async read() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 24560, usedMiB: 1024, freeMiB: 23536 }; },
    async waitForRelease() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 24560, usedMiB: 1024, freeMiB: 23536 }; },
  } });
  try {
    await manager.start();
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const request = { id: 'retryable-job', modelId: 'fixture-model', workflows: [{ '1': { class_type: 'SaveImage', inputs: {} } }] };
    const failed = await fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(failed.status, 409, 'preflight failure is explicitly not accepted');
    assert.match((await failed.json() as any).error.message, /unloaded/);

    const loaded = await fetch(`${base}/llama/models/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model' }) });
    assert.equal(loaded.status, 200);
    const retried = await fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(retried.status, 202);
    assert.equal((await retried.json() as any).id, request.id);
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${base}/status`)).json() as any;
      if (state.state === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(submissions, 1);
    const status = await (await fetch(`${base}/status`)).json() as any;
    assert.equal(status.state, 'complete');
  } finally {
    await manager.close(); await close(llamaServer); await rm(cwd, { recursive: true, force: true });
  }
});

async function mkdirWork(): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir('work/manager-live', { recursive: true });
}
