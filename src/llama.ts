import type { LlamaAdapter, ModelState } from './types.js';

export interface LlamaRouterOptions {
  requestMs?: number;
  modelMs?: number;
  pollMs?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class LlamaRouterError extends Error {
  override name = 'LlamaRouterError';
}

/** llama-server router API. Model operations wait for the exact terminal state. */
export class LlamaRouterClient implements LlamaAdapter {
  private readonly baseUrl: string;
  private readonly requestMs: number;
  private readonly modelMs: number;
  private readonly pollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: HeadersInit;

  constructor(baseUrl: string, options: LlamaRouterOptions = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('llama-server URL must be HTTP(S) without credentials, query, or fragment');
    }
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.requestMs = options.requestMs ?? 10_000;
    this.modelMs = options.modelMs ?? 300_000;
    this.pollMs = options.pollMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = {
      accept: 'application/json',
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    };
    for (const [key, value] of Object.entries({ requestMs: this.requestMs, modelMs: this.modelMs, pollMs: this.pollMs })) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${key} must be a positive number`);
    }
  }

  async listModels(): Promise<ModelState[]> {
    const data = await this.request('/models');
    const records = Array.isArray(data) ? data : data.models ?? data.data;
    if (!Array.isArray(records)) throw new LlamaRouterError('GET /models returned no models array');
    return records.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object') throw new LlamaRouterError('GET /models returned an invalid model record');
      const row = entry as Record<string, unknown>;
      const name = typeof row.name === 'string' ? row.name : typeof row.id === 'string' ? row.id : '';
      const nestedStatus = row.status;
      const statusValue = nestedStatus && typeof nestedStatus === 'object'
        ? (nestedStatus as Record<string, unknown>).value
        : nestedStatus;
      if (!name || typeof statusValue !== 'string') {
        throw new LlamaRouterError('GET /models record is missing model name or status.value');
      }
      return { name, status: statusValue.toLowerCase() };
    });
  }

  async load(name: string): Promise<void> {
    await this.modelOperation(name, 'load', 'loaded');
  }

  async unload(name: string): Promise<void> {
    await this.modelOperation(name, 'unload', 'unloaded');
  }

  private async modelOperation(name: string, operation: 'load' | 'unload', target: string): Promise<void> {
    if (!name.trim()) throw new TypeError('model name is required');
    const models = await this.listModels();
    const model = models.find((entry) => entry.name === name);
    if (!model) {
      if (operation === 'unload') return;
      throw new LlamaRouterError(`model is not present in router: ${name}`);
    }
    if (model.status === target) return;
    if (operation === 'load' && model.status === 'loading') {
      await this.waitFor(name, target);
      return;
    }
    if (operation === 'load' && model.status === 'sleeping') {
      await this.request('/models/unload', { method: 'POST', body: JSON.stringify({ model: name }) });
      await this.waitFor(name, 'unloaded');
    }
    if (operation === 'unload' && !['loaded', 'loading', 'sleeping'].includes(model.status)) {
      if (model.status === 'unloaded') return;
      throw new LlamaRouterError(`model cannot be unloaded from state ${model.status}: ${name}`);
    }
    await this.request(`/models/${operation}`, { method: 'POST', body: JSON.stringify({ model: name }) });
    await this.waitFor(name, target);
  }

  private async waitFor(name: string, target: string): Promise<void> {
    const deadline = Date.now() + this.modelMs;
    let lastState = 'unknown';
    while (Date.now() < deadline) {
      const models = await this.listModels();
      const current = models.find((entry) => entry.name === name);
      lastState = current?.status ?? 'absent';
      if (lastState === target || (target === 'unloaded' && lastState === 'absent')) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollMs, Math.max(1, deadline - Date.now()))));
    }
    throw new LlamaRouterError(`timed out waiting for ${name} to reach ${target}; last state was ${lastState}`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), this.requestMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        headers: { ...this.headers, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
        signal: controller.signal,
      });
      const text = await response.text();
      let body: any = undefined;
      if (text) {
        try { body = JSON.parse(text); }
        catch { throw new LlamaRouterError(`${path} returned invalid JSON`); }
      }
      if (!response.ok) {
        const message = body?.error?.message ?? body?.error ?? text ?? response.statusText;
        throw new LlamaRouterError(`${path} failed (${response.status}): ${String(message)}`);
      }
      return body;
    } catch (error) {
      if (error instanceof LlamaRouterError) throw error;
      if (controller.signal.aborted) throw new LlamaRouterError(`${path} timed out after ${this.requestMs}ms`);
      throw new LlamaRouterError(`${path} request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
