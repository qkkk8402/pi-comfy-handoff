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
  extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on() {} } as unknown as ExtensionAPI);
  return { tools, commands };
}

test('Pi cancellation leaves the host job running and /comfy resume downloads its result without resubmitting', async () => {
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
    const ui = { notify() {}, setStatus() {} };
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
    await commands.get('comfy').handler('resume', { ...toolCtx, hasUI: true, signal: undefined,
      ui: { notify(message: string) { notices.push(message); }, setStatus() {} } });
    assert.equal(submissions, submissionsBeforeResume, 'resume only polls the host job');
    assert.equal(cancellations, 0);
    assert.equal(await localRun(cwd), undefined);
    assert.match(notices.at(-1) ?? '', /complete/);
    const resumed = JSON.parse(notices.at(-1)!);
    assert.deepEqual(resumed.details.completed.map((entry: any) => entry.outputs.length), [1, 1]);
    const output = join(cwd, 'outputs', 'host-prompt-0-finished.png');
    assert.deepEqual(await readFile(output), image);
    assert.ok((await stat(output)).size > 0);
  } finally { await close(manager); await rm(cwd, { recursive: true, force: true }); }
});

test('/comfy recover clears only orphaned local wait records and preserves matching or active host runs', async () => {
  await mkdir('work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'manager-recover-local-'));
  let state: any = { state: 'idle', phase: 'idle' };
  let recoveries = 0;
  const manager = createServer((req, res) => {
    if (req.url === '/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return; }
    if (req.url === '/recover' && req.method === 'POST') {
      recoveries++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  try {
    const managerUrl = await listen(manager);
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await mkdir(join(cwd, '.pi/comfy-state'), { recursive: true });
    await writeFile(join(cwd, '.pi/comfyui.json'), JSON.stringify({ managerUrl }));
    const saved = { version: 1, id: 'local-run', startedAt: Date.now(), downloaded: {} };
    const { commands } = register();
    const notifications: string[] = [];
    const ctx: any = { cwd, hasUI: true, signal: undefined, abort() {}, ui: { notify(message: string) { notifications.push(message); }, setStatus() {} } };

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
    await commands.get('comfy').handler('recover', ctx);
    assert.equal(await localRun(cwd), undefined, 'idle host state clears the stale local wait record');
    assert.match(notifications.at(-1) ?? '', /生成は再送していません/);
    assert.equal(recoveries, 1);

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
    await commands.get('comfy').handler('recover another-id', ctx);
    assert.deepEqual(await localRun(cwd), saved, 'an explicit different ID cannot clear this local record');

    state = { id: 'other-run', state: 'running', phase: 'generating', completed: [] };
    await commands.get('comfy').handler('recover', ctx);
    assert.deepEqual(await localRun(cwd), saved, 'a different active host run keeps the local record');

    state = { id: 'other-terminal', state: 'failed', phase: 'failed', completed: [] };
    await commands.get('comfy').handler('recover', ctx);
    assert.equal(await localRun(cwd), undefined, 'a different terminal host run clears the stale local record');

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
    state = { id: 'local-run', state: 'complete', phase: 'complete', completed: [] };
    await commands.get('comfy').handler('recover', ctx);
    assert.deepEqual(await localRun(cwd), saved, 'matching terminal run is retained for resume and output download');

    await writeFile(join(cwd, '.pi/comfy-state/manager-run.json'), JSON.stringify(saved));
    state = { state: 'idle', phase: 'idle' };
    await commands.get('comfy').handler('recover', ctx);
    assert.equal(await localRun(cwd), undefined);
    let entered = false;
    await commands.get('comfy').handler('setup', { ...ctx, isIdle() { return true; }, ui: { ...ctx.ui, input: async () => { entered = true; return undefined; } } });
    assert.equal(entered, true, 'setup is available once recover clears the orphaned local record');
  } finally { await close(manager); await rm(cwd, { recursive: true, force: true }); }
});

async function localRun(cwd: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(cwd, '.pi/comfy-state/manager-run.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
