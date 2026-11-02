import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ManagerConfig } from './types.js';

function positiveInteger(value: unknown, fallback: number, name: string, allowZero = false): number {
  const number = value ?? fallback;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be a ${allowZero ? 'nonnegative' : 'positive'} integer`);
  }
  return number;
}

function endpoint(value: unknown, fallback: string, name: string): string {
  const input = value ?? fallback;
  if (typeof input !== 'string' || !input.trim()) throw new Error(`${name} must be an HTTP(S) URL`);
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function parseManagerConfig(raw: Record<string, unknown>, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): ManagerConfig {
  const timeouts = raw.timeouts;
  if (timeouts !== undefined && (!timeouts || typeof timeouts !== 'object' || Array.isArray(timeouts))) {
    throw new Error('timeouts must be an object');
  }
  const values = (timeouts ?? {}) as Record<string, unknown>;
  const minFreeMiB = raw.minFreeMiB;
  if (minFreeMiB !== undefined && (typeof minFreeMiB !== 'number' || !Number.isSafeInteger(minFreeMiB) || minFreeMiB < 0)) {
    throw new Error('minFreeMiB must be a nonnegative integer');
  }
  const listenHost = raw.listenHost ?? '127.0.0.1';
  if (typeof listenHost !== 'string' || !listenHost.trim()) throw new Error('listenHost must be a hostname or IP address');
  const tokenEnv = raw.tokenEnv ?? 'COMFY_MANAGER_TOKEN';
  if (typeof tokenEnv !== 'string' || !tokenEnv.trim()) throw new Error('tokenEnv must be a nonempty environment variable name');
  const token = env[tokenEnv];
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(listenHost);
  if (!loopback && !token) throw new Error(`Set ${tokenEnv} before binding the manager to a non-loopback address`);
  if (token !== undefined && token.length < 16) throw new Error(`${tokenEnv} must contain at least 16 characters`);
  const gpu = raw.gpu;
  if (gpu !== undefined && (typeof gpu !== 'string' || !gpu.trim())) throw new Error('gpu must be a device selector string');
  return {
    listenHost,
    listenPort: (() => {
      const port = positiveInteger(raw.listenPort, 8090, 'listenPort');
      if (port > 65535) throw new Error('listenPort must be between 1 and 65535');
      return port;
    })(),
    comfyuiUrl: endpoint(raw.comfyuiUrl, 'http://127.0.0.1:8188', 'comfyuiUrl'),
    llamaServerUrl: endpoint(raw.llamaServerUrl, 'http://127.0.0.1:8080', 'llamaServerUrl'),
    stateDir: resolve(cwd, typeof raw.stateDir === 'string' ? raw.stateDir : './.pi-comfy-manager'),
    gpu: gpu as string | undefined,
    minFreeMiB,
    comfyApiKey: env[typeof raw.comfyApiKeyEnv === 'string' ? raw.comfyApiKeyEnv : 'COMFYUI_API_KEY'],
    llamaApiKey: env[typeof raw.llamaApiKeyEnv === 'string' ? raw.llamaApiKeyEnv : 'LLAMA_API_KEY'],
    token,
    timeouts: {
      requestMs: positiveInteger(values.requestMs, 30_000, 'requestMs'),
      modelMs: positiveInteger(values.modelMs, 300_000, 'modelMs'),
      generationMs: positiveInteger(values.generationMs, 0, 'generationMs', true),
      settleMs: positiveInteger(values.settleMs, 30_000, 'settleMs'),
      pollMs: positiveInteger(values.pollMs, 1_000, 'pollMs'),
    },
  };
}

export function loadManagerConfig(file: string | undefined = undefined, cwd = process.cwd(), overrides: Record<string, unknown> = {}): ManagerConfig {
  const target = file ? resolve(file) : resolve(cwd, 'comfy-manager.json');
  let raw: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(target, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Manager config must be a JSON object');
    raw = value as Record<string, unknown>;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || file !== undefined) throw error;
  }
  return parseManagerConfig(mergeManagerConfig(raw, overrides), cwd);
}

export interface ManagerCliOptions {
  help: boolean;
  configFile?: string;
  overrides: Record<string, unknown>;
}

const cliOptions: Record<string, { key: string; type: 'string' | 'number' }> = {
  '--host': { key: 'listenHost', type: 'string' },
  '--port': { key: 'listenPort', type: 'number' },
  '--llama-url': { key: 'llamaServerUrl', type: 'string' },
  '--comfy-url': { key: 'comfyuiUrl', type: 'string' },
  '--state-dir': { key: 'stateDir', type: 'string' },
  '--gpu': { key: 'gpu', type: 'string' },
  '--min-free-mib': { key: 'minFreeMiB', type: 'number' },
  '--request-ms': { key: 'requestMs', type: 'number' },
  '--model-ms': { key: 'modelMs', type: 'number' },
  '--settle-ms': { key: 'settleMs', type: 'number' },
  '--poll-ms': { key: 'pollMs', type: 'number' },
  '--generation-ms': { key: 'generationMs', type: 'number' },
};

export function parseManagerArgs(args: string[]): ManagerCliOptions {
  const result: ManagerCliOptions = { help: false, overrides: {} };
  const timeouts: Record<string, number> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (arg === '--config') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('--config requires a file path');
      result.configFile = value;
      continue;
    }
    const option = Object.hasOwn(cliOptions, arg) ? cliOptions[arg] : undefined;
    if (!option) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (option.type === 'number') {
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${arg} must be a nonnegative integer`);
      if (arg === '--port' && (Number(value) < 1 || Number(value) > 65535)) throw new Error('--port must be between 1 and 65535');
      (arg.endsWith('-ms') ? timeouts : result.overrides)[option.key] = Number(value);
    } else result.overrides[option.key] = value;
  }
  if (Object.keys(timeouts).length) result.overrides.timeouts = timeouts;
  return result;
}

function mergeManagerConfig(raw: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const rawTimeouts = raw.timeouts;
  const overrideTimeouts = overrides.timeouts;
  for (const [name, value] of [['timeouts', rawTimeouts], ['CLI timeouts', overrideTimeouts]] as const) {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`${name} must be an object`);
  }
  const merged = { ...raw, ...overrides };
  if (rawTimeouts !== undefined || overrideTimeouts !== undefined) {
    merged.timeouts = { ...(rawTimeouts as Record<string, unknown> | undefined), ...(overrideTimeouts as Record<string, unknown> | undefined) };
  }
  return merged;
}
