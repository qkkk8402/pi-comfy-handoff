import test from 'node:test';
import assert from 'node:assert/strict';
import { loadManagerConfig, parseManagerArgs, parseManagerConfig } from '../src/manager-config.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('manager defaults to loopback and disables unbounded LLM autoload behavior', () => {
  const config = parseManagerConfig({}, '/host');
  assert.equal(config.listenHost, '127.0.0.1');
  assert.equal(config.listenPort, 8090);
  assert.equal(config.comfyuiUrl, 'http://127.0.0.1:8188');
  assert.equal(config.llamaServerUrl, 'http://127.0.0.1:8080');
  assert.equal(config.stateDir, '/host/.pi-comfy-manager');
  assert.equal(config.logLevel, 'info');
  assert.equal(parseManagerConfig({ logLevel: 'debug' }).logLevel, 'debug');
  assert.throws(() => parseManagerConfig({ logLevel: 'trace' }), /logLevel/);
  assert.throws(() => parseManagerConfig({ logLevel: ['info'] }), /logLevel/);
  assert.equal(config.timeouts.generationMs, 0);
});

test('manager config validates endpoints, VRAM and remote bind authentication', () => {
  assert.throws(() => parseManagerConfig({ comfyuiUrl: 'file:///bad' }), /HTTP/);
  assert.throws(() => parseManagerConfig({ minFreeMiB: -1 }), /minFreeMiB/);
  assert.throws(() => parseManagerConfig({ listenHost: '0.0.0.0' }), /COMFY_MANAGER_TOKEN/);
  assert.throws(() => parseManagerConfig({ listenHost: '0.0.0.0' }, '/', { COMFY_MANAGER_TOKEN: 'short' }), /16 characters/);
  const config = parseManagerConfig({ listenHost: '0.0.0.0', tokenEnv: 'MANAGER_KEY' }, '/', { MANAGER_KEY: '0123456789abcdef' });
  assert.equal(config.token, '0123456789abcdef');
});

test('manager CLI options override JSON while preserving unoverridden values', () => {
  const workDir = join(process.cwd(), 'work');
  mkdirSync(workDir, { recursive: true });
  const dir = mkdtempSync(join(workDir, 'pi-manager-'));
  try {
    const file = join(dir, 'manager.json');
    writeFileSync(file, JSON.stringify({ listenHost: '0.0.0.0', listenPort: 9000, minFreeMiB: 300, timeouts: { requestMs: 5000, modelMs: 6000 } }));
    const args = parseManagerArgs(['--config', file, '--host', '127.0.0.1', '--port', '8091', '--poll-ms', '250', '--log-level', 'debug']);
    const config = loadManagerConfig(args.configFile, dir, args.overrides);
    assert.equal(config.listenHost, '127.0.0.1');
    assert.equal(config.listenPort, 8091);
    assert.equal(config.minFreeMiB, 300);
    assert.equal(config.timeouts.requestMs, 5000);
    assert.equal(config.timeouts.modelMs, 6000);
    assert.equal(config.timeouts.pollMs, 250);
    assert.equal(config.logLevel, 'debug');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manager CLI parser reports missing, unknown and invalid options', () => {
  assert.throws(() => parseManagerArgs(['--port']), /--port requires a value/);
  assert.throws(() => parseManagerArgs(['--wat']), /Unknown argument/);
  assert.throws(() => parseManagerArgs(['constructor', 'value']), /Unknown argument/);
  assert.throws(() => parseManagerArgs(['--port', 'abc']), /nonnegative integer/);
  assert.throws(() => parseManagerArgs(['--port', '65536']), /between 1 and 65535/);
  assert.throws(() => parseManagerConfig({ listenPort: 65536 }), /between 1 and 65535/);
  assert.equal(parseManagerArgs(['--help']).help, true);
});
