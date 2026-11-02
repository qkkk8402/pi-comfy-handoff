import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DirectConfig } from './types.js';

export function apiUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be an HTTP(S) URL`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without embedded credentials, query, or fragment`);
  }
  return url.toString().replace(/\/+$/, '');
}
function integer(value: unknown, fallback: number, name: string): number {
  const number = value ?? fallback;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
export function parseConfig(raw: Record<string, unknown>, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): DirectConfig {
  const timeouts = raw.timeouts;
  if (timeouts !== undefined && (!timeouts || typeof timeouts !== 'object' || Array.isArray(timeouts))) throw new Error('timeouts must be an object');
  const values = (timeouts ?? {}) as Record<string, unknown>;
  const minFreeMiB = raw.minFreeMiB;
  if (minFreeMiB !== undefined && (typeof minFreeMiB !== 'number' || !Number.isSafeInteger(minFreeMiB) || minFreeMiB < 0)) throw new Error('minFreeMiB must be a nonnegative integer');
  return {
    comfyuiUrl: apiUrl(raw.comfyuiUrl ?? 'http://127.0.0.1:8188', 'comfyuiUrl'),
    llamaServerUrl: apiUrl(raw.llamaServerUrl ?? 'http://127.0.0.1:8080', 'llamaServerUrl'),
    outputDir: resolve(cwd, optionalString(raw.outputDir, 'outputDir') ?? 'outputs/comfy'),
    stateDir: resolve(cwd, optionalString(raw.stateDir, 'stateDir') ?? '.pi/comfy-state'),
    llamaModel: optionalString(raw.llamaModel, 'llamaModel'),
    comfyApiKey: env[optionalString(raw.comfyApiKeyEnv, 'comfyApiKeyEnv') ?? 'COMFYUI_API_KEY'],
    llamaApiKey: env[optionalString(raw.llamaApiKeyEnv, 'llamaApiKeyEnv') ?? 'LLAMA_API_KEY'],
    minFreeMiB,
    timeouts: {
      requestMs: integer(values.requestMs, 30_000, 'requestMs'),
      modelMs: integer(values.modelMs, 300_000, 'modelMs'),
      generationMs: integer(values.generationMs, 7_200_000, 'generationMs'),
      settleMs: integer(values.settleMs, 30_000, 'settleMs'),
      pollMs: integer(values.pollMs, 1000, 'pollMs'),
    },
  };
}
export function loadConfig(cwd = process.cwd(), file = resolve(cwd, '.pi/comfyui.json')): DirectConfig {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({}, cwd);
    throw error;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Config must be a JSON object');
  return parseConfig(raw as Record<string, unknown>, cwd);
}
