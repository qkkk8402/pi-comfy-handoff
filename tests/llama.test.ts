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
