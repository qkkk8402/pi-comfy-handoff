import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('manager permits tokenless non-loopback access and enforces configured bearer tokens', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-auth-'));
  const makeManager = (token?: string) => createManager({
    ...parseManagerConfig({ listenHost: '0.0.0.0', stateDir: cwd, logLevel: 'silent' }),
    listenPort: 0, token,
  }, {
    fetchImpl: async () => new Response('{"models_autoload":false}', { status: 200 }),
    comfy: {} as any,
    llama: {} as any,
    vram: {} as any,
  });
  const request = async (manager: ReturnType<typeof makeManager>, token?: string) => {
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    return fetch(`http://127.0.0.1:${address.port}/health`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  };
  const tokenless = makeManager();
  const secured = makeManager('0123456789abcdef');
  try {
    await tokenless.start();
    assert.equal((await request(tokenless)).status, 200);
    await tokenless.close();

    await secured.start();
    assert.equal((await request(secured)).status, 401);
    assert.equal((await request(secured, 'wrong-token-value')).status, 401);
    assert.equal((await request(secured, '0123456789abcdef')).status, 200);
  } finally {
    await tokenless.close();
    await secured.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('manager exposes only saved workflow JSON paths and forwards authenticated list/get/save requests', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-workflows-'));
  const forwarded: Array<{ url: string; method: string; auth: string | null; body?: string }> = [];
  const manager = createManager({
    ...parseManagerConfig({ comfyuiUrl: 'http://comfy.test:8188', stateDir: cwd, logLevel: 'silent' }),
    listenPort: 0, comfyApiKey: 'comfy-secret',
  }, {
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/props') return new Response('{"models_autoload":false}');
      const headers = new Headers(init.headers);
      let body: string | undefined;
      if (init.body) body = await new Response(init.body as BodyInit).text();
      forwarded.push({ url: url.toString(), method: init.method ?? 'GET', auth: headers.get('authorization'), body });
      if (init.method === 'POST' && url.pathname.endsWith(encodeURIComponent('workflows/sub folder/a.json')) && url.searchParams.get('overwrite') === 'false') {
        return new Response('{"error":{"message":"file already exists"}}', { status: 409, headers: { 'content-type': 'application/json' } });
      }
      return new Response(init.method === 'GET' ? '["sub folder/a.json","notes.txt"]' : '{"success":true}', { headers: { 'content-type': 'application/json' } });
    },
    comfy: {} as any, llama: {} as any, vram: {} as any,
  });
  try {
    await manager.start();
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const listing = await fetch(`${base}/workflows`);
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), ['sub folder/a.json', 'notes.txt']);
    const serverPath = 'workflows/sub folder/a.json';
    const get = await fetch(`${base}/workflows/${encodeURIComponent(serverPath)}`);
    assert.equal(get.status, 200);
    const conflict = await fetch(`${base}/workflows/${encodeURIComponent(serverPath)}?overwrite=false`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nodes":[]}',
    });
    assert.equal(conflict.status, 409);
    assert.match(await conflict.text(), /file already exists/);
    const overwrite = await fetch(`${base}/workflows/${encodeURIComponent(serverPath)}?overwrite=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nodes":[]}',
    });
    assert.equal(overwrite.status, 200);
    assert.equal(forwarded.length, 4);
    assert.equal(forwarded[0]!.url, 'http://comfy.test:8188/userdata?dir=workflows&recurse=true');
    assert.equal(forwarded[1]!.url, `http://comfy.test:8188/userdata/${encodeURIComponent(serverPath)}`);
    assert.equal(forwarded[2]!.url, `http://comfy.test:8188/userdata/${encodeURIComponent(serverPath)}?overwrite=false`);
    assert.equal(forwarded[3]!.url, `http://comfy.test:8188/userdata/${encodeURIComponent(serverPath)}?overwrite=true`);
    assert.ok(forwarded.every(item => item.auth === 'Bearer comfy-secret'));
    assert.equal(forwarded[2]!.body, '{"nodes":[]}');
    const traversal = await fetch(`${base}/workflows/${encodeURIComponent('workflows/../secret.json')}`);
    assert.equal(traversal.status, 400);
    const doubleEncoded = await fetch(`${base}/workflows/workflows%252f..%252fsecret.json`);
    assert.equal(doubleEncoded.status, 400);
    const invalidListing = await fetch(`${base}/workflows?dir=outputs`);
    assert.equal(invalidListing.status, 400);
    const invalidJson = await fetch(`${base}/workflows/${encodeURIComponent(serverPath)}?overwrite=false`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    });
    assert.equal(invalidJson.status, 400);
    const invalidOverwrite = await fetch(`${base}/workflows/${encodeURIComponent(serverPath)}?overwrite=yes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(invalidOverwrite.status, 400);
    assert.equal(forwarded.length, 4, 'invalid routes must not reach ComfyUI');
  } finally {
    await manager.close();
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
    const load = await fetch(`http://127.0.0.1:${address.port}/llama/models/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model' }) });
    assert.equal(load.status, 202);
    let failed: any;
    for (let i = 0; i < 100; i++) {
      failed = await (await fetch(`http://127.0.0.1:${address.port}/status`)).json() as any;
      if (failed.modelOperation?.state === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.match(failed.modelOperation.error, /load failed with credential \[redacted\]/);
    assert.ok(!failed.modelOperation.error.includes(secret));
    const catalog = await (await fetch(`http://127.0.0.1:${address.port}/llama/models`)).json() as any;
    assert.equal(catalog.data[0].status.value, 'unloaded');
    assert.equal(catalog.data[0].status.failed, true);
    assert.match(catalog.data[0].manager_error, /load failed with credential \[redacted\]/);
    const connect = await fetch(`http://127.0.0.1:${address.port}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'fixture-model' }) });
    assert.equal(connect.status, 502);
  } finally {
    await manager.close();
    await close(upstream);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a model preflight failure is terminal in the catalog and a retry clears it', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-model-retry-'));
  let queueBusy = true; let model = 'unloaded';
  const upstream = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://upstream').pathname;
    res.setHeader('content-type', 'application/json');
    if (path === '/props') { res.end('{"models_autoload":false}'); return; }
    if (path === '/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-model', status: { value: model, ...(model === 'unloaded' ? { failed: true, exit_code: 17 } : {}) } }] })); return; }
    if (path === '/models/load') { model = 'loaded'; res.end('{"success":true}'); return; }
    res.statusCode = 404; res.end('{}');
  });
  const llamaUrl = await listen(upstream);
  const manager = createManager({ ...parseManagerConfig({ comfyuiUrl: 'http://127.0.0.1:8188', llamaServerUrl: llamaUrl, stateDir: cwd, timeouts: { requestMs: 2_000, modelMs: 2_000, generationMs: 0, settleMs: 100, pollMs: 5 } }), listenPort: 0 }, {
    comfy: { async queue() { return { running: queueBusy ? [{ promptId: 'busy' }] : [], pending: [] }; }, async free() {} } as any,
    vram: { async read() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 1000, usedMiB: 100, freeMiB: 900 }; }, async waitForRelease() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 1000, usedMiB: 100, freeMiB: 900 }; } },
  });
  try {
    await manager.start();
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const startLoad = () => fetch(`${base}/llama/models/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model' }) });
    assert.equal((await startLoad()).status, 202);
    let failed: any;
    for (let i = 0; i < 100; i++) {
      failed = await (await fetch(`${base}/status`)).json() as any;
      if (failed.modelOperation?.state === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.match(failed.modelOperation.error, /ComfyUI queue is not empty/);
    const failedCatalog = await (await fetch(`${base}/llama/models`)).json() as any;
    assert.equal(failedCatalog.data[0].status.value, 'unloaded');
    assert.equal(failedCatalog.data[0].status.failed, true);
    assert.equal('exit_code' in failedCatalog.data[0].status, false);
    queueBusy = false;
    assert.equal((await startLoad()).status, 202);
    const retryCatalog = await (await fetch(`${base}/llama/models`)).json() as any;
    assert.equal(retryCatalog.data[0].status.value, 'loading');
    assert.equal(retryCatalog.data[0].status.failed, undefined);
    assert.equal(retryCatalog.data[0].status.exit_code, undefined);
    let completed = false;
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${base}/status`)).json() as any;
      if (state.modelOperation?.state === 'complete') { completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(completed, true, 'retry should complete after the upstream clears its failure state');
    assert.equal(model, 'loaded');
  } finally { await manager.close(); await close(upstream); await rm(cwd, { recursive: true, force: true }); }
});

test('model load returns acceptance before VRAM wait and retains the GPU gate until completion', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-async-model-'));
  const release = deferred(); const waiting = deferred();
  let model = 'unloaded';
  const upstream = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://upstream').pathname;
    res.setHeader('content-type', 'application/json');
    if (path === '/props') { res.end('{"models_autoload":false}'); return; }
    if (path === '/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-model', status: { value: model } }] })); return; }
    if (path === '/models/load') { model = 'loaded'; res.end('{"success":true}'); return; }
    res.statusCode = 404; res.end('{}');
  });
  const llamaUrl = await listen(upstream);
  const manager = createManager({
    ...parseManagerConfig({ comfyuiUrl: 'http://127.0.0.1:8188', llamaServerUrl: llamaUrl, stateDir: cwd, timeouts: { requestMs: 2_000, modelMs: 2_000, generationMs: 0, settleMs: 100, pollMs: 5 } }),
    listenPort: 0,
  }, {
    comfy: { async queue() { return { running: [], pending: [] }; }, async free() {} } as any,
    vram: { async read() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 1000, usedMiB: 500, freeMiB: 500 }; }, async waitForRelease() { waiting.resolve(); await release.promise; return { source: 'amdgpu' as const, device: 'card1', totalMiB: 1000, usedMiB: 100, freeMiB: 900 }; } },
  });
  try {
    await manager.start();
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/llama/models/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model' }) });
    assert.equal(response.status, 202);
    await waiting.promise;
    const catalog = await (await fetch(`${base}/llama/models`)).json() as any;
    assert.equal(catalog.data[0].status.value, 'loading');
    assert.equal(catalog.data[0].manager_operation.phase, 'waiting_for_vram');
    const status = await (await fetch(`${base}/status`)).json() as any;
    assert.equal(status.modelOperation.state, 'running');
    assert.equal(status.managerPhase, 'model');
    const competing = await fetch(`${base}/llama/models/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model' }) });
    assert.equal(competing.status, 409);
    const cancel = await fetch(`${base}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cancel.status, 409);
    release.resolve();
    for (let i = 0; i < 100 && model !== 'loaded'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(model, 'loaded');
    const complete = await (await fetch(`${base}/status`)).json() as any;
    assert.equal(complete.modelOperation.state, 'complete');
    assert.equal(complete.managerPhase, 'llm_ready');
  } finally {
    release.resolve(); await manager.close(); await close(upstream); await rm(cwd, { recursive: true, force: true });
  }
});

test('standalone cancellation holds the GPU gate until persisted-run cleanup finishes', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-cancel-gate-'));
  const cancelStarted = deferred(); const finishCancel = deferred();
  const upstream = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://upstream').pathname;
    res.setHeader('content-type', 'application/json');
    if (path === '/props') { res.end('{"models_autoload":false}'); return; }
    if (path === '/models') { res.end('{"data":[{"id":"fixture-model","status":{"value":"loaded"}}]}'); return; }
    res.statusCode = 404; res.end('{}');
  });
  const llamaUrl = await listen(upstream);
  await writeFile(join(cwd, 'runner-state.json'), JSON.stringify({
    version: 1, id: 'interrupted-run', phase: 'recovery_required', state: 'recovery_required', model: 'fixture-model',
    promptId: 'fixture-prompt', completed: [], updatedAt: Date.now(), comfyuiUrl: 'http://127.0.0.1:8188',
    llamaServerUrl: llamaUrl, snapshot: [{ name: 'fixture-model', status: 'loaded' }], workflows: [{}], index: 0,
  }));
  const manager = createManager({ ...parseManagerConfig({ comfyuiUrl: 'http://127.0.0.1:8188', llamaServerUrl: llamaUrl, stateDir: cwd, timeouts: { requestMs: 2_000, modelMs: 2_000, generationMs: 0, settleMs: 100, pollMs: 5 } }), listenPort: 0 }, {
    comfy: { async queue() { return { running: [], pending: [] }; }, async cancel() { cancelStarted.resolve(); await finishCancel.promise; }, async free() {} } as any,
    vram: { async read() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 1000, usedMiB: 100, freeMiB: 900 }; }, async waitForRelease() { return { source: 'amdgpu' as const, device: 'card1', totalMiB: 1000, usedMiB: 100, freeMiB: 900 }; } },
  });
  try {
    await manager.start();
    const address = manager.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const sse = await fetch(`${base}/llama/models/sse`);
    assert.equal(sse.status, 501);
    const cancel = await fetch(`${base}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cancel.status, 202);
    await cancelStarted.promise;
    const load = await fetch(`${base}/llama/models/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model' }) });
    assert.equal(load.status, 409, 'model operation must not begin during cancellation cleanup');
    finishCancel.resolve();
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${base}/status`)).json() as any;
      if (state.state === 'cancelled') { assert.equal(state.managerPhase, 'llm_ready'); return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('standalone cancellation should release its gate after cleanup');
  } finally { finishCancel.resolve(); await manager.close(); await close(upstream); await rm(cwd, { recursive: true, force: true }); }
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
    assert.equal(loaded.status, 202);
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${base}/status`)).json() as any;
      if (state.modelOperation?.state === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
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
