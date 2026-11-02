import assert from 'node:assert/strict';
import test from 'node:test';
import { ComfyHttpError } from '../src/comfy.js';
import { parseConfig } from '../src/config.js';
import { LlamaRouterClient } from '../src/llama.js';
import { ManagerClient } from '../src/manager-client.js';

const config = (requestMs = 100) => parseConfig({ managerUrl: 'http://127.0.0.1:8090', timeouts: { requestMs } }, process.cwd(), {});

test('manager client displays nested and legacy HTTP error messages with endpoint context', async () => {
  for (const body of [{ error: { message: 'GPU operation is already active' } }, { error: 'legacy rejection' }]) {
    const client = new ManagerClient(config(), async () => Response.json(body, { status: 409 }));
    await assert.rejects(client.status(), error => {
      assert.match((error as Error).message, /GET http:\/\/127\.0\.0\.1:8090\/status returned HTTP 409/);
      assert.match((error as Error).message, /GPU operation is already active|legacy rejection/);
      return true;
    });
  }
});

test('manager network errors show the socket cause code and timeout while preserving caller abort', async () => {
  const networkError = new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
  const unreachable = new ManagerClient(config(), async () => { throw networkError; });
  await assert.rejects(unreachable.status(), /127\.0\.0\.1:8090\/status \(ECONNREFUSED\).*manager is running/);

  const timeout = new ManagerClient(config(5), (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new TypeError('fetch aborted')), { once: true });
  }));
  await assert.rejects(timeout.status(), /timed out after 5ms/);

  const abort = new AbortController();
  const reason = new Error('caller stopped request');
  const pending = new ManagerClient(config(), (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  })).generate({ id: 'job', workflows: [] }, abort.signal);
  abort.abort(reason);
  await assert.rejects(pending, error => error === reason);
});

test('llama and Comfy clients retain nested upstream error messages', async () => {
  const llama = new LlamaRouterClient('http://127.0.0.1:8090/llama', {
    fetchImpl: async () => Response.json({ error: { message: 'Router is switching models' } }, { status: 409 }),
  });
  await assert.rejects(llama.listModels(), /Router is switching models/);

  const comfy = new ComfyHttpError('/object_info', 401, JSON.stringify({ error: { message: 'Bearer token required' } }));
  assert.match(comfy.message, /Bearer token required/);
});
