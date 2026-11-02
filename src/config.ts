import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export interface ClientConfig {
  managerUrl: string;
  outputDir: string;
  stateDir: string;
  apiKey?: string;
  timeouts: { requestMs: number; pollMs: number };
}

export function apiUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be an HTTP(S) URL`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without embedded credentials, query, or fragment`);
  }
  return url.toString().replace(/\/+$/, '');
}

/** Return the llama.cpp native API URL that belongs to this manager, if it matches exactly. */
export function matchingLlamaUrl(managerUrl: string, value: unknown, providerBaseUrl = false): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    let expected = new URL(`${apiUrl(managerUrl, 'Manager URL')}/llama`);
    let actual = new URL(apiUrl(value, 'llama.cpp URL'));
    if (providerBaseUrl) {
      if (!actual.pathname.endsWith('/v1')) return false;
      actual.pathname = actual.pathname.slice(0, -3).replace(/\/$/, '');
    }
    expected.pathname = expected.pathname.replace(/\/$/, '');
    actual.pathname = actual.pathname.replace(/\/$/, '');
    return expected.origin === actual.origin && expected.pathname === actual.pathname;
  } catch { return false; }
}

function integer(value: unknown, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer`);
  return result;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}

export function parseConfig(raw: Record<string, unknown>, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const timeouts = raw.timeouts;
  if (timeouts !== undefined && (!timeouts || typeof timeouts !== 'object' || Array.isArray(timeouts))) throw new Error('timeouts must be an object');
  const values = (timeouts ?? {}) as Record<string, unknown>;
  const apiKeyEnv = optionalString(raw.apiKeyEnv, 'apiKeyEnv') ?? 'COMFY_MANAGER_TOKEN';
  return {
    managerUrl: apiUrl(raw.managerUrl ?? 'http://127.0.0.1:8090', 'managerUrl'),
    outputDir: resolve(cwd, optionalString(raw.outputDir, 'outputDir') ?? 'outputs/comfy'),
    stateDir: resolve(cwd, optionalString(raw.stateDir, 'stateDir') ?? '.pi/comfy-state'),
    apiKey: env[apiKeyEnv],
    timeouts: {
      requestMs: integer(values.requestMs, 30_000, 'requestMs'),
      pollMs: integer(values.pollMs, 1000, 'pollMs'),
    },
  };
}

export function loadConfig(cwd = process.cwd(), file = resolve(cwd, '.pi/comfyui.json')): ClientConfig {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({}, cwd);
    throw error;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Config must be a JSON object');
  return parseConfig(raw as Record<string, unknown>, cwd);
}

export async function saveManagerUrl(cwd: string, managerUrl: unknown): Promise<void> {
  const file = resolve(cwd, '.pi/comfyui.json');
  const manager = apiUrl(managerUrl, 'Manager URL');
  let raw: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Config must be a JSON object');
    raw = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const data = `${JSON.stringify({ ...raw, managerUrl: manager }, null, 2)}\n`;
  await mkdir(resolve(cwd, '.pi'), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}
