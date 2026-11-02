import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

export interface VramSample {
  source: 'amdgpu' | 'nvidia';
  device: string;
  totalMiB: number;
  usedMiB: number;
  freeMiB: number;
}

export interface VramMonitor {
  read(): Promise<VramSample | undefined>;
  waitForRelease(minFreeMiB?: number): Promise<VramSample>;
}

export interface VramMonitorOptions {
  gpu?: string;
  pollMs?: number;
  settleMs?: number;
  minFreeMiB?: number;
}

type Device = { source: 'amdgpu' | 'nvidia'; id: string; index?: string };

/** Reads host-wide VRAM usage through Linux amdgpu sysfs or nvidia-smi. */
export async function createVramMonitor(options: VramMonitorOptions = {}): Promise<VramMonitor> {
  const pollMs = options.pollMs ?? 1000;
  const settleMs = options.settleMs ?? 30_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new TypeError('pollMs must be a positive integer');
  if (!Number.isSafeInteger(settleMs) || settleMs < 1) throw new TypeError('settleMs must be a positive integer');
  if (options.minFreeMiB !== undefined && (!Number.isSafeInteger(options.minFreeMiB) || options.minFreeMiB < 0)) {
    throw new TypeError('minFreeMiB must be a nonnegative integer');
  }

  const devices = await findDevices();
  const device = selectDevice(devices, options.gpu);

  async function read(): Promise<VramSample | undefined> {
    if (!device) return undefined;
    if (device.source === 'amdgpu') {
      const base = `/sys/class/drm/${device.id}/device`;
      const [total, used] = await Promise.all([
        readBytes(`${base}/mem_info_vram_total`), readBytes(`${base}/mem_info_vram_used`),
      ]);
      if (used > total) throw new Error(`Invalid VRAM statistics for ${device.id}: used exceeds total`);
      return { source: 'amdgpu', device: device.id, totalMiB: total / MIB, usedMiB: used / MIB, freeMiB: (total - used) / MIB };
    }
    const args = ['--query-gpu=index,uuid,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'];
    const { stdout } = await execFileAsync('nvidia-smi', args, { timeout: 5000, maxBuffer: 64 * 1024 });
    const rows = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => ({
      uuid: line.split(',')[1]?.trim(), sample: parseNvidiaRow(line),
    }));
    const row = rows.find(item => item.uuid === device.id);
    if (!row) throw new Error(`NVIDIA GPU ${device.id} is no longer available`);
    return { ...row.sample, device: device.id };
  }

  async function waitForRelease(minFreeMiB = options.minFreeMiB): Promise<VramSample> {
    if (minFreeMiB !== undefined && (!Number.isFinite(minFreeMiB) || minFreeMiB < 0)) throw new TypeError('minFreeMiB must be nonnegative');
    const deadline = Date.now() + settleMs;
    let previous: VramSample | undefined;
    let stable = 0;
    while (Date.now() < deadline) {
      const current = await read();
      if (!current) throw new Error('Host VRAM monitoring is unavailable');
      const enough = minFreeMiB === undefined || current.freeMiB >= minFreeMiB;
      const unchanged = previous !== undefined && Math.abs(current.usedMiB - previous.usedMiB) <= 32;
      stable = enough && unchanged ? stable + 1 : 0;
      if (stable >= 2) return current;
      previous = current;
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error('Timed out waiting for host VRAM usage to stabilize');
  }

  return { read, waitForRelease };
}

async function findDevices(): Promise<Device[]> {
  const devices: Device[] = [];
  let cards: string[] = [];
  try { cards = (await readdir('/sys/class/drm')).filter(name => /^card\d+$/.test(name)); }
  catch { /* Non-Linux hosts may still provide NVIDIA telemetry. */ }
  for (const card of cards) {
    let vendor: string;
    try { vendor = (await readFile(`/sys/class/drm/${card}/device/vendor`, 'utf8')).trim().toLowerCase(); }
    catch { continue; }
    if (vendor === '0x1002') {
      const path = `/sys/class/drm/${card}/device`;
      try {
        const [total, used] = await Promise.all([readBytes(`${path}/mem_info_vram_total`), readBytes(`${path}/mem_info_vram_used`)]);
        if (total > 0 && used <= total) devices.push({ source: 'amdgpu', id: card });
      }
      catch { continue; }
    }
  }
  let nvidiaRows: Device[] = [];
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=index,uuid,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], { timeout: 5000, maxBuffer: 64 * 1024 });
    nvidiaRows = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [index, uuid] = line.split(',').map(part => part.trim());
      if (!index || !uuid) throw new Error('nvidia-smi returned an invalid device list');
      return { source: 'nvidia' as const, id: uuid, index };
    });
  } catch {
    // GPU utilities may be installed without a usable driver or visible device.
    // Only the initial probe falls back; errors after selection are surfaced by read().
  }
  devices.push(...nvidiaRows);
  return devices;
}

function selectDevice(devices: Device[], selector?: string): Device | undefined {
  if (selector) {
    const selected = devices.find(item => item.id === selector || (item.source === 'nvidia' && item.index === selector));
    if (!selected) throw new Error(`VRAM device not found: ${selector}`);
    return selected;
  }
  if (devices.length > 1) throw new Error(`Multiple GPUs expose VRAM statistics; configure gpu to select one (${devices.map(item => `${item.source}:${item.id}`).join(', ')})`);
  return devices[0];
}

async function readBytes(file: string): Promise<number> {
  const text = (await readFile(file, 'utf8')).trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid VRAM metric: ${file}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid VRAM metric: ${file}`);
  return value;
}

export function parseNvidiaRow(line: string): VramSample {
  const [index, uuid, totalText, usedText, freeText] = line.split(',').map(value => value.trim());
  const totalMiB = Number(totalText); const usedMiB = Number(usedText); const freeMiB = Number(freeText);
  if (!index || !uuid || ![totalMiB, usedMiB, freeMiB].every(value => Number.isFinite(value) && value >= 0) || totalMiB <= 0 || usedMiB > totalMiB || freeMiB > totalMiB) {
    throw new Error('nvidia-smi returned invalid VRAM statistics');
  }
  return { source: 'nvidia', device: index, totalMiB, usedMiB, freeMiB };
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
