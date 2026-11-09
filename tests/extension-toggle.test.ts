import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import extension from '../src/extension.js';

const comfyTools = ['comfy_upload', 'comfy_inspect', 'comfy_workflow', 'comfy_validate', 'comfy_generate'];

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
      ['comfy_validate', { path: 'x' }], ['comfy_generate', { path: 'x' }],
    ] as const) {
      await assert.rejects(h.tools.get(name).execute('id', args, undefined, undefined, ctx), /disabled/);
    }
    assert.equal(httpCalls, 0);
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
