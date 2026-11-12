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
import { errorCode, ManagerLogger, safeEndpoint, type LogSink } from './logger.js';
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
  logSink?: LogSink;
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

function isInference(path: string, method: string): boolean {
  return method === 'POST' && ['/v1/chat/completions', '/v1/completions', '/completion'].includes(path);
}

function managementPath(path: string): boolean {
  return path === '/models/load' || path === '/models/unload';
}

function storedWorkflowPath(encoded: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); } catch { return undefined; }
  // ComfyUI unquotes its userdata path again. Reject percent signs to prevent
  // double-encoded traversal and keep the only exposed directory unambiguous.
  if (decoded.includes('%') || decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  const parts = decoded.split('/');
  if (parts[0] !== 'workflows' || parts.length < 2 || parts.some(part => !part || part === '.' || part === '..')) return undefined;
  if (!parts.at(-1)?.endsWith('.json')) return undefined;
  return decoded;
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
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const logger = new ManagerLogger(config.logLevel ?? 'info', dependencies.logSink);
  const timers = new Set<NodeJS.Timeout>();
  const redactClientError = (error: unknown): string => {
    let detail = error instanceof Error ? error.message : String(error);
    for (const secret of [config.token, config.comfyApiKey, config.llamaApiKey]) {
      if (secret) detail = detail.split(secret).join('[redacted]');
    }
    return detail.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\r\n\t]+/g, ' ').slice(0, 1000);
  };
  const safeError = (error: unknown): string => {
    const shaped = error as { name?: unknown; status?: unknown; messages?: unknown; body?: unknown } | null;
    if (shaped && (shaped.name === 'ComfyJobError' || shaped.name === 'ComfyHttpError')) {
      return shaped.name === 'ComfyJobError' ? 'ComfyUI generation failed' : `ComfyUI returned HTTP ${typeof shaped.status === 'number' ? shaped.status : 'error'}`;
    }
    if (shaped && shaped.name === 'LlamaRouterError' && typeof shaped.status === 'number') return `llama-server returned HTTP ${shaped.status}`;
    let detail = error instanceof Error ? error.message : String(error);
    const comfyHttp = detail.match(/ComfyUI (\/\S+) returned HTTP (\d+):/i);
    if (comfyHttp) return `ComfyUI ${comfyHttp[1]} returned HTTP ${comfyHttp[2]}`;
    const llamaHttp = detail.match(/(GET|POST|PUT|DELETE) (\/\S+) failed \((\d+)\):/i);
    if (llamaHttp) return `llama-server ${llamaHttp[1]} ${llamaHttp[2]} returned HTTP ${llamaHttp[3]}`;
    if (/ComfyUI job .* failed:/i.test(detail)) return 'ComfyUI generation failed';
    detail = detail.replace(/Upstream returned HTTP (\d+):[\s\S]*/i, 'Upstream returned HTTP $1');
    return redactClientError(detail).slice(0, 240) || errorCode(error);
  };
  const comfy = dependencies.comfy ?? new ComfyClient(config.comfyuiUrl, {
    requestMs: config.timeouts.requestMs, generationMs: config.timeouts.generationMs,
    pollMs: config.timeouts.pollMs, settleMs: config.timeouts.settleMs,
    outputDir: undefined, apiKey: config.comfyApiKey, dedicatedServer: true,
  }) as ComfyClient & ComfyAdapter;
  const llama = dependencies.llama ?? new LlamaRouterClient(config.llamaServerUrl, {
    requestMs: config.timeouts.requestMs, modelMs: config.timeouts.modelMs, pollMs: config.timeouts.pollMs,
    apiKey: config.llamaApiKey,
    onDiagnostic: message => logger.log('debug', `llama ${message}`),
  }) as LlamaRouterClient & LlamaAdapter;
  let vram = dependencies.vram;
  const waitForVramRelease = async (minFreeMiB?: number): Promise<void> => {
    logger.log('info', `VRAM release wait begin mode=${minFreeMiB === undefined ? 'stability-only' : `minimum-free minFreeMiB=${minFreeMiB}`}`);
    let sampling = false;
    const sampleTimer = setInterval(() => {
      if (sampling || !vram || config.logLevel !== 'debug') return;
      sampling = true;
      void vram.read().then(value => logger.log('debug', `VRAM release wait sample ${JSON.stringify(value)}`)).catch(() => undefined).finally(() => { sampling = false; });
    }, 5_000);
    timers.add(sampleTimer);
    sampleTimer.unref();
    try {
      const sample = await vram?.read();
      if (sample) { logger.log('debug', `VRAM before release ${JSON.stringify(sample)}`); await vram!.waitForRelease(minFreeMiB); }
      else await comfy.waitForRelease?.(minFreeMiB);
      const after = await vram?.read().catch(() => undefined);
      if (after) logger.log('debug', `VRAM after release ${JSON.stringify(after)}`);
      logger.log('info', 'VRAM release wait end');
    } catch (error) { logger.log('error', `VRAM release wait failed: ${safeError(error)}`); throw error; }
    finally { clearInterval(sampleTimer); timers.delete(sampleTimer); }
  };
  const runner = new Runner(config, { comfy, llama, waitForVramRelease, onState: state => {
    const detail = state.error ? ` error=${safeError(state.error)}` : '';
    logger.log(state.error ? 'error' : 'info', `run=${state.id} state=${state.state} phase=${state.phase} model=${state.model ?? 'unknown'} completed=${state.completed}${state.index === undefined ? '' : ` workflow=${state.index + 1}`}${detail}`);
  } });
  let acceptingInference = true;
  let inFlight = 0;
  let transition: 'generation' | 'model' | undefined;
  const getTransition = (): 'generation' | 'model' | undefined => transition;
  let modelOperationState: { operation: 'load' | 'unload'; model: string; state: 'accepted' | 'running' | 'complete' | 'failed'; phase: string; startedAt: number; elapsedMs: number; error?: string } | undefined;
  let ready = false;
  let job: { id: string; modelId?: string; workflows: Workflow[]; accepted: Promise<RunState>; task: Promise<RunState> } | undefined;
  let drainResolver: (() => void) | undefined;

  const waitForInference = async (): Promise<void> => {
    while (inFlight > 0) await new Promise<void>(resolve => { drainResolver = resolve; });
  };
  const activeOperationDetail = (): string => transition === 'model' && modelOperationState
    ? `model "${modelOperationState.model}" phase=${modelOperationState.phase} elapsed=${Math.floor((Date.now() - modelOperationState.startedAt) / 1000)}s`
    : `${transition ?? 'GPU'} operation is active`;
  const endInference = (): void => {
    inFlight--;
    if (inFlight === 0) { drainResolver?.(); drainResolver = undefined; }
  };
  const stateWithMetrics = async (): Promise<unknown> => {
    const state = await runner.status();
    let sample: unknown = { source: 'comfyui', available: false };
    try { sample = await vram?.read() ?? sample; }
    catch (error) { sample = { source: 'host', error: error instanceof Error ? error.message : 'VRAM telemetry unavailable' }; }
    const operation = modelOperationState ? { ...modelOperationState, elapsedMs: modelOperationState.state === 'complete' || modelOperationState.state === 'failed' ? modelOperationState.elapsedMs : Date.now() - modelOperationState.startedAt } : undefined;
    return { ...publicState(state), inferenceRequests: inFlight, vram: sample, managerPhase: transition ?? (acceptingInference ? 'llm_ready' : 'paused'), ...(operation ? { modelOperation: operation } : {}) };
  };
  const updateGate = async (state?: RunState): Promise<void> => {
    const current = state ?? await runner.status();
    const wasAccepting = acceptingInference;
    acceptingInference = ['complete', 'failed', 'cancelled', 'idle'].includes(current.state);
    transition = undefined;
    if (wasAccepting !== acceptingInference) logger.log('info', `inference ${acceptingInference ? 'resumed' : 'paused'} run=${'id' in current ? current.id : 'none'} state=${current.state}`);
  };
  const forward = async (req: IncomingMessage, res: ServerResponse, base: string, path: string, keepReading = false, rawBody?: string): Promise<void> => {
    const headers = new Headers();
    for (const name of ['accept', 'content-type', 'range']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    if (base === config.llamaServerUrl && config.llamaApiKey) headers.set('authorization', `Bearer ${config.llamaApiKey}`);
    if (base === config.comfyuiUrl && config.comfyApiKey) headers.set('authorization', `Bearer ${config.comfyApiKey}`);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const streamedBody = hasBody && rawBody === undefined;
    const body = rawBody ?? (streamedBody ? Readable.toWeb(req) as ReadableStream<Uint8Array> : undefined);
    let response: Response;
    const upstreamUrl = withPrefix(base, path);
    try {
      response = await fetchImpl(upstreamUrl, {
        method: req.method,
        headers,
        body,
        ...(streamedBody ? { duplex: 'half' } as RequestInit : {}),
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
      sendError(res, 503, `LLM inference is paused while GPU models are switching${transition ? ` (${activeOperationDetail()})` : ''}`);
      return;
    }
    inFlight++;
    try { await forward(req, res, config.llamaServerUrl, path, true); }
    finally { endInference(); }
  };

  const modelOperation = async (operation: 'load' | 'unload', name: unknown, res: ServerResponse): Promise<void> => {
    if (typeof name !== 'string' || !name.trim()) { sendError(res, 400, 'model is required'); return; }
    if (transition || runner.isBusy) { sendError(res, 409, `Cannot ${operation} llama.cpp model "${name}": ${activeOperationDetail()}`); return; }
    transition = 'model'; acceptingInference = false;
    const startedAt = Date.now();
    const op: NonNullable<typeof modelOperationState> = modelOperationState = { operation, model: name, state: 'accepted', phase: 'preparing', startedAt, elapsedMs: 0 };
    const log = (level: 'info' | 'error', phase: string, detail = '') => {
      op.phase = phase;
      logger.log(level, `model ${operation} model=${name} state=${op.state} phase=${phase} elapsed=${Math.floor((Date.now() - startedAt) / 1000)}s${detail ? ` ${detail}` : ''}`);
    };
    if (operation === 'unload') {
      try {
        const runState = await runner.status();
        if (runState.state === 'running' || runState.state === 'recovery_required') throw new Error('Recover the active generation before changing models');
        const models = await llama.listModels();
        if (!models.some(model => model.name === name)) throw new Error(`llama-server model not found: ${name}`);
        op.state = 'running'; log('info', 'llama_unload');
        await waitForInference(); await llama.unload(name);
        op.state = 'complete'; op.phase = 'unloaded'; op.elapsedMs = Date.now() - startedAt;
        acceptingInference = true; transition = undefined; sendJson(res, 200, { success: true, model: name, status: 'unloaded' });
      } catch (error) {
        op.state = 'failed'; op.elapsedMs = Date.now() - startedAt; op.error = redactClientError(error);
        acceptingInference = false; transition = undefined; log('error', 'failed', `error=${safeError(error)}`);
        sendError(res, 409, `Cannot unload llama.cpp model: ${op.error}`);
      }
      return;
    }
    // Reading the local run journal is a bounded preflight. Preserve the existing
    // recovery guard before acknowledging a model load, and check the reservation
    // again after the await because another operation may have won the race.
    let runState: Awaited<ReturnType<typeof runner.status>>;
    try { runState = await runner.status(); }
    catch (error) {
      transition = undefined; acceptingInference = false;
      op.state = 'failed'; op.phase = 'validation'; op.elapsedMs = Date.now() - startedAt; op.error = redactClientError(error);
      sendError(res, 502, `Cannot load llama.cpp model: ${op.error}`); return;
    }
    if (transition !== 'model' || modelOperationState !== op) { sendError(res, 409, `Cannot load llama.cpp model "${name}": ${activeOperationDetail()}`); return; }
    if (runState.state === 'running' || runState.state === 'recovery_required') {
      transition = undefined; acceptingInference = false;
      op.state = 'failed'; op.phase = 'validation'; op.elapsedMs = Date.now() - startedAt; op.error = 'Recover the active generation before changing models';
      sendError(res, 409, op.error); return;
    }
    sendJson(res, 202, { success: true, model: name, status: 'accepted', operation, modelOperation: { state: op.state, phase: op.phase } });
    const heartbeat = setInterval(() => log('info', op.phase), 10_000);
    heartbeat.unref(); timers.add(heartbeat);
    void (async () => {
      try {
        op.state = 'running';
        log('info', 'validating');
        const runState = await runner.status();
        if (runState.state === 'running' || runState.state === 'recovery_required') throw new Error('Recover the active generation before changing models');
        const models = await llama.listModels();
        const target = models.find(model => model.name === name);
        if (!target) throw new Error(`llama-server model not found: ${name}`);
        if (models.some(model => model.name !== target.name && model.status !== 'unloaded')) throw new Error('Other llama-server models are resident');
        if (target.status !== 'loaded') {
          const queue = await comfy.queue();
          if (queue.running.length || queue.pending.length) throw new Error('ComfyUI queue is not empty');
        }
        log('info', 'waiting_for_inference');
        await waitForInference();
        if (target.status !== 'loaded') {
          log('info', 'freeing_comfyui'); await comfy.free();
          log('info', 'waiting_for_vram'); await waitForVramRelease();
        }
        log('info', `llama_${operation}`); await llama[operation](name);
        op.state = 'complete'; op.phase = operation === 'load' ? 'loaded' : 'unloaded'; op.elapsedMs = Date.now() - startedAt;
        acceptingInference = true; transition = undefined; log('info', 'complete');
      } catch (error) {
        op.state = 'failed'; op.elapsedMs = Date.now() - startedAt; op.error = redactClientError(error);
        acceptingInference = false; transition = undefined; log('error', op.phase, `error=${safeError(error)}`);
      } finally { clearInterval(heartbeat); timers.delete(heartbeat); }
    })();
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      if (!authMatches(req, config.token)) { sendError(res, 401, 'Bearer token required'); return; }
      if (path === '/health' && req.method === 'GET') { sendJson(res, ready ? 200 : 503, { ready }); return; }
      if (path === '/status' && req.method === 'GET') { sendJson(res, 200, await stateWithMetrics()); return; }

      if (path === '/workflows' && req.method === 'GET') {
        if (url.search) { sendError(res, 400, 'Workflow listing does not accept options'); return; }
        await forward(req, res, config.comfyuiUrl, '/userdata?dir=workflows&recurse=true'); return;
      }
      if (path.startsWith('/workflows/')) {
        const workflowPath = storedWorkflowPath(path.slice('/workflows/'.length));
        if (!workflowPath) { sendError(res, 400, 'Workflow path must be a .json file under workflows/'); return; }
        if (req.method === 'GET' && !url.search) {
          await forward(req, res, config.comfyuiUrl, `/userdata/${encodeURIComponent(workflowPath)}`); return;
        }
        if (req.method === 'POST') {
          const overwriteValues = url.searchParams.getAll('overwrite');
          if ([...url.searchParams.keys()].length !== 1 || overwriteValues.length !== 1 || !['true', 'false'].includes(overwriteValues[0]!)) {
            sendError(res, 400, 'POST requires exactly one overwrite=true or overwrite=false option'); return;
          }
          let body: unknown;
          try { body = await readJson(req); }
          catch (error) {
            if (error instanceof Error && error.message.includes('10 MiB')) throw new HttpError(413, error.message);
            throw new HttpError(400, 'Workflow body must be valid JSON');
          }
          if (!record(body)) { sendError(res, 400, 'Workflow body must be a JSON object'); return; }
          await forward(req, res, config.comfyuiUrl, `/userdata/${encodeURIComponent(workflowPath)}?overwrite=${overwriteValues[0]}`, false, JSON.stringify(body)); return;
        }
        sendError(res, 405, 'Method not allowed'); return;
      }

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
        if (transition || runner.isBusy) { sendError(res, 409, `A GPU operation is already active (${activeOperationDetail()})`); return; }
        modelOperationState = undefined;
        transition = 'generation'; acceptingInference = false;
        logger.log('info', `inference paused run=${body.id}`);
        let accept!: (state: RunState) => void;
        let reject!: (error: unknown) => void;
        let acceptedOnce = false;
        const acceptOnce = (state: RunState) => { if (!acceptedOnce) { acceptedOnce = true; accept(state); } };
        const accepted = new Promise<RunState>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
        const current = await runner.status();
        if (current.state === 'running' || current.state === 'recovery_required') {
          transition = undefined; sendError(res, 409, 'An unfinished job must be recovered first'); return;
        }
        let lastProgressLog = 0;
        const task = runner.generate(workflows, {
          idempotencyKey: body.id,
          modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
          onProgress: value => {
            const now = Date.now();
            if (now - lastProgressLog < 1_000) return;
            lastProgressLog = now;
            if (config.logLevel === 'debug') {
              const data = record(value) ? value : {};
              const numeric = ['value', 'max', 'progress', 'percentage', 'elapsedMs'].flatMap(key => typeof data[key] === 'number' ? [`${key}=${data[key]}`] : []);
              const state = ['running', 'executing', 'success', 'complete', 'failed'].includes(String(data.state)) ? `state=${data.state}` : '';
              logger.log('debug', `generation progress run=${body.id}${state ? ` ${state}` : ''}${numeric.length ? ` ${numeric.join(' ')}` : ''}`);
            }
          },
          onAccepted: async state => {
            logger.log('info', `generation accepted run=${state.id} workflows=${workflows.length} model=${state.model ?? 'default'}`);
            acceptOnce(state);
            await waitForInference();
          },
        });
        job = { id: body.id, modelId: typeof body.modelId === 'string' ? body.modelId : undefined, workflows: structuredClone(workflows), accepted, task };
        const startedAt = Date.now();
        const heartbeat = setInterval(() => {
          void (async () => {
            const sample = await vram?.read().catch(() => undefined);
            const mem = record(sample) ? Object.entries(sample).filter(([key, value]) => /free|used|total/i.test(key) && typeof value === 'number').map(([key, value]) => `${key}=${value}`).join(' ') : '';
            logger.log('info', `generation heartbeat run=${body.id} elapsed=${Math.floor((Date.now() - startedAt) / 1000)}s${mem ? ` ${mem}` : ''}`);
          })().catch(() => undefined);
        }, 30_000);
        heartbeat.unref();
        timers.add(heartbeat);
        void task.finally(() => { clearInterval(heartbeat); timers.delete(heartbeat); }).catch(() => undefined);
        void task.then(async state => { acceptOnce(state); await updateGate(state); }).catch(async error => {
          logger.log('error', `generation failed run=${body.id}: ${safeError(error)}`);
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
        if (getTransition() === 'model') { sendError(res, 409, 'Cannot cancel while a model operation is active'); return; }
        const current = await runner.status();
        // A model operation can reserve the gate while status() reads the journal.
        if (getTransition() === 'model') { sendError(res, 409, 'Cannot cancel while a model operation is active'); return; }
        if (record(body) && typeof body.id === 'string' && current.state !== 'idle' && body.id !== current.id) { sendError(res, 409, 'Unknown job ID'); return; }
        // For cancellation of a persisted run after restart, hold the GPU gate
        // until cleanup is confirmed. Active generation already owns its gate.
        const ownsGate = !runner.isBusy && !transition;
        if (ownsGate) { transition = 'generation'; acceptingInference = false; }
        logger.log('info', 'cancellation requested');
        void runner.cancel().then(async () => {
          // A standalone cancellation can finish recovery and restore the LLM.
          // Active generation owns its gate transition and will update it in its task handler.
          if (ownsGate && transition === 'generation') await updateGate();
        }).catch(error => {
          logger.log('error', `cancellation failed: ${safeError(error)}`);
          if (ownsGate && transition === 'generation') { acceptingInference = false; transition = undefined; }
        });
        sendJson(res, 202, await stateWithMetrics()); return;
      }
      if (path === '/recover' && req.method === 'POST') {
        const body = await readJson(req);
        const current = await runner.status();
        if (record(body) && typeof body.id === 'string' && current.state !== 'idle' && body.id !== current.id) { sendError(res, 409, 'Unknown job ID'); return; }
        if (transition || runner.isBusy) { sendError(res, 409, `A GPU operation is already active (${activeOperationDetail()})`); return; }
        modelOperationState = undefined;
        transition = 'generation'; acceptingInference = false;
        logger.log('info', `recovery begin run=${current.state === 'idle' ? 'none' : current.id}`);
        const task = runner.recover();
        void task.then(async state => { logger.log('info', `recovery complete run=${state.id} state=${state.state}`); await updateGate(state); }).catch(error => { logger.log('error', `recovery failed: ${safeError(error)}`); acceptingInference = false; transition = undefined; });
        sendJson(res, 202, await stateWithMetrics()); return;
      }
      if (path === '/connect' && req.method === 'POST') {
        const body = await readJson(req);
        if (!record(body)) { sendError(res, 400, 'Expected { modelId? }'); return; }
        if (transition || runner.isBusy) { sendError(res, 409, `A GPU operation is already active (${activeOperationDetail()})`); return; }
        modelOperationState = undefined;
        transition = 'model'; acceptingInference = false;
        logger.log('info', 'model connect begin; inference paused');
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
        void task.then(() => { logger.log('info', 'model connect complete'); acceptingInference = true; transition = undefined; }).catch(error => { logger.log('error', `model connect failed: ${safeError(error)}`); acceptingInference = false; transition = undefined; });
        await task;
        sendJson(res, 200, { ready: true }); return;
      }

      const llamaPath = path.startsWith('/llama/') ? path.slice('/llama'.length) : undefined;
      if (llamaPath && ['true', '1'].includes(url.searchParams.get('autoload') ?? '')) { sendError(res, 400, 'Router autoload is disabled'); return; }
      if (llamaPath === '/models/sse' && req.method === 'GET') {
        sendError(res, 501, 'Model status SSE is unavailable through the manager; use the model catalog polling endpoint'); return;
      }
      if (llamaPath && isInference(llamaPath, req.method ?? 'GET')) { await proxyInference(req, res, `${llamaPath}${url.search}`); return; }
      if (llamaPath && managementPath(llamaPath) && req.method === 'POST') {
        const body = await readJson(req);
        if (!record(body)) { sendError(res, 400, 'Expected a model name'); return; }
        await modelOperation(llamaPath.endsWith('/load') ? 'load' : 'unload', body.model, res); return;
      }
      if (llamaPath === '/models' && req.method === 'GET' && modelOperationState && (
        ['accepted', 'running'].includes(modelOperationState.state) || (modelOperationState.state === 'failed' && modelOperationState.operation === 'load')
      )) {
        const operation = modelOperationState;
        const upstream = await fetchImpl(withPrefix(config.llamaServerUrl, `${llamaPath}${url.search}`), { headers: config.llamaApiKey ? { authorization: `Bearer ${config.llamaApiKey}` } : undefined, redirect: 'error' });
        const raw = await upstream.text();
        if (!upstream.ok) { res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }); res.end(raw); return; }
        let payload: any;
        try { payload = JSON.parse(raw); } catch { throw new Error('llama-server returned invalid model catalog JSON'); }
        const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : payload?.data;
        if (!Array.isArray(rows)) throw new Error('llama-server returned no model catalog');
        if (modelOperationState !== operation) { sendJson(res, 200, payload); return; }
        const existing = rows.find((row: any) => (row?.name ?? row?.id) === operation.model);
        const status = operation.state === 'failed' ? 'unloaded' : operation.operation === 'load' ? 'loading' : 'unloading';
        if (!existing) rows.push({ id: operation.model, name: operation.model, status: { value: status } });
        const target = existing ?? rows[rows.length - 1];
        const nestedStatus = typeof target.status === 'object' && target.status ? { ...target.status } : { value: status };
        nestedStatus.value = status;
        delete nestedStatus.failed; delete nestedStatus.exit_code; delete nestedStatus.error;
        if (operation.state === 'failed') nestedStatus.failed = true;
        target.status = nestedStatus;
        target.manager_operation = { operation: operation.operation, state: operation.state, phase: operation.phase, elapsedMs: operation.state === 'failed' ? operation.elapsedMs : Date.now() - operation.startedAt, ...(operation.error ? { error: operation.error } : {}) };
        if (operation.error) target.manager_error = operation.error;
        sendJson(res, 200, payload); return;
      }
      if (llamaPath && req.method === 'GET' && ['/models', '/v1/models', '/props', '/health'].includes(llamaPath)) {
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
      logger.log('error', `request failed: ${safeError(error)}`);
      sendError(res, error instanceof HttpError ? error.status : message.includes('10 MiB') ? 413 : 502, redactClientError(error));
    }
  };

  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const requestedPath = (req.url ?? '/').split('?')[0]!;
    const safePaths = new Set(['/health', '/status', '/generate', '/cancel', '/recover', '/connect', '/workflows', '/llama/v1/chat/completions', '/llama/v1/completions', '/llama/completion', '/llama/models', '/llama/models/sse', '/llama/v1/models', '/llama/props', '/llama/health', '/llama/models/load', '/llama/models/unload', '/comfy/object_info', '/comfy/view', '/comfy/upload/image']);
    const path = safePaths.has(requestedPath) ? requestedPath : requestedPath.startsWith('/workflows/') ? '/workflows/<file>' : '<unknown>';
    void handler(req, res).finally(() => logger.log('debug', `http ${req.method ?? 'GET'} ${path} status=${res.statusCode} duration=${Date.now() - startedAt}ms`));
  });
  return {
    server,
    async start() {
      logger.log('info', `manager starting listen=${config.listenHost}:${config.listenPort} llama=${safeEndpoint(config.llamaServerUrl)} comfyui=${safeEndpoint(config.comfyuiUrl)}`);
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
      const boundAddress = server.address();
      logger.log('info', `manager ready listen=${config.listenHost}:${boundAddress && typeof boundAddress !== 'string' ? boundAddress.port : config.listenPort}`);
    },
    async close() {
      logger.log('info', 'manager shutting down');
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      ready = false;
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function run(): Promise<void> {
  const options = parseManagerArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: pi-comfy-manager [--config FILE] [options]\n\nOptions:\n  --host HOST              Listen address (default 127.0.0.1)\n  --port PORT              Listen port (default 8090)\n  --llama-url URL           llama-server URL (default http://127.0.0.1:8080)\n  --comfy-url URL           ComfyUI URL (default http://127.0.0.1:8188)\n  --state-dir DIR           State directory (default ./.pi-comfy-manager)\n  --gpu SELECTOR            GPU selector for VRAM monitoring\n  --min-free-mib MIB        Required free VRAM in MiB\n  --request-ms MS           HTTP request timeout\n  --model-ms MS              Model operation timeout\n  --settle-ms MS             VRAM settle timeout\n  --poll-ms MS               VRAM polling interval\n  --generation-ms MS         Generation timeout (0 means unlimited)\n  --log-level LEVEL          Log level: silent, error, info, debug (default info)\n  -h, --help                 Show this help\n\nCLI values override JSON values; JSON values override defaults.\nTokens and API keys are read from environment variables.\n`); return;
  }
  const config = loadManagerConfig(options.configFile, process.cwd(), options.overrides);
  const vram = await createVramMonitor({ gpu: config.gpu, pollMs: config.timeouts.pollMs, settleMs: config.timeouts.settleMs });
  const manager = createManager(config, { vram });
  await manager.start();
  const stop = () => { void manager.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void run().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
