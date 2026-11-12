import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ClientConfig } from './config.js';
import type { Workflow } from './types.js';

export interface OutputRef { nodeId: string; filename: string; subfolder: string; type: string }
export interface RunState {
  id?: string;
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled' | 'recovery_required';
  phase?: string;
  completed?: Array<{ promptId: string; outputs: OutputRef[] }>;
  error?: string;
  [key: string]: unknown;
}
export interface GenerateRequest { id: string; modelId?: string; workflows: Workflow[] }

export class ManagerHttpError extends Error {
  constructor(readonly status: number, message: string, method = 'GET', endpoint = 'VRAM manager') {
    super(`${method} ${endpoint} returned HTTP ${status}: ${message}`);
  }
}

export class ManagerConnectionError extends TypeError {
  constructor(message: string) { super(message); this.name = 'ManagerConnectionError'; }
}

function errorMessage(value: any, fallback: string): string {
  const error = value?.error;
  const message = typeof error === 'string' ? error
    : typeof error?.message === 'string' ? error.message
      : typeof value?.message === 'string' ? value.message : fallback;
  return message.slice(0, 1000);
}

function endpointLabel(baseUrl: string, path: string): string {
  const url = new URL(`${baseUrl}${path}`);
  return `${url.origin}${url.pathname}`;
}

export class ManagerClient {
  readonly baseUrl: string;
  constructor(readonly config: ClientConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = config.managerUrl;
  }

  setApiKey(apiKey: string | undefined): void {
    this.config.apiKey = apiKey;
  }

  async status(): Promise<RunState> {
    const value = await this.json('/status');
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.state !== 'string') {
      throw new Error('VRAM manager /status returned an invalid state');
    }
    return value as RunState;
  }

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<RunState> {
    return await this.json('/generate', { method: 'POST', body: JSON.stringify(request), signal }) as RunState;
  }

  async cancel(id?: string): Promise<RunState> {
    return await this.json('/cancel', { method: 'POST', body: JSON.stringify(id ? { id } : {}) }) as RunState;
  }

  async recover(id?: string): Promise<RunState> {
    return await this.json('/recover', { method: 'POST', body: JSON.stringify(id ? { id } : {}) }) as RunState;
  }

  async connect(modelId?: string): Promise<unknown> {
    return await this.json('/connect', { method: 'POST', body: JSON.stringify(modelId ? { modelId } : {}) });
  }

  async listWorkflows(): Promise<string[]> {
    const value = await this.json('/workflows');
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      throw new Error('VRAM manager /workflows returned an invalid workflow list; expected an array of strings');
    }
    const paths: string[] = [];
    for (const name of value as string[]) {
      const path = `workflows/${name}`;
      const components = path.split('/');
      if (!path.endsWith('.json') || components[0] !== 'workflows' || components.length < 2 ||
          components.some(part => !part || part === '.' || part === '..' || part.includes('%') || part.includes('\\') || /[\u0000-\u001f\u007f]/.test(part))) continue;
      paths.push(path);
    }
    return paths;
  }

  async getWorkflow(path: string): Promise<unknown> {
    return await this.json(`/workflows/${encodeURIComponent(path)}`);
  }

  async saveWorkflow(path: string, workflow: unknown, overwrite: boolean): Promise<unknown> {
    return await this.json(`/workflows/${encodeURIComponent(path)}?overwrite=${overwrite}`, {
      method: 'POST', body: JSON.stringify(workflow),
    });
  }

  async statePath(): Promise<string> {
    const path = join(this.config.stateDir, 'manager-run.json');
    await mkdir(dirname(path), { recursive: true });
    return path;
  }

  async saveLocalRun(value: unknown): Promise<void> {
    const path = await this.statePath();
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  }

  async readLocalRun<T>(): Promise<T | undefined> {
    const path = await this.statePath();
    try { return JSON.parse(await readFile(path, 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async clearLocalRun(): Promise<void> {
    const path = await this.statePath();
    await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }

  private async json(path: string, init: RequestInit = {}): Promise<any> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeouts.requestMs);
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body && !headers.has('content-type') && typeof init.body === 'string') headers.set('content-type', 'application/json');
    if (this.config.apiKey) headers.set('authorization', `Bearer ${this.config.apiKey}`);
    const external = init.signal;
    const onAbort = () => controller.abort(external?.reason);
    if (external?.aborted) onAbort(); else external?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, redirect: 'error', signal: controller.signal });
      const body = await response.text();
      let value: any;
      try { value = body ? JSON.parse(body) : undefined; }
      catch {
        if (!response.ok) throw new ManagerHttpError(response.status, body.slice(0, 1000) || response.statusText, init.method ?? 'GET', endpointLabel(this.baseUrl, path));
        throw new Error(`VRAM manager ${path} returned invalid JSON`);
      }
      if (!response.ok) throw new ManagerHttpError(response.status, errorMessage(value, body || response.statusText), init.method ?? 'GET', endpointLabel(this.baseUrl, path));
      return value;
    } catch (error) {
      if (external?.aborted) throw external.reason ?? error;
      if (timedOut) throw new ManagerConnectionError(`Request to VRAM manager at ${endpointLabel(this.baseUrl, path)} timed out after ${this.config.timeouts.requestMs}ms. Check manager availability and network latency.`);
      if (!(error instanceof ManagerHttpError) && error instanceof TypeError) {
        const detail = error.message.slice(0, 300);
        const code = (error as TypeError & { cause?: NodeJS.ErrnoException }).cause?.code;
        throw new ManagerConnectionError(`Cannot reach VRAM manager at ${endpointLabel(this.baseUrl, path)}${code ? ` (${code})` : ''}: ${detail}. Check that the manager is running and the URL, port, and network are correct.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }
}
