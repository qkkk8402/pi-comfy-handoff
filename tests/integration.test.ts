import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  let text = ''; for await (const chunk of request) text += chunk.toString(); return JSON.parse(text);
}
function register() {
  const tools = new Map<string, any>(); const commands = new Map<string, any>(); const events = new Map<string, any>();
  extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => events.set(name, handler) } as unknown as ExtensionAPI);
  return { tools, commands, events };
}

test('Pi tools call the two APIs directly, edit/upload/generate and restore the LLM before returning', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'direct-integration-'));
  const calls: string[] = []; let model = 'unloaded'; let reserved = 0;
  const image = Buffer.from('generated fixture');
  const llama = createServer((req, res) => { void (async () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/llama/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-model', status: { value: model } }] })); return; }
    if (req.url === '/llama/models/load' || req.url === '/llama/models/unload') {
      assert.equal((await jsonBody(req)).model, 'fixture-model');
      model = req.url.endsWith('/unload') ? 'unloaded' : 'loaded';
      if (model === 'loaded') assert.equal(reserved, 0);
      calls.push(model); res.end('{"success":true}'); return;
    }
    res.statusCode = 404; res.end('{}');
  })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }); });
  const comfy = createServer((req, res) => { void (async () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/comfy/object_info') {
      res.end(JSON.stringify({ Fixture: { input: { required: { prompt: ['STRING', {}] } }, output: ['IMAGE'], output_node: true } })); return;
    }
    if (req.url === '/comfy/upload/image') {
      let multipart = ''; for await (const chunk of req) multipart += chunk.toString();
      assert.match(multipart, /input-pixels/); calls.push('upload');
      res.end('{"name":"input.png","subfolder":"","type":"input"}'); return;
    }
    if (req.url === '/comfy/queue') { res.end('{"queue_running":[],"queue_pending":[]}'); return; }
    if (req.url === '/comfy/prompt') {
      assert.equal(model, 'unloaded');
      assert.equal((await jsonBody(req)).prompt['1'].inputs.prompt, 'edited prompt');
      calls.push('generate'); reserved = 4000;
      res.end('{"prompt_id":"fixture-prompt","node_errors":{}}'); return;
    }
    if (req.url === '/comfy/history/fixture-prompt') {
      res.end(JSON.stringify({ 'fixture-prompt': { status: { completed: true, status_str: 'success' }, outputs: {
        '1': { images: [{ filename: 'image.png', subfolder: '', type: 'output' }] },
      } } })); return;
    }
    if (req.url?.startsWith('/comfy/view?')) { res.end(image); return; }
    if (req.url === '/comfy/free') {
      assert.deepEqual(await jsonBody(req), { unload_models: true, free_memory: true });
      calls.push('free'); reserved = 0; res.end(); return;
    }
    if (req.url === '/comfy/system_stats') {
      const mib = 1024 ** 2;
      res.end(JSON.stringify({ devices: [{ type: 'cuda', index: 0, vram_total: 16000 * mib,
        vram_free: (16000 - reserved - (model === 'loaded' ? 6000 : 0)) * mib,
        torch_vram_total: reserved * mib, torch_vram_free: 0 }] })); return;
    }
    res.statusCode = 404; res.end('{}');
  })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }); });
  try {
    const llamaServerUrl = `${await listen(llama)}/llama`; const comfyuiUrl = `${await listen(comfy)}/comfy`;
    await mkdir(join(cwd, '.pi'));
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ comfyuiUrl, llamaServerUrl, timeouts: { pollMs: 2, settleMs: 1000 } }));
    await writeFile(join(cwd, 'input.png'), 'input-pixels');
    const { tools, commands } = register();
    const ctx = { cwd, model: { id: 'fixture-model' }, ui: { notify() {} } };
    await commands.get('comfy').handler('connect fixture-model', ctx);
    assert.equal(model, 'loaded');
    const execute = (name: string, args: unknown) => tools.get(name).execute(`call-${name}`, args, undefined, undefined, ctx);
    await execute('comfy_upload', { path: 'input.png' });
    await execute('comfy_workflow', { action: 'create', path: 'workflow.json', workflow: { '1': { class_type: 'Fixture', inputs: { prompt: 'initial' } } } });
    await execute('comfy_workflow', { action: 'patch', path: 'workflow.json', patches: [{ op: 'setInput', nodeId: '1', input: 'prompt', value: 'edited prompt' }] });
    assert.equal((await execute('comfy_validate', { path: 'workflow.json' })).details.valid, true);
    const result = await execute('comfy_generate', { path: 'workflow.json' });
    assert.equal(result.details.state, 'complete', JSON.stringify(result.details));
    assert.equal(model, 'loaded');
    assert.deepEqual(calls, ['loaded', 'upload', 'unloaded', 'generate', 'free', 'loaded']);
    assert.deepEqual(await readFile(result.details.completed[0].outputs[0].path), image);
    // Retrying a completed tool call must not generate the image again.
    assert.equal((await execute('comfy_generate', { path: 'workflow.json' })).details.id, result.details.id);
    assert.equal(calls.filter(value => value === 'generate').length, 1);
  } finally { await close(llama); await close(comfy); await rm(cwd, { recursive: true, force: true }); }
});

test('extension registers its tools and commands', () => {
  const { tools, commands, events } = register();
  assert.deepEqual([...tools.keys()].sort(), ['comfy_generate', 'comfy_inspect', 'comfy_upload', 'comfy_validate', 'comfy_workflow']);
  for (const name of ['comfy_generate', 'comfy_workflow', 'comfy_upload']) assert.equal(tools.get(name).executionMode, 'sequential');
  assert.ok(commands.has('comfy')); assert.ok(events.has('input'));
});

test('/comfy setup saves validated endpoints, keeps optional config, and cancels safely', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'setup-integration-'));
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    const initial = { comfyuiUrl: 'http://127.0.0.1:8188', llamaServerUrl: 'http://127.0.0.1:8080', minFreeMiB: 512, outputDir: 'renders' };
    const configPath = join(cwd, '.pi/comfyui.json');
    await writeFile(configPath, JSON.stringify(initial));
    const { commands } = register();
    const notices: Array<{ message: string; type?: string }> = [];
    let answers: Array<string | undefined> = [];
    let idle = true;
    let beforeSecondAnswer: (() => Promise<void>) | undefined;
    const ctx = {
      cwd, hasUI: true, isIdle: () => idle,
      ui: {
        input: async () => {
          const answer = answers.shift();
          if (answers.length === 0 && beforeSecondAnswer) { const action = beforeSecondAnswer; beforeSecondAnswer = undefined; await action(); }
          return answer;
        },
        notify: (message: string, type?: string) => notices.push({ message, type }),
      },
    };
    const setup = () => commands.get('comfy').handler('setup', ctx);

    answers = ['https://comfy.example.test/prefix', 'http://llama.example.test:8080'];
    await setup();
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      ...initial, comfyuiUrl: 'https://comfy.example.test/prefix', llamaServerUrl: 'http://llama.example.test:8080',
    });
    const saved = await readFile(configPath, 'utf8');

    answers = ['ftp://invalid.example', 'http://ignored.example'];
    await setup();
    assert.equal(await readFile(configPath, 'utf8'), saved);
    assert.equal(notices.at(-1)?.type, 'error');

    answers = ['http://changed.example', undefined];
    await setup();
    assert.equal(await readFile(configPath, 'utf8'), saved);

    answers = ['', ''];
    await setup();
    assert.equal(await readFile(configPath, 'utf8'), saved);

    idle = false;
    answers = ['http://busy.example', 'http://busy-llama.example'];
    await setup();
    assert.equal(await readFile(configPath, 'utf8'), saved);
    assert.equal(notices.at(-1)?.type, 'error');
    idle = true;

    ctx.hasUI = false;
    await setup();
    assert.equal(await readFile(configPath, 'utf8'), saved);
    ctx.hasUI = true;

    answers = ['http://changed.example', 'http://changed-llama.example'];
    beforeSecondAnswer = async () => {
      await mkdir(join(cwd, '.pi/comfy-state'), { recursive: true });
      await writeFile(join(cwd, '.pi/comfy-state/runner-state.json'), JSON.stringify({
        version: 1, id: 'unresolved', state: 'recovery_required', phase: 'recovery_required', completed: [], snapshot: [], workflows: [],
        comfyuiUrl: initial.comfyuiUrl, llamaServerUrl: initial.llamaServerUrl,
      }));
    };
    await setup();
    assert.equal(await readFile(configPath, 'utf8'), saved);
    assert.equal(notices.at(-1)?.type, 'error');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('/comfy setup replaces cached ComfyUI and llama-server connections immediately', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'setup-runtime-'));
  const calls = new Map<string, number>();
  const record = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
  let oldModel = 'unloaded'; let newModel = 'unloaded';
  const mockComfy = (key: string) => createServer((req, res) => {
    record(`${key}:${req.url}`); res.setHeader('content-type', 'application/json');
    if (req.url === '/object_info') res.end(JSON.stringify({ TestNode: { input: { required: { prompt: ['STRING', {}] } } } }));
    else if (req.url === '/queue') res.end('{"queue_running":[],"queue_pending":[]}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  const mockLlama = (key: string, getModel: () => string, setModel: (value: string) => void, modelId: string) => createServer((req, res) => {
    record(`${key}:${req.url}`); res.setHeader('content-type', 'application/json');
    if (req.url === '/models') res.end(JSON.stringify({ data: [{ id: modelId, status: { value: getModel() } }] }));
    else if (req.url === '/models/load' || req.url === '/models/unload') {
      setModel(req.url.endsWith('/load') ? 'loaded' : 'unloaded'); res.end('{"success":true}');
    } else { res.statusCode = 404; res.end('{}'); }
  });
  const oldComfy = mockComfy('old-comfy'); const newComfy = mockComfy('new-comfy');
  const oldLlama = mockLlama('old-llama', () => oldModel, value => { oldModel = value; }, 'old-model');
  const newLlama = mockLlama('new-llama', () => newModel, value => { newModel = value; }, 'new-model');
  try {
    const [oldComfyUrl, newComfyUrl, oldLlamaUrl, newLlamaUrl] = await Promise.all([
      listen(oldComfy), listen(newComfy), listen(oldLlama), listen(newLlama),
    ]);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ comfyuiUrl: oldComfyUrl, llamaServerUrl: oldLlamaUrl }));
    const { tools, commands } = register();
    const answers: string[] = [newComfyUrl, newLlamaUrl];
    const ctx = { cwd, hasUI: true, isIdle: () => true, model: undefined,
      ui: { input: async () => answers.shift(), notify() {} } };
    await tools.get('comfy_inspect').execute('old', {}, undefined, undefined, ctx);
    await commands.get('comfy').handler('connect old-model', ctx);
    assert.equal(oldModel, 'loaded');

    await commands.get('comfy').handler('setup', ctx);
    await tools.get('comfy_inspect').execute('new', {}, undefined, undefined, ctx);
    await commands.get('comfy').handler('connect new-model', ctx);
    assert.equal(newModel, 'loaded');
    assert.ok((calls.get('new-comfy:/object_info') ?? 0) > 0);
    assert.ok((calls.get('new-comfy:/queue') ?? 0) > 0);
    assert.ok((calls.get('new-llama:/models') ?? 0) > 0);
    assert.ok((calls.get('new-llama:/models/load') ?? 0) > 0);
    assert.equal(calls.get('old-comfy:/object_info'), 1);
    assert.equal(calls.get('old-llama:/models/load'), 1);
  } finally {
    await Promise.all([oldComfy, newComfy, oldLlama, newLlama].map(close));
    await rm(cwd, { recursive: true, force: true });
  }
});
