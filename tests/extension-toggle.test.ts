import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import extension from '../src/extension.js';

const comfyTools = ['comfy_upload', 'comfy_inspect', 'comfy_workflow', 'comfy_server_workflow', 'comfy_validate', 'comfy_generate'];

function harness(initial: string[] = [...comfyTools, 'read', 'bash']) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Function[]>();
  let active = [...initial];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: Function) => events.set(name, [...(events.get(name) ?? []), handler]),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  };
  extension(pi);
  return { tools, commands, events, get active() { return active; } };
}

function context(cwd: string, options: { idle?: boolean; choice?: string } = {}) {
  const messages: string[] = [];
  const calls: string[] = [];
  return {
    cwd, isIdle: () => options.idle ?? true, hasUI: true, model: { id: 'model' }, signal: new AbortController().signal,
    abort() {}, ui: {
      notify: (message: string) => messages.push(message),
      select: async (_message: string, choices: string[]) => { calls.push(...choices); return options.choice; },
      input: async () => undefined,
    }, messages, calls,
  };
}

test('disabled tools are removed on startup and next turn, other tools stay active, all entry points avoid HTTP', async t => {
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'toggle-disabled-'));
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ enabled: false }));
    const h = harness();
    const ctx = context(cwd);
    let httpCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => { httpCalls++; throw new TypeError('unexpected HTTP request'); });
    for (const event of ['session_start', 'before_agent_start']) await h.events.get(event)![0]!({}, ctx);
    assert.deepEqual(h.active, ['read', 'bash']);
    assert.deepEqual(await h.events.get('input')![0]!({}, ctx), { action: 'continue' });
    await h.commands.get('comfy')!.handler('status', ctx);
    assert.ok(ctx.messages.some(message => message.includes('無効')));
    assert.deepEqual(ctx.calls, []);
    for (const [name, args] of [
      ['comfy_upload', { path: 'x' }], ['comfy_inspect', {}], ['comfy_workflow', { action: 'inspect', path: 'x' }],
      ['comfy_server_workflow', { action: 'list' }], ['comfy_validate', { path: 'x' }], ['comfy_generate', { path: 'x' }],
    ] as const) {
      await assert.rejects(h.tools.get(name).execute('id', args, undefined, undefined, ctx), /disabled/);
    }
    assert.equal(httpCalls, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('server workflow tool normalizes listing paths, preserves UI JSON, controls overwrite and exposes manager errors', async t => {
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'server-workflow-tool-'));
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ managerUrl: 'http://manager.example:8090' }));
    const h = harness();
    const uiWorkflow = { nodes: [{ id: 1, type: 'SaveImage', widgets_values: ['image'] }], links: [], extra: { note: 'keep UI format' } };
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let body: unknown;
      if (typeof init?.body === 'string') body = JSON.parse(init.body);
      requests.push({ url, method, body });
      if (url.endsWith('/workflows') && method === 'GET') return Response.json(['sub folder/a.json', 'readme.txt', 'nested/b.json']);
      if (url.endsWith('/workflows/workflows%2Fsub%20folder%2Fa.json') && method === 'GET') return Response.json(uiWorkflow);
      if (method === 'POST' && url.includes('conflict.json') && url.endsWith('?overwrite=false')) return Response.json({ error: { message: 'file exists' } }, { status: 409 });
      if (method === 'POST' && url.endsWith('?overwrite=false')) return Response.json({ saved: true });
      if (method === 'POST' && url.endsWith('?overwrite=true')) return Response.json({ saved: true, overwritten: true });
      if (url.endsWith('/workflows/workflows%2Funauthorized.json')) return Response.json({ error: { message: 'unauthorized' } }, { status: 401 });
      if (url.endsWith('/workflows/workflows%2Fmissing.json')) return Response.json({ error: { message: 'workflow missing' } }, { status: 404 });
      return Response.json({ error: { message: `unexpected ${method} ${url}` } }, { status: 500 });
    });
    const ctx = context(cwd);
    const tool = h.tools.get('comfy_server_workflow');
    const listResult = await tool.execute('list', { action: 'list' }, undefined, undefined, ctx);
    assert.deepEqual(listResult.details, ['workflows/sub folder/a.json', 'workflows/nested/b.json']);
    const path = (listResult.details as string[])[0]!;
    const getResult = await tool.execute('get', { action: 'get', path }, undefined, undefined, ctx);
    assert.deepEqual(getResult.details, uiWorkflow);
    await tool.execute('save-default', { action: 'save', path, workflow: uiWorkflow }, undefined, undefined, ctx);
    await tool.execute('save-overwrite', { action: 'save', path, workflow: uiWorkflow, overwrite: true }, undefined, undefined, ctx);
    assert.deepEqual(requests.slice(0, 4).map(({ url, method }) => [url, method]), [
      ['http://manager.example:8090/workflows', 'GET'],
      ['http://manager.example:8090/workflows/workflows%2Fsub%20folder%2Fa.json', 'GET'],
      ['http://manager.example:8090/workflows/workflows%2Fsub%20folder%2Fa.json?overwrite=false', 'POST'],
      ['http://manager.example:8090/workflows/workflows%2Fsub%20folder%2Fa.json?overwrite=true', 'POST'],
    ]);
    assert.deepEqual(requests[2]!.body, uiWorkflow);
    assert.deepEqual(requests[3]!.body, uiWorkflow);
    await assert.rejects(tool.execute('unauthorized', { action: 'get', path: 'workflows/unauthorized.json' }, undefined, undefined, ctx), /HTTP 401: unauthorized/);
    await assert.rejects(tool.execute('missing', { action: 'get', path: 'workflows/missing.json' }, undefined, undefined, ctx), /HTTP 404: workflow missing/);
    await assert.rejects(tool.execute('conflict', { action: 'save', path: 'workflows/conflict.json', workflow: uiWorkflow }, undefined, undefined, ctx), /HTTP 409: file exists/);
    await tool.execute('conflict-overwrite', { action: 'save', path: 'workflows/conflict.json', workflow: uiWorkflow, overwrite: true }, undefined, undefined, ctx);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('disabled menu enables all ComfyUI tools and keeps unrelated active tools', async () => {
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'toggle-enable-'));
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ enabled: false, outputDir: 'renders' }));
    const h = harness(['read', 'bash']);
    const ctx = context(cwd, { choice: 'ComfyUIツールを有効にする' });
    await h.commands.get('comfy').handler('', ctx);
    assert.deepEqual(h.active, ['read', 'bash', ...comfyTools]);
    assert.equal(JSON.parse(await readFile(join(cwd, '.pi/comfyui.json'), 'utf8')).outputDir, 'renders');
    assert.equal(JSON.parse(await readFile(join(cwd, '.pi/comfyui.json'), 'utf8')).enabled, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('enabled menu refuses a toggle while Pi is busy', async t => {
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'toggle-busy-'));
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ enabled: true }));
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
    const h = harness();
    const ctx = context(cwd, { idle: false, choice: 'ComfyUIツールを無効にする' });
    await h.commands.get('comfy').handler('', ctx);
    assert.ok(ctx.messages.some(message => message.includes('アイドル状態')));
    assert.ok(h.active.includes('comfy_generate'));
    assert.equal(JSON.parse(await readFile(join(cwd, '.pi/comfyui.json'), 'utf8')).enabled, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('enabled menu disables tools, restart removes them, and explicit enable restores them', async t => {
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'toggle-cycle-'));
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ enabled: true }));
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
    const first = harness(['read', 'comfy_inspect', 'comfy_generate']);
    await first.commands.get('comfy')!.handler('', context(cwd, { choice: 'ComfyUIツールを無効にする' }));
    assert.deepEqual(first.active, ['read']);
    assert.equal(JSON.parse(await readFile(join(cwd, '.pi/comfyui.json'), 'utf8')).enabled, false);

    const restarted = harness();
    await restarted.events.get('session_start')![0]!({}, context(cwd));
    assert.deepEqual(restarted.active, ['read', 'bash']);
    await restarted.commands.get('comfy')!.handler('', context(cwd, { choice: 'ComfyUIツールを有効にする' }));
    assert.deepEqual(restarted.active, ['read', 'bash', ...comfyTools]);
    assert.equal(JSON.parse(await readFile(join(cwd, '.pi/comfyui.json'), 'utf8')).enabled, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
