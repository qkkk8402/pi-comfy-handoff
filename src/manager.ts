import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ComfyClient } from './comfy.js';
import { loadManagerConfig, parseManagerArgs } from './manager-config.js';
import { LlamaRouterClient } from './llama.js';
import { Runner, type RunState } from './runner.js';
import { createVramMonitor, type VramMonitor } from './vram.js';
import type { ComfyAdapter, LlamaAdapter, ManagerConfig, Workflow } from './types.js';

const BODY_LIMIT = 10 * 1024 * 1024;
const SAFE_HEADERS = ['accept-ranges', 'cache-control', 'content-disposition', 'content-length', 'content-range', 'content-type'];

export interface ManagerDependencies {
  comfy?: ComfyClient & ComfyAdapter;
  llama?: LlamaRouterClient & LlamaAdapter;
  vram?: VramMonitor;
  fetchImpl?: typeof fetch;
  verifyAutoload?: boolean;
}

export interface ManagerServer {
  server: Server;
  start(): Promise<void>;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message } });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > BODY_LIMIT) throw new Error('Request body exceeds 10 MiB');
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request body must be valid JSON'); }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function authMatches(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const value = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function withPrefix(base: string, path: string): string {
  const upstream = new URL(base);
  const suffix = new URL(path, 'http://manager.invalid');
  upstream.pathname = `${upstream.pathname.replace(/\/$/, '')}${suffix.pathname}`;
  upstream.search = suffix.search;
  return upstream.toString();
}

async function pipeResponse(response: Response, res: ServerResponse, keepReading = false): Promise<void> {
  res.writeHead(response.status, response.statusText, Object.fromEntries(
    SAFE_HEADERS.flatMap(name => { const value = response.headers.get(name); return value === null ? [] : [[name, value]]; }),
  ));
  if (!response.body) { res.end(); return; }
  for await (const chunk of response.body) {
    if (res.destroyed || res.writableEnded) {
      if (!keepReading) return;
      continue;
    }
    try {
      if (!res.write(chunk)) await waitForDrainOrClose(res);
    } catch (error) {
      if (!keepReading || (error as NodeJS.ErrnoException).code !== 'ERR_STREAM_DESTROYED') throw error;
    }
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

function waitForDrainOrClose(res: ServerResponse): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      res.off('drain', onDrain); res.off('close', onClose); res.off('error', onError);
      resolve();
    };
    const onDrain = () => done();
    const onClose = () => done();
    const onError = () => done();
    res.once('drain', onDrain); res.once('close', onClose); res.once('error', onError);
  });
}

async function readResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  if (!body.trim()) return undefined;
  try { return JSON.parse(body); }
  catch { throw new Error('Upstream returned invalid JSON'); }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isInference(path: string, method: string): boolean {
  return method === 'POST' && ['/v1/chat/completions', '/v1/completions', '/completion'].includes(path);
}

function managementPath(path: string): boolean {
  return path === '/models/load' || path === '/models/unload';
}

function publicState<T extends RunState | { state: 'idle'; phase: 'idle' }>(state: T): T {
  if (!('completed' in state)) return state;
  const completed = state.completed.map(item => ({ ...item, outputs: item.outputs.map(output => {
    if (!record(output)) return {};
    return Object.fromEntries(['nodeId', 'filename', 'subfolder', 'type'].flatMap(key =>
      typeof output[key] === 'string' ? [[key, output[key]]] : [],
    ));
  }) }));
  return { ...state, completed } as T;
}

export function createManager(config: ManagerConfig, dependencies: ManagerDependencies = {}): ManagerServer {
  if (!isLoopback(config.listenHost) && !config.token) throw new Error('A bearer token is required when the manager listens on a non-loopback address');
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const comfy = dependencies.comfy ?? new ComfyClient(config.comfyuiUrl, {
    requestMs: config.timeouts.requestMs, generationMs: config.timeouts.generationMs,
    pollMs: config.timeouts.pollMs, settleMs: config.timeouts.settleMs,
    outputDir: undefined, apiKey: config.comfyApiKey, dedicatedServer: true,
  }) as ComfyClient & ComfyAdapter;
  const llama = dependencies.llama ?? new LlamaRouterClient(config.llamaServerUrl, {
    requestMs: config.timeouts.requestMs, modelMs: config.timeouts.modelMs, pollMs: config.timeouts.pollMs,
    apiKey: config.llamaApiKey,
  }) as LlamaRouterClient & LlamaAdapter;
  let vram = dependencies.vram;
  const waitForVramRelease = async (minFreeMiB?: number): Promise<void> => {
    const sample = await vram?.read();
    if (sample) { await vram!.waitForRelease(minFreeMiB); return; }
    await comfy.waitForRelease?.(minFreeMiB);
  };
  const runner = new Runner(config, { comfy, llama, waitForVramRelease });
  let acceptingInference = true;
  let inFlight = 0;
  let transition: 'generation' | 'model' | undefined;
  let ready = false;
  let job: { id: string; modelId?: string; workflows: Workflow[]; accepted: Promise<RunState>; task: Promise<RunState> } | undefined;
  let drainResolver: (() => void) | undefined;

  const waitForInference = async (): Promise<void> => {
    while (inFlight > 0) await new Promise<void>(resolve => { drainResolver = resolve; });
  };
  const endInference = (): void => {
    inFlight--;
    if (inFlight === 0) { drainResolver?.(); drainResolver = undefined; }
  };
  const stateWithMetrics = async (): Promise<unknown> => {
    const state = await runner.status();
    let sample: unknown = { source: 'comfyui', available: false };
    try { sample = await vram?.read() ?? sample; }
    catch (error) { sample = { source: 'host', error: error instanceof Error ? error.message : 'VRAM telemetry unavailable' }; }
    return { ...publicState(state), inferenceRequests: inFlight, vram: sample, managerPhase: transition ?? (acceptingInference ? 'llm_ready' : 'paused') };
  };
  const updateGate = async (state?: RunState): Promise<void> => {
    const current = state ?? await runner.status();
    acceptingInference = ['complete', 'failed', 'cancelled', 'idle'].includes(current.state);
    transition = undefined;
  };
  const forward = async (req: IncomingMessage, res: ServerResponse, base: string, path: string, keepReading = false): Promise<void> => {
    const headers = new Headers();
    for (const name of ['accept', 'content-type', 'range']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    if (base === config.llamaServerUrl && config.llamaApiKey) headers.set('authorization', `Bearer ${config.llamaApiKey}`);
    if (base === config.comfyuiUrl && config.comfyApiKey) headers.set('authorization', `Bearer ${config.comfyApiKey}`);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody ? Readable.toWeb(req) as ReadableStream<Uint8Array> : undefined;
    let response: Response;
    const upstreamUrl = withPrefix(base, path);
    try {
      response = await fetchImpl(upstreamUrl, {
        method: req.method,
        headers,
        body,
        ...(body ? { duplex: 'half' } as RequestInit : {}),
        redirect: 'error',
      });
    } catch (error) {
      const endpoint = new URL(upstreamUrl);
      const detail = error instanceof Error ? error.message : String(error);
      const cause = (error as Error & { cause?: NodeJS.ErrnoException })?.cause;
      const code = (error as NodeJS.ErrnoException)?.code ?? cause?.code;
      throw new Error(`${req.method} ${endpoint.origin}${endpoint.pathname} request to upstream failed${code ? ` (${code})` : ''}: ${detail}`);
    }
    await pipeResponse(response, res, keepReading);
  };

  const proxyInference = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (!ready || !acceptingInference || transition || !authMatches(req, config.token)) {
      sendError(res, 503, 'LLM inference is paused while GPU models are switching');
      return;
    }
    inFlight++;
    try { await forward(req, res, config.llamaServerUrl, path, true); }
    finally { endInference(); }
  };

  const modelOperation = async (operation: 'load' | 'unload', name: unknown, res: ServerResponse): Promise<void> => {
    if (transition || runner.isBusy) { sendError(res, 409, `Cannot ${operation} llama.cpp model${typeof name === 'string' ? ` "${name}"` : ''}: a GPU operation is already active`); return; }
    if (typeof name !== 'string' || !name.trim()) { sendError(res, 400, 'model is required'); return; }
    transition = 'model'; acceptingInference = false;
    try {
      const runState = await runner.status();
      if (runState.state === 'running' || runState.state === 'recovery_required') throw new Error('Recover the active generation before changing models');
      await waitForInference();
      const models = await llama.listModels();
      const target = models.find(model => model.name === name);
      if (!target) throw new Error(`llama-server model not found: ${name}`);
      if (operation === 'load') {
        if (models.some(model => model.name !== target.name && model.status !== 'unloaded')) throw new Error('Other llama-server models are resident');
        if (target.status !== 'loaded') {
          const queue = await comfy.queue();
          if (queue.running.length || queue.pending.length) throw new Error('ComfyUI queue is not empty');
          await comfy.free();
          await waitForVramRelease();
        }
        await llama.load(name);
      } else await llama.unload(name);
      acceptingInference = true; transition = undefined;
      sendJson(res, 200, { success: true, model: name, status: operation === 'load' ? 'loaded' : 'unloaded' });
    } catch (error) {
      acceptingInference = false; transition = undefined;
      sendError(res, 409, `Cannot ${operation} llama.cpp model "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      if (!authMatches(req, config.token)) { sendError(res, 401, 'Bearer token required'); return; }
      if (path === '/health' && req.method === 'GET') { sendJson(res, ready ? 200 : 503, { ready }); return; }
      if (path === '/status' && req.method === 'GET') { sendJson(res, 200, await stateWithMetrics()); return; }

      if (path === '/generate' && req.method === 'POST') {
        const body = await readJson(req);
        if (!record(body) || typeof body.id !== 'string' || !body.id.trim() || body.id.length > 256 || !Array.isArray(body.workflows) || body.workflows.length < 1 || body.workflows.length > 32) {
          sendError(res, 400, 'Expected { id, modelId?, workflows } with 1 to 32 workflows'); return;
        }
        const workflows = body.workflows as Workflow[];
        if (job && job.id === body.id) {
          const modelId = typeof body.modelId === 'string' ? body.modelId : undefined;
          if (job.modelId !== modelId || JSON.stringify(job.workflows) !== JSON.stringify(workflows)) { sendError(res, 409, 'The same job ID has different input'); return; }
          const state = await job.accepted;
          sendJson(res, state.state === 'complete' ? 200 : 202, { ...publicState(state), inferenceRequests: inFlight, vram: await vram?.read().catch(() => undefined) }); return;
        }
        if (transition || runner.isBusy) { sendError(res, 409, 'A GPU operation is already active'); return; }
        transition = 'generation'; acceptingInference = false;
        let accept!: (state: RunState) => void;
        let reject!: (error: unknown) => void;
        let acceptedOnce = false;
        const acceptOnce = (state: RunState) => { if (!acceptedOnce) { acceptedOnce = true; accept(state); } };
        const accepted = new Promise<RunState>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
        const current = await runner.status();
        if (current.state === 'running' || current.state === 'recovery_required') {
          transition = undefined; sendError(res, 409, 'An unfinished job must be recovered first'); return;
        }
        const task = runner.generate(workflows, {
          idempotencyKey: body.id,
          modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
          onAccepted: async state => { acceptOnce(state); await waitForInference(); },
        });
        job = { id: body.id, modelId: typeof body.modelId === 'string' ? body.modelId : undefined, workflows: structuredClone(workflows), accepted, task };
        void task.then(async state => { acceptOnce(state); await updateGate(state); }).catch(async error => {
          if (!acceptedOnce && job?.id === body.id) job = undefined;
          const state = await runner.status().catch(() => undefined);
          await updateGate(state as RunState | undefined).catch(() => { acceptingInference = false; });
          if (!acceptedOnce) reject(new HttpError(409, error instanceof Error ? error.message : String(error)));
        });
        const state = await accepted;
        sendJson(res, state.state === 'complete' ? 200 : 202, { ...publicState(state), inferenceRequests: inFlight, vram: await vram?.read().catch(() => undefined) });
        return;
      }

      if (path === '/cancel' && req.method === 'POST') {
        const body = await readJson(req);
        const current = await runner.status();
        if (record(body) && typeof body.id === 'string' && current.state !== 'idle' && body.id !== current.id) { sendError(res, 409, 'Unknown job ID'); return; }
        void runner.cancel().catch(() => undefined);
        sendJson(res, 202, await stateWithMetrics()); return;
      }
      if (path === '/recover' && req.method === 'POST') {
        const body = await readJson(req);
        const current = await runner.status();
        if (record(body) && typeof body.id === 'string' && current.state !== 'idle' && body.id !== current.id) { sendError(res, 409, 'Unknown job ID'); return; }
        if (transition || runner.isBusy) { sendError(res, 409, 'A GPU operation is already active'); return; }
        transition = 'generation'; acceptingInference = false;
        const task = runner.recover();
        void task.then(async state => updateGate(state)).catch(() => { acceptingInference = false; transition = undefined; });
        sendJson(res, 202, await stateWithMetrics()); return;
      }
      if (path === '/connect' && req.method === 'POST') {
        const body = await readJson(req);
        if (!record(body)) { sendError(res, 400, 'Expected { modelId? }'); return; }
        if (transition || runner.isBusy) { sendError(res, 409, 'A GPU operation is already active'); return; }
        transition = 'model'; acceptingInference = false;
        const task = (async () => {
          const runState = await runner.status();
          if (runState.state === 'running' || runState.state === 'recovery_required') throw new Error('Recover the active generation before connecting a model');
          await waitForInference();
          const modelId = typeof body.modelId === 'string' ? body.modelId : undefined;
          const models = await llama.listModels();
          const target = modelId ? models.find(model => model.name === modelId) : models.find(model => model.status === 'loaded');
          if (target?.status !== 'loaded') {
            const queue = await comfy.queue();
            if (queue.running.length || queue.pending.length) throw new Error('ComfyUI queue is not empty');
            await comfy.free();
            await waitForVramRelease();
          }
          await runner.connect(modelId);
        })();
        void task.then(() => { acceptingInference = true; transition = undefined; }).catch(() => { acceptingInference = false; transition = undefined; });
        await task;
        sendJson(res, 200, { ready: true }); return;
      }

      const llamaPath = path.startsWith('/llama/') ? path.slice('/llama'.length) : undefined;
      if (llamaPath && ['true', '1'].includes(url.searchParams.get('autoload') ?? '')) { sendError(res, 400, 'Router autoload is disabled'); return; }
      if (llamaPath && isInference(llamaPath, req.method ?? 'GET')) { await proxyInference(req, res, `${llamaPath}${url.search}`); return; }
      if (llamaPath && managementPath(llamaPath) && req.method === 'POST') {
        const body = await readJson(req);
        if (!record(body)) { sendError(res, 400, 'Expected a model name'); return; }
        await modelOperation(llamaPath.endsWith('/load') ? 'load' : 'unload', body.model, res); return;
      }
      if (llamaPath && req.method === 'GET' && ['/models', '/models/sse', '/v1/models', '/props', '/health'].includes(llamaPath)) {
        await forward(req, res, config.llamaServerUrl, `${llamaPath}${url.search}`); return;
      }
      if (path.startsWith('/comfy/')) {
        const comfyPath = path.slice('/comfy'.length);
        const allowed = (req.method === 'GET' && ['/object_info', '/view'].includes(comfyPath)) ||
          (req.method === 'POST' && comfyPath === '/upload/image');
        if (!allowed) { sendError(res, 404, 'ComfyUI endpoint is not exposed'); return; }
        await forward(req, res, config.comfyuiUrl, `${comfyPath}${url.search}`); return;
      }
      sendError(res, 404, 'Unknown manager endpoint');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, error instanceof HttpError ? error.status : message.includes('10 MiB') ? 413 : 502, message);
    }
  };

  const server = createServer((req, res) => { void handler(req, res); });
  return {
    server,
    async start() {
      if (!vram) vram = await createVramMonitor({ gpu: config.gpu, pollMs: config.timeouts.pollMs, settleMs: config.timeouts.settleMs });
      const response = await fetchImpl(`${config.llamaServerUrl}/props`, {
        headers: config.llamaApiKey ? { authorization: `Bearer ${config.llamaApiKey}` } : undefined,
        signal: AbortSignal.timeout(config.timeouts.requestMs),
      });
      const props = await readResponse(response);
      if (dependencies.verifyAutoload !== false && (!record(props) || props.models_autoload !== false)) {
        throw new Error('llama-server router must run with --no-models-autoload');
      }
      const state = await runner.status();
      if (state.state === 'running') {
        await runner.markInterrupted();
      }
      const recoveredState = await runner.status();
      acceptingInference = recoveredState.state === 'idle' || ['complete', 'failed', 'cancelled'].includes(recoveredState.state);
      ready = true;
      server.listen(config.listenPort, config.listenHost);
      await once(server, 'listening');
    },
    async close() {
      ready = false;
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function run(): Promise<void> {
  const options = parseManagerArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: pi-comfy-manager [--config FILE] [options]\n\nOptions:\n  --host HOST              Listen address (default 127.0.0.1)\n  --port PORT              Listen port (default 8090)\n  --llama-url URL           llama-server URL (default http://127.0.0.1:8080)\n  --comfy-url URL           ComfyUI URL (default http://127.0.0.1:8188)\n  --state-dir DIR           State directory (default ./.pi-comfy-manager)\n  --gpu SELECTOR            GPU selector for VRAM monitoring\n  --min-free-mib MIB        Required free VRAM in MiB\n  --request-ms MS           HTTP request timeout\n  --model-ms MS              Model operation timeout\n  --settle-ms MS             VRAM settle timeout\n  --poll-ms MS               VRAM polling interval\n  --generation-ms MS         Generation timeout (0 means unlimited)\n  -h, --help                 Show this help\n\nCLI values override JSON values; JSON values override defaults.\nTokens and API keys are read from environment variables.\n`); return;
  }
  const config = loadManagerConfig(options.configFile, process.cwd(), options.overrides);
  const vram = await createVramMonitor({ gpu: config.gpu, pollMs: config.timeouts.pollMs, settleMs: config.timeouts.settleMs });
  const manager = createManager(config, { vram });
  await manager.start();
  process.stdout.write(`VRAM manager listening on ${config.listenHost}:${config.listenPort}\n`);
  const stop = () => { void manager.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void run().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
