import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlamaRouterClient } from '../src/llama.js';

function fakeRouter(initial: { name: string; status: string }[]) {
  const models = structuredClone(initial);
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, init });
    if (path === '/models') {
      return Response.json({ models: models.map(({ name, status }) => ({ id: name, status: { value: status } })) });
    }
    if (path === '/models/load' || path === '/models/unload') {
      const body = JSON.parse(String(init?.body)) as { model: string };
      const row = models.find((item) => item.name === body.model);
      assert.ok(row);
      row.status = path.endsWith('/load') ? 'loading' : 'unloaded';
      return Response.json({ success: true });
    }
    return new Response('not found', { status: 404 });
  };
  return { models, calls, fetchImpl };
}

test('unload waits until the model is actually unloaded', async () => {
  const router = fakeRouter([{ name: 'agent-model', status: 'loaded' }]);
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    fetchImpl: router.fetchImpl,
    pollMs: 1,
    modelMs: 100,
  });
  await client.unload('agent-model');
  assert.equal(router.models[0]!.status, 'unloaded');
  assert.ok(router.calls.some((call) => call.path === '/models/unload'));
  assert.ok(router.calls.filter((call) => call.path === '/models').length >= 2);
});

test('load does not treat loading or sleeping as ready', async () => {
  const router = fakeRouter([{ name: 'agent-model', status: 'unloaded' }]);
  const diagnostics: string[] = [];
  let reads = 0;
  const baseFetch = router.fetchImpl;
  router.fetchImpl = async (input, init) => {
    if (new URL(String(input)).pathname === '/models') {
      reads += 1;
      if (reads >= 3 && router.models[0]!.status === 'loading') router.models[0]!.status = 'loaded';
    }
    return baseFetch(input, init);
  };
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    fetchImpl: router.fetchImpl,
    pollMs: 1,
    modelMs: 100,
    onDiagnostic: message => diagnostics.push(message),
  });
  await client.load('agent-model');
  assert.equal(router.models[0]!.status, 'loaded');
  assert.ok(reads >= 3);
  assert.ok(diagnostics.some(message => message.includes('state=loading')));
  assert.ok(diagnostics.some(message => message.includes('state=loaded')));
  assert.ok(diagnostics.some(message => message.includes('POST /models/load status=200')));
});

test('load wakes a sleeping model but waits for loaded state', async () => {
  const router = fakeRouter([{ name: 'agent-model', status: 'sleeping' }]);
  let loadingReads = 0;
  const baseFetch = router.fetchImpl;
  router.fetchImpl = async (input, init) => {
    if (new URL(String(input)).pathname === '/models' && router.models[0]!.status === 'loading') {
      loadingReads += 1;
      if (loadingReads >= 2) router.models[0]!.status = 'loaded';
    }
    return baseFetch(input, init);
  };
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    fetchImpl: router.fetchImpl,
    pollMs: 1,
    modelMs: 100,
  });
  await client.load('agent-model');
  assert.equal(router.models[0]!.status, 'loaded');
  assert.ok(router.calls.some((call) => call.path === '/models/unload'));
  assert.ok(router.calls.some((call) => call.path === '/models/load'));
});

test('load stops polling promptly when the router marks the model failed', async () => {
  let reads = 0;
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    modelMs: 60_000,
    pollMs: 5_000,
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/models/load') return Response.json({ success: true });
      if (path === '/models') {
        reads++;
        return Response.json({ models: [{ id: 'agent-model', status: { value: 'loading', failed: true, exit_code: 17 } }] });
      }
      return new Response('{}', { status: 404 });
    },
  });
  await assert.rejects(client.load('agent-model'), /failed while waiting.*exit code 17/);
  assert.equal(reads, 2, 'initial catalog plus one failed-state poll; do not wait for modelMs');
});

test('unloading an absent model is already complete', async () => {
  const router = fakeRouter([]);
  const client = new LlamaRouterClient('http://127.0.0.1:8080', { fetchImpl: router.fetchImpl });
  await client.unload('gone');
  assert.equal(router.calls.some((call) => call.path === '/models/unload'), false);
});

test('unload completes when the router removes the model after the POST', async () => {
  const router = fakeRouter([{ name: 'agent-model', status: 'loaded' }]);
  const baseFetch = router.fetchImpl;
  router.fetchImpl = async (input, init) => {
    if (new URL(String(input)).pathname === '/models/unload') {
      router.models.splice(0, 1);
      return Response.json({ success: true });
    }
    return baseFetch(input, init);
  };
  const client = new LlamaRouterClient('http://127.0.0.1:8080', { fetchImpl: router.fetchImpl, pollMs: 1 });
  await client.unload('agent-model');
  assert.equal(router.models.length, 0);
});

test('authenticated API calls never send a bearer header when no key is configured', async () => {
  const router = fakeRouter([{ name: 'agent-model', status: 'loaded' }]);
  const client = new LlamaRouterClient('http://127.0.0.1:8080', { fetchImpl: router.fetchImpl, apiKey: 'test-key' });
  await client.listModels();
  assert.equal(new Headers(router.calls[0]!.init?.headers).get('authorization'), 'Bearer test-key');
});

test('supports a base path and rejects credentials, query, and fragment in the URL', async () => {
  const seen: string[] = [];
  const client = new LlamaRouterClient('http://127.0.0.1:8080/prefix///', {
    fetchImpl: async (input) => {
      seen.push(new URL(String(input)).pathname);
      return Response.json({ models: [] });
    },
  });
  await client.listModels();
  assert.deepEqual(seen, ['/prefix/models']);
  for (const url of ['http://user:pass@localhost:8080', 'http://localhost:8080?x=1', 'http://localhost:8080/#x']) {
    assert.throws(() => new LlamaRouterClient(url), /without credentials, query, or fragment/);
  }
});

test('retries one transient GET /models socket failure within the request budget and records recovery', async () => {
  const diagnostics: string[] = [];
  let calls = 0;
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    requestMs: 1_000,
    onDiagnostic: message => diagnostics.push(message),
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });
      return Response.json({ models: [] });
    },
  });
  assert.deepEqual(await client.listModels(), []);
  assert.equal(calls, 2);
  assert.ok(diagnostics.some(message => message.includes('GET /models') && message.includes('code=ECONNRESET') && message.includes('cause=') && message.includes('retry=1')));
  assert.ok(diagnostics.some(message => message.includes('recoveredAfter=ECONNRESET')));
});

test('does not retry HTTP errors, invalid JSON, or POST socket failures and preserves the cause', async () => {
  let postCalls = 0;
  let invalidJsonCalls = 0;
  let httpCalls = 0;
  const httpErrorClient = new LlamaRouterClient('http://127.0.0.1:8080', {
    fetchImpl: async () => { httpCalls++; return Response.json({ error: 'unauthorized' }, { status: 401 }); },
  });
  await assert.rejects(httpErrorClient.listModels(), /failed \(401\)/);
  assert.equal(httpCalls, 1);
  const socketFailure = () => new TypeError('fetch failed', { cause: Object.assign(new Error('write broke'), { code: 'EPIPE' }) });
  const invalidJsonClient = new LlamaRouterClient('http://127.0.0.1:8080', {
    fetchImpl: async () => { invalidJsonCalls++; return new Response('{bad'); },
  });
  await assert.rejects(invalidJsonClient.listModels(), /invalid JSON/);
  assert.equal(invalidJsonCalls, 1);
  let shapeCalls = 0;
  const invalidShapeClient = new LlamaRouterClient('http://127.0.0.1:8080', {
    fetchImpl: async () => { shapeCalls++; return Response.json({ wrong: [] }); },
  });
  await assert.rejects(invalidShapeClient.listModels(), /no models array/);
  assert.equal(shapeCalls, 1);
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    fetchImpl: async (_input, init) => {
      if (init?.method === 'POST') { postCalls++; throw socketFailure(); }
      return Response.json({ models: [{ id: 'agent-model', status: { value: 'loaded' } }] });
    },
  });
  await assert.rejects(client.unload('agent-model'), error => {
    assert.equal(postCalls, 1);
    assert.equal((error as Error & { cause?: unknown }).cause instanceof TypeError, true);
    assert.match((error as Error).message, /request failed.*EPIPE.*write broke/);
    return true;
  });
});

test('stops after two socket failures and redacts secrets, URL credentials, and control characters', async () => {
  const diagnostics: string[] = [];
  const secret = 'llama-super-secret';
  let calls = 0;
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    apiKey: secret,
    onDiagnostic: message => diagnostics.push(message),
    fetchImpl: async () => {
      calls++;
      throw new TypeError(`fetch failed https://user:pass@example.test/private?token=secret#frag ${secret}\u0001\u0085`, {
        cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
      });
    },
  });
  await assert.rejects(client.listModels(), error => {
    assert.equal(calls, 2);
    assert.ok((error as Error & { cause?: unknown }).cause instanceof TypeError);
    assert.match((error as Error).message, /code=ECONNRESET.*cause=socket closed/);
    assert.ok(!(error as Error).message.includes(secret));
    assert.ok(!(error as Error).message.includes('user:pass'));
    assert.ok(!(error as Error).message.includes('?token='));
    assert.doesNotMatch((error as Error).message, /[\u0000-\u001f\u007f-\u009f]/);
    return true;
  });
  assert.ok(diagnostics.every(message => !message.includes(secret)));
  assert.ok(diagnostics.every(message => !message.includes('user:pass')));
  assert.ok(diagnostics.every(message => !message.includes('?token=')));
  assert.ok(diagnostics.every(message => !/[\u0000-\u001f\u007f-\u009f]/.test(message)));
  assert.ok(diagnostics.some(message => message.includes('retryFailed=ECONNRESET')));
});

test('request timeout uses one attempt and retains the elapsed budget and cause', async () => {
  let calls = 0;
  const diagnostics: string[] = [];
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    requestMs: 30,
    onDiagnostic: message => diagnostics.push(message),
    fetchImpl: async (_input, init) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  const started = Date.now();
  await assert.rejects(client.listModels(), error => {
    assert.equal(calls, 1);
    assert.ok((error as Error & { cause?: unknown }).cause instanceof Error);
    return true;
  });
  assert.ok(Date.now() - started < 200);
  assert.ok(diagnostics.some(message => message.includes('GET /models timeout=30ms') && message.includes('elapsed=') && message.includes('cause=')));
});

test('a retry that exhausts the request budget aborts within the original deadline', async () => {
  let calls = 0;
  const client = new LlamaRouterClient('http://127.0.0.1:8080', {
    requestMs: 150,
    fetchImpl: async (_input, init) => {
      calls++;
      if (calls === 1) throw new TypeError('socket reset', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  const started = Date.now();
  await assert.rejects(client.listModels(), /timed out after 150ms/);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 250);
});
