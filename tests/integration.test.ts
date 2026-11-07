import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import extension from '../src/extension.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
async function jsonBody(request: AsyncIterable<Buffer | string>) {
  let body = ''; for await (const chunk of request) body += chunk.toString(); return JSON.parse(body);
}
function register() {
  const tools = new Map<string, any>(); const commands = new Map<string, any>(); const events = new Map<string, any>();
  extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => events.set(name, handler) } as unknown as ExtensionAPI);
  return { tools, commands, events };
}

test('Pi uploads, validates, submits once, waits beyond one request timeout and downloads through the manager', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-integration-'));
  const image = Buffer.from('generated fixture');
  let run: any = { state: 'idle', phase: 'idle' };
  let polls = 0; let submits = 0; let inferenceBypass = 0;
  const calls: string[] = [];
  const server = createServer((req, res) => { void (async () => {
    if (req.url === '/status') {
      calls.push('status'); polls++;
      if (run.state === 'running' && polls > 60) run = { ...run, state: 'complete', phase: 'complete', completed: [{ promptId: 'fixture-prompt', outputs: [
        { nodeId: '7', filename: 'image.png', subfolder: '', type: 'output' },
      ] }] };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(run)); return;
    }
    if (req.url === '/generate' && req.method === 'POST') {
      const body = await jsonBody(req); submits++;
      if (submits === 1) {
        assert.equal(body.modelId, 'fixture-model');
        assert.deepEqual(body.workflows, [{ '1': { class_type: 'Fixture', inputs: { prompt: 'test' } } }]);
        run = { id: body.id, state: 'running', phase: 'generating', completed: [] };
        polls = 0;
      } else {
        assert.fail('Resuming a manager job must not POST /generate again');
      }
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify(run)); return;
    }
    if (req.url === '/comfy/object_info') {
      calls.push('object_info'); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Fixture: { input: { required: { prompt: ['STRING', {}] } }, output: ['IMAGE'], output_node: true } })); return;
    }
    if (req.url === '/comfy/upload/image') {
      let body = ''; for await (const chunk of req) body += chunk.toString();
      assert.match(body, /input-pixels/); calls.push('upload'); res.setHeader('content-type', 'application/json');
      res.end('{"name":"input.png","subfolder":"","type":"input"}'); return;
    }
    if (req.url?.startsWith('/comfy/view?')) { calls.push('download'); res.end(image); return; }
    if (req.url === '/cancel' || req.url === '/recover' || req.url === '/connect') {
      calls.push(req.url); const result = await jsonBody(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...run, ...result })); return;
    }
    if (req.url === '/v1/chat/completions') { inferenceBypass++; res.statusCode = 500; res.end('{}'); return; }
    res.statusCode = 404; res.end('{}');
  })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }); });
  try {
    const managerUrl = await listen(server);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ managerUrl, outputDir: 'outputs', timeouts: { requestMs: 100, pollMs: 5 } }));
    await writeFile(join(cwd, 'input.png'), 'input-pixels');
    const { tools, commands, events } = register();
    const statuses = new Map<string, string>();
    const ctx = { cwd, hasUI: true, model: { id: 'fixture-model' }, abort() {}, ui: { async select() { return 'LLMを接続（現在のモデル）'; }, notify() {}, setStatus(key: string, value?: string) { if (value) statuses.set(key, value); else statuses.delete(key); } } };
    await commands.get('comfy').handler('', ctx);
    assert.ok(calls.includes('/connect'));
    const execute = (name: string, args: unknown, signal?: AbortSignal) => tools.get(name).execute(`call-${name}`, args, signal, undefined, ctx);
    await execute('comfy_upload', { path: 'input.png' });
    await execute('comfy_workflow', { action: 'create', path: 'workflow.json', workflow: { '1': { class_type: 'Fixture', inputs: { prompt: 'test' } } } });
    assert.equal((await execute('comfy_validate', { path: 'workflow.json' })).details.valid, true);
    const result = await execute('comfy_generate', { path: 'workflow.json' });
    assert.equal(result.details.state, 'complete');
    assert.equal(submits, 1);
    assert.equal(inferenceBypass, 0);
    assert.equal(statuses.size, 0, 'wait status must clear when the run finishes');
    const output = result.details.completed[0].outputs[0].path;
    assert.deepEqual(await readFile(output), image);
    assert.ok((await stat(output)).size > 0);
    assert.ok(polls > 60, 'the wait must exceed the per-request timeout without an overall deadline');
    assert.deepEqual(await managerLocal(cwd), undefined);
    assert.ok(events.has('input'));
    assert.ok(calls.includes('download'));
  } finally { await close(server); await rm(cwd, { recursive: true, force: true }); }
});

test('/comfy connection menu changes one manager URL, keeps other settings, and applies it immediately', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-setup-'));
  const calls: string[] = [];
  const mock = (label: string) => createServer((req, res) => {
    calls.push(`${label}:${req.url}`); res.setHeader('content-type', 'application/json');
    if (req.url === '/status') res.end('{"state":"idle","phase":"idle"}');
    else if (req.url === '/comfy/object_info') res.end('{"Fixture":{}}');
    else if (req.url === '/connect') res.end('{"ready":true}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  const oldServer = mock('old'); const newServer = mock('new');
  try {
    const [oldUrl, newUrl] = await Promise.all([listen(oldServer), listen(newServer)]);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    const config = join(cwd, '.pi/comfyui.json');
    await writeFile(config, JSON.stringify({ managerUrl: oldUrl, outputDir: 'renders', apiKeyEnv: 'CUSTOM', timeouts: { pollMs: 5 } }));
    const { commands, tools } = register();
    const answers: Array<string | undefined> = [newUrl];
    const ctx = { cwd, hasUI: true, isIdle: () => true, model: undefined,
      ui: { async select(_prompt: string, options: string[]) { return options.includes('接続設定') ? '接続設定' : '接続先を変更'; }, input: async () => answers.shift(), notify() {}, setStatus() {} } };
    await tools.get('comfy_inspect').execute('old', {}, undefined, undefined, ctx);
    await commands.get('comfy').handler('', ctx);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { managerUrl: newUrl, outputDir: 'renders', apiKeyEnv: 'CUSTOM', timeouts: { pollMs: 5 } });
    await tools.get('comfy_inspect').execute('new', {}, undefined, undefined, ctx);
    assert.ok(calls.includes('old:/comfy/object_info'));
    assert.ok(calls.includes('new:/comfy/object_info'));
  } finally { await Promise.all([oldServer, newServer].map(close)); await rm(cwd, { recursive: true, force: true }); }
});

test('/comfy connection menu replaces an unreachable manager URL and keeps project settings', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-reset-'));
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url ?? ''); res.setHeader('content-type', 'application/json');
    if (req.url === '/comfy/object_info') res.end('{"Fixture":{}}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  try {
    const newUrl = await listen(server);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    const config = join(cwd, '.pi/comfyui.json');
    await writeFile(config, JSON.stringify({ managerUrl: 'http://127.0.0.1:1', outputDir: 'renders', stateDir: '.saved-state' }));
    const { commands, tools } = register();
    const answers: Array<string | undefined> = [newUrl];
    const ctx = { cwd, hasUI: true, isIdle: () => true, model: undefined,
      ui: { async select(_prompt: string, options: string[]) { return options.includes('接続設定') ? '接続設定' : '接続先を変更'; }, input: async () => answers.shift(), notify() {}, setStatus() {} } };

    await commands.get('comfy').handler('', ctx);

    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { managerUrl: newUrl, outputDir: 'renders', stateDir: '.saved-state' });
    await tools.get('comfy_inspect').execute('new', {}, undefined, undefined, ctx);
    assert.deepEqual(calls, ['/comfy/object_info']);
  } finally { await close(server); await rm(cwd, { recursive: true, force: true }); }
});

test('/comfy connection menu restores the default URL and Esc leaves it unchanged', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-reset-default-'));
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    const config = join(cwd, '.pi/comfyui.json');
    const original = { managerUrl: 'https://old.example.test/manager', outputDir: 'renders' };
    await writeFile(config, JSON.stringify(original));
    const { commands } = register();
    const answers: Array<string | undefined> = ['', undefined];
    let resetMenu = true;
    const ctx = { cwd, hasUI: true, isIdle: () => true, model: undefined,
      ui: { async select(_prompt: string, options: string[]) { if (options.includes('接続設定')) return '接続設定'; if (options.includes('接続先を初期値に戻す')) return resetMenu ? '接続先を初期値に戻す' : '接続先を変更'; return '戻る'; }, input: async () => answers.shift(), notify() {}, setStatus() {} } };

    await commands.get('comfy').handler('', ctx);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).managerUrl, 'http://127.0.0.1:8090');
    await writeFile(config, JSON.stringify(original));
    resetMenu = false;
    await commands.get('comfy').handler('', ctx);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('/comfy connection menu preserves settings while a saved generation needs recovery', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-reset-active-'));
  try {
    await mkdir(join(cwd, '.pi/comfy-state'), { recursive: true });
    const config = join(cwd, '.pi/comfyui.json');
    const original = { managerUrl: 'http://127.0.0.1:1', outputDir: 'renders' };
    await writeFile(config, JSON.stringify(original));
    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify({ id: 'unfinished' }));
    const { commands } = register();
    let prompted = false;
    const ctx = { cwd, hasUI: true, isIdle: () => true, model: undefined,
      ui: { async select(_prompt: string, options: string[]) { if (options.includes('接続設定')) return '接続設定'; return '接続先を変更'; }, input: async () => { prompted = true; return 'http://new.example.test'; }, notify() {}, setStatus() {} } };

    await commands.get('comfy').handler('', ctx);

    assert.equal(prompted, false);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Comfy and manager auth follows matching llama.cpp login, refreshes logout, and never leaks to a different URL', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-auth-'));
  const envName = 'PI_COMFY_AUTH_INTEGRATION_TOKEN';
  const previousEnv = process.env[envName];
  delete process.env[envName];
  let expectedToken = '';
  const seen: Array<{ path: string; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    const authorization = req.headers.authorization;
    seen.push({ path: req.url ?? '', authorization });
    if (!authorization || authorization !== `Bearer ${expectedToken}`) {
      res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end('{"error":"Bearer token required"}'); return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/status') res.end('{"state":"idle","phase":"idle"}');
    else if (req.url === '/comfy/object_info') res.end('{"Fixture":{}}');
    else if (req.url === '/comfy/upload/image') res.end('{"name":"input.png","subfolder":"","type":"input"}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  let auth: any;
  try {
    const managerUrl = await listen(server);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ managerUrl, apiKeyEnv: envName }));
    await writeFile(join(cwd, 'input.png'), 'input-pixels');
    const { tools, commands } = register();
    const notifications: string[] = [];
    const ctx = {
      cwd, hasUI: true, isIdle: () => true, model: undefined, abort() {}, signal: undefined,
      modelRegistry: { async getProviderAuth(provider: string) { assert.equal(provider, 'llama.cpp'); return auth; } },
      ui: { notify(message: string) { notifications.push(message); }, async input() { return undefined; }, setStatus() {} },
    };
    const inspect = () => tools.get('comfy_inspect').execute('auth-inspect', {}, undefined, undefined, ctx);
    const lastRequest = () => seen.at(-1)!;

    // The provider-scoped URL takes precedence over auth.baseUrl.
    expectedToken = 'login-one';
    auth = { auth: { apiKey: 'login-one', baseUrl: 'http://elsewhere.invalid/llama/v1' }, env: { LLAMA_BASE_URL: `${managerUrl}/llama` } };
    await inspect();
    assert.equal(lastRequest().authorization, 'Bearer login-one');
    await commands.get('comfy').handler('status', ctx);
    assert.equal(lastRequest().path, '/status');
    assert.equal(lastRequest().authorization, 'Bearer login-one');
    await tools.get('comfy_upload').execute('auth-upload', { path: 'input.png' }, undefined, undefined, ctx);
    assert.equal(lastRequest().path, '/comfy/upload/image');
    assert.equal(lastRequest().authorization, 'Bearer login-one');

    // A new Pi login key is picked up by the next operation.
    expectedToken = 'login-two';
    auth = { auth: { apiKey: 'login-two' }, env: { LLAMA_BASE_URL: `${managerUrl}/llama` } };
    await inspect();
    assert.equal(lastRequest().authorization, 'Bearer login-two');

    // With no login auth, the previous key is cleared instead of being cached.
    auth = undefined;
    await assert.rejects(inspect(), /HTTP 401/);
    assert.equal(lastRequest().authorization, undefined);

    // Matching auth.baseUrl is supported when provider-scoped LLAMA_BASE_URL is absent.
    expectedToken = 'base-url-key';
    auth = { auth: { apiKey: 'base-url-key', baseUrl: `${managerUrl}/llama/v1` } };
    await inspect();
    assert.equal(lastRequest().authorization, 'Bearer base-url-key');

    // Similar-looking or otherwise different endpoints must not receive the login key.
    const parsed = new URL(managerUrl);
    const otherPort = Number(parsed.port) + 1;
    const mismatches = [
      `http://localhost:${parsed.port}/llama`,
      `http://127.0.0.1:${otherPort}/llama`,
      `${managerUrl}/prefix/llama`,
      `${managerUrl}/llama-extra`,
      `https://127.0.0.1:${parsed.port}/llama`,
    ];
    for (const llamaUrl of mismatches) {
      auth = { auth: { apiKey: 'must-not-leak', baseUrl: `${managerUrl}/llama/v1` }, env: { LLAMA_BASE_URL: llamaUrl } };
      await assert.rejects(inspect(), /HTTP 401/);
      assert.equal(lastRequest().authorization, undefined, `login key leaked for ${llamaUrl}`);
    }

    // Pi's default local sentinel is not a bearer credential; explicit manager env auth remains a fallback.
    expectedToken = 'explicit-manager-token';
    auth = { auth: { apiKey: 'local' }, env: { LLAMA_BASE_URL: `${managerUrl}/llama` } };
    await assert.rejects(inspect(), /HTTP 401/);
    assert.equal(lastRequest().authorization, undefined);
    process.env[envName] = 'explicit-manager-token';
    auth = { auth: { apiKey: 'foreign-login-key' }, env: { LLAMA_BASE_URL: 'https://elsewhere.invalid/llama' } };
    await inspect();
    assert.equal(lastRequest().authorization, 'Bearer explicit-manager-token');
    assert.ok(notifications.some(message => message.includes('待機中')));
  } finally {
    if (previousEnv === undefined) delete process.env[envName]; else process.env[envName] = previousEnv;
    await close(server); await rm(cwd, { recursive: true, force: true });
  }
});

async function managerLocal(cwd: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(cwd, '.pi/comfy-state/manager-run.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
