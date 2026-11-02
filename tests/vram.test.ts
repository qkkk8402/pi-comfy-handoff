import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaRow } from '../src/vram.js';

test('parses NVIDIA VRAM readings reported in MiB', () => {
  assert.deepEqual(parseNvidiaRow('0, GPU-1234, 24576, 1024, 23552'), {
    source: 'nvidia', device: '0', totalMiB: 24576, usedMiB: 1024, freeMiB: 23552,
  });
});

test('rejects malformed or inconsistent NVIDIA VRAM readings', () => {
  assert.throws(() => parseNvidiaRow('0, GPU-1234, 24576, 25000, 0'), /invalid VRAM/);
  assert.throws(() => parseNvidiaRow('0, GPU-1234, N/A, 10, 20'), /invalid VRAM/);
});
