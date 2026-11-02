import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiUrl, parseConfig, saveManagerUrl } from '../src/config.js';

test('manager URL supports HTTPS, ports and reverse proxy prefixes', () => {
  const config = parseConfig({ managerUrl: 'https://gpu.example.test/prefix/' }, process.cwd(), {});
  assert.equal(config.managerUrl, 'https://gpu.example.test/prefix');
  assert.ok(config.outputDir.endsWith('outputs/comfy'));
});

test('defaults to local manager and optional manager token env', () => {
  const config = parseConfig({}, process.cwd(), { COMFY_MANAGER_TOKEN: 'manager-secret' });
  assert.equal(config.managerUrl, 'http://127.0.0.1:8090');
  assert.equal(config.apiKey, 'manager-secret');
  assert.equal(parseConfig({}, process.cwd(), {}).apiKey, undefined);
});

test('rejects malformed manager URL or timing values', () => {
  assert.throws(() => apiUrl('file:///secret', 'endpoint'), /HTTP/);
  assert.throws(() => apiUrl('http://user:secret@localhost', 'endpoint'), /credentials/);
  assert.throws(() => apiUrl('http://localhost?autoload=true', 'endpoint'), /query/);
  assert.throws(() => parseConfig({ timeouts: { pollMs: 0 } }), /pollMs/);
  assert.throws(() => parseConfig({ timeouts: { requestMs: 1.5 } }), /requestMs/);
});

test('manager setup keeps optional project settings and saves atomically', async () => {
  const cwd = await mkdtemp(join(process.cwd(), 'work', 'config-'));
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    const file = join(cwd, '.pi/comfyui.json');
    await writeFile(file, JSON.stringify({ outputDir: 'renders', stateDir: '.state', apiKeyEnv: 'CUSTOM_TOKEN', timeouts: { pollMs: 500 } }));
    await saveManagerUrl(cwd, 'https://manager.example.test/api/');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      outputDir: 'renders', stateDir: '.state', apiKeyEnv: 'CUSTOM_TOKEN', timeouts: { pollMs: 500 }, managerUrl: 'https://manager.example.test/api',
    });
    assert.equal(parseConfig(JSON.parse(await readFile(file, 'utf8')), cwd, { CUSTOM_TOKEN: 'custom' }).apiKey, 'custom');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
