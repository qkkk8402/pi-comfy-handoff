import test from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, parseConfig } from '../src/config.js';

test('two URLs support LAN addresses, HTTPS, ports and reverse proxy prefixes without host settings', () => {
  const config = parseConfig({ comfyuiUrl: 'http://192.168.1.10:8188/', llamaServerUrl: 'https://gpu.example.test/llama/' }, process.cwd(), {});
  assert.equal(config.comfyuiUrl, 'http://192.168.1.10:8188');
  assert.equal(config.llamaServerUrl, 'https://gpu.example.test/llama');
  assert.equal(config.llamaModel, undefined);
  assert.equal(config.minFreeMiB, undefined);
  assert.ok(config.outputDir.endsWith('outputs/comfy'));
});
test('defaults and optional API credentials', () => {
  const config = parseConfig({}, process.cwd(), { LLAMA_API_KEY: 'llama-secret', COMFYUI_API_KEY: 'comfy-secret' });
  assert.equal(config.llamaApiKey, 'llama-secret');
  assert.equal(config.comfyApiKey, 'comfy-secret');
  assert.equal(config.llamaServerUrl, 'http://127.0.0.1:8080');
});
test('rejects malformed endpoints and invalid timing or memory options', () => {
  assert.throws(() => apiUrl('file:///secret', 'endpoint'), /HTTP/);
  assert.throws(() => apiUrl('http://user:secret@localhost', 'endpoint'), /credentials/);
  assert.throws(() => apiUrl('http://localhost?autoload=true', 'endpoint'), /query/);
  assert.throws(() => parseConfig({ timeouts: { pollMs: 0 } }), /pollMs/);
  assert.throws(() => parseConfig({ minFreeMiB: -1 }), /minFreeMiB/);
});
