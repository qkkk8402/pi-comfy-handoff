import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
async function readBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  let value = ''; for await (const chunk of request) value += chunk.toString(); return value;
}
function register() {
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  const events = new Map<string, (event: unknown, ctx: any) => unknown>();
  extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: any) => events.set(name, handler) } as unknown as ExtensionAPI);
  return { tools, commands, events };
}

test('Pi cancellation leaves the host job running and /comfy menu resumes outputs without resubmitting', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-resume-'));
  const image = Buffer.from('resume fixture');
  let state: any = { state: 'idle', phase: 'idle' };
  let submissions = 0; let cancellations = 0; let polls = 0;
  const submissionIds: string[] = [];
  let abortWaiting: (() => void) | undefined;
  const manager = createServer((req, res) => { void (async () => {
    if (req.url === '/status') {
      polls++;
      if (state.state === 'running' && polls === 3) setTimeout(() => abortWaiting?.(), 12);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return;
    }
    if (req.url === '/generate' && req.method === 'POST') {
      const request = JSON.parse(await readBody(req)); submissions++; submissionIds.push(request.id);
      if (submissions === 1) {
        state = { id: request.id, state: 'running', phase: 'generating', completed: [] };
        polls = 0;
        res.destroy(); // The host accepted the job but the Pi never received its acknowledgement.
        return;
      }
      assert.equal(request.id, state.id, 'unknown submission retries must reuse the idempotency key');
      setTimeout(() => abortWaiting?.(), 14);
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify(state)); return;
    }
    if (req.url === '/comfy/object_info') {
      res.setHeader('content-type', 'application/json');
      res.end('{"Fixture":{"input":{"required":{"prompt":["STRING",{}]}},"output":["IMAGE"],"output_node":true}}'); return;
    }
    if (req.url?.startsWith('/comfy/view?')) { res.end(image); return; }
    if (req.url === '/cancel') { cancellations++; res.end(JSON.stringify(state)); return; }
    res.statusCode = 404; res.end('{}');
  })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }); });
  try {
    const managerUrl = await listen(manager);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ managerUrl, outputDir: 'outputs', timeouts: { requestMs: 100, pollMs: 3 } }));
    await writeFile(join(cwd, 'workflow.json'), JSON.stringify({ '1': { class_type: 'Fixture', inputs: { prompt: 'resume me' } } }));
    const { tools, commands } = register();
    let abortCalls = 0;
    const ui = { async select(_prompt: string, choices: string[]) { return choices.includes('生成の待機・復旧を続ける') ? '生成の待機・復旧を続ける' : '閉じる'; }, notify() {}, setStatus() {} };
    const toolCtx = { cwd, hasUI: false, model: { id: 'fixture-model' }, abort() { abortCalls++; }, ui };
    const controller = new AbortController(); abortWaiting = () => controller.abort(new Error('Simulated Pi interrupt'));
    const result = await tools.get('comfy_generate').execute('long-run', { path: 'workflow.json' }, controller.signal, undefined, toolCtx);
    assert.equal(result.details.state, 'recovery_required');
    assert.equal(result.terminate, true);
    assert.equal(abortCalls, 1);
    assert.equal(state.state, 'running');
    assert.equal(submissions, 2, 'the lost acknowledgement is retried using the same idempotency key');
    assert.equal(new Set(submissionIds).size, 1);
    assert.equal(cancellations, 0, 'interrupting Pi waiting must not cancel host generation');
    const saved = JSON.parse(await readFile(join(cwd, '.pi/comfy-state/manager-run.json'), 'utf8'));
    assert.ok(saved.id);

    state = { ...state, state: 'complete', phase: 'complete', completed: [{ promptId: 'host-prompt', outputs: [
      { nodeId: '7', filename: 'finished.png', subfolder: '', type: 'output' },
    ] }, { promptId: 'host-prompt-2', outputs: [
      { nodeId: '7', filename: 'finished.png', subfolder: '', type: 'output' },
    ] }] };
    const submissionsBeforeResume = submissions;
    const notices: string[] = [];
    await commands.get('comfy').handler('', { ...toolCtx, hasUI: true, signal: undefined,
      ui: { async select(_prompt: string, choices: string[]) { return choices.includes('生成の待機・復旧を続ける') ? '生成の待機・復旧を続ける' : '閉じる'; }, notify(message: string) { notices.push(message); }, setStatus() {} } });
    assert.equal(submissions, submissionsBeforeResume, 'resume only polls the host job');
    assert.equal(cancellations, 0);
    assert.equal(await localRun(cwd), undefined);
    assert.match(notices.at(-1) ?? '', /生成が完了しました/);
    assert.match(notices.at(-1) ?? '', /host-prompt-0-finished.png/);
    const output = join(cwd, 'outputs', 'host-prompt-0-finished.png');
    assert.deepEqual(await readFile(output), image);
    assert.ok((await stat(output)).size > 0);
  } finally { await close(manager); await rm(cwd, { recursive: true, force: true }); }
});

test('/comfy menu continues recovery, downloads partial outputs, and clears resolved local records', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-recover-local-'));
  const recoveredImage = Buffer.from('partial output recovered after ComfyUI restart');
  let state: any = { state: 'idle', phase: 'idle' };
  let recoveredState: any;
  let failDownloads = false;
  let recoveries = 0;
  const manager = createServer((req, res) => {
    if (req.url === '/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return; }
    if (req.url === '/recover' && req.method === 'POST') {
      recoveries++;
      if (state.id === 'local-run' && state.state === 'recovery_required') {
        state = { ...state, managerPhase: 'generation' };
        setTimeout(() => { state = recoveredState; }, 20);
      }
      res.statusCode = 202; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return;
    }
    if (req.url?.startsWith('/comfy/view?')) {
      if (failDownloads) { res.statusCode = 503; res.end('temporary download failure'); }
      else res.end(recoveredImage);
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  try {
    const managerUrl = await listen(manager);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await mkdir(join(cwd, '.pi/comfy-state'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ managerUrl, outputDir: 'outputs', timeouts: { pollMs: 2 } }));
    const saved = { version: 1, id: 'local-run', startedAt: Date.now(), downloaded: {} };
    const { commands, events } = register();
    const notifications: string[] = [];
    const ctx: any = { cwd, hasUI: true, signal: undefined, abort() {}, isIdle() { return true; }, ui: { async select(_prompt: string, choices: string[]) { return choices.includes('生成の待機・復旧を続ける') ? '生成の待機・復旧を続ける' : choices.includes('接続設定') ? '接続設定' : '接続先を変更'; }, async input() { return undefined; }, notify(message: string) { notifications.push(message); }, setStatus() {} } };

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
    await commands.get('comfy').handler('', ctx);
    assert.equal(await localRun(cwd), undefined, 'idle host state clears the stale local wait record');
    assert.match(notifications.at(-1) ?? '', /生成は再送していません/);
    assert.equal(recoveries, 0, 'an idle manager needs no recover request to clear an orphaned local record');

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
        state = { id: 'other-run', state: 'running', phase: 'generating', completed: [] };
    await commands.get('comfy').handler('', ctx);
    assert.deepEqual(await localRun(cwd), saved, 'a different active host run keeps the local record');

    state = { id: 'other-terminal', state: 'failed', phase: 'failed', completed: [] };
    await commands.get('comfy').handler('', ctx);
    assert.equal(await localRun(cwd), undefined, 'a different terminal host run clears the stale local record');

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
    state = { id: 'local-run', state: 'recovery_required', phase: 'recovery_required', completed: [] };
    recoveredState = { id: 'local-run', state: 'failed', phase: 'failed', managerPhase: 'llm_ready', completed: [{
      promptId: 'partial-prompt', outputs: [{ nodeId: '7', filename: 'partial.png', subfolder: '', type: 'output' }],
    }] };
    await commands.get('comfy').handler('', ctx);
    assert.equal(await localRun(cwd), undefined, 'recover waits for the asynchronous host cleanup and clears the local record after downloading partial output');
    assert.deepEqual(await readFile(join(cwd, 'outputs', 'partial-prompt-0-partial.png')), recoveredImage);
    assert.match(notifications.at(-1) ?? '', /failed/);

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
    state = { id: 'local-run', state: 'recovery_required', phase: 'recovery_required', completed: [] };
    recoveredState = { ...state, managerPhase: 'paused' };
    await commands.get('comfy').handler('', ctx);
    assert.deepEqual(await localRun(cwd), saved, 'an unresolved host job remains saved');
    assert.deepEqual(await events.get('input')!({}, ctx), { action: 'handled' }, 'new prompts remain blocked while recovery is unresolved');

    recoveredState = { id: 'local-run', state: 'failed', phase: 'failed', managerPhase: 'llm_ready', completed: [{
      promptId: 'retry-prompt', outputs: [{ nodeId: '7', filename: 'retry.png', subfolder: '', type: 'output' }],
    }] };
    failDownloads = true;
    await commands.get('comfy').handler('', ctx);
    assert.deepEqual(await localRun(cwd), saved, 'failed output download keeps the local run available for retry');
    assert.deepEqual(await events.get('input')!({}, ctx), { action: 'handled' }, 'new prompts stay blocked while output retrieval remains unfinished');

    failDownloads = false;
    await commands.get('comfy').handler('', ctx);
    assert.equal(await localRun(cwd), undefined, 'a later recover downloads the saved output and clears the local record');
    assert.deepEqual(await readFile(join(cwd, 'outputs', 'retry-prompt-0-retry.png')), recoveredImage);
    assert.deepEqual(await events.get('input')!({}, ctx), { action: 'continue' }, 'new prompts are accepted after local recovery finishes');

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
    state = { state: 'idle', phase: 'idle' };
    await commands.get('comfy').handler('', ctx);
    assert.equal(await localRun(cwd), undefined);
    let entered = false;
    await commands.get('comfy').handler('', { ...ctx, isIdle() { return true; }, ui: { ...ctx.ui, async select(_prompt: string, choices: string[]) { return choices.includes('接続設定') ? '接続設定' : '接続先を変更'; }, input: async () => { entered = true; return undefined; } } });
    assert.equal(entered, true, 'setup is available once recover clears the orphaned local record');
  } finally { await close(manager); await rm(cwd, { recursive: true, force: true }); }
});

test('/comfy menu cancel confirmation defaults to back and leaves the host job unchanged', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-menu-cancel-'));
  let cancels = 0;
  const manager = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/status') res.end('{"id":"active-run","state":"running","phase":"generating"}');
    else if (req.url === '/cancel') { cancels++; res.end('{"id":"active-run","state":"cancelled"}'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  try {
    const managerUrl = await listen(manager);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ managerUrl }));
    const { commands } = register();
    let confirmationChoices: string[] = [];
    const ctx = { cwd, hasUI: true, model: undefined, signal: undefined, abort() {}, ui: {
      async select(_prompt: string, choices: string[]) {
        if (choices.includes('生成をキャンセル')) return '生成をキャンセル';
        confirmationChoices = choices;
        return '戻る';
      }, notify() {}, setStatus() {},
    } };
    await commands.get('comfy').handler('', ctx);
    assert.deepEqual(confirmationChoices, ['戻る', 'キャンセルする']);
    assert.equal(cancels, 0);
    assert.equal(await localRun(cwd), undefined, 'canceling the confirmation does not alter the local run record');
  } finally { await close(manager); await rm(cwd, { recursive: true, force: true }); }
});

async function localRun(cwd: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(cwd, '.pi/comfy-state/manager-run.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
