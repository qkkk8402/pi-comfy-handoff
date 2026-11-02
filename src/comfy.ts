/** ComfyUI HTTP API client. */

import { createReadStream } from "node:fs";
import { link as hardLink, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { OutcomeUnknown, type ComfyAdapter, type GenerationResult, type QueueState, type Workflow } from "./types.js";
import { parseApiWorkflow, validateApiWorkflow, type ObjectInfo } from "./workflow.js";

export interface ComfyClientOptions {
  requestMs?: number;
  generationMs?: number;
  pollMs?: number;
  unknownGraceMs?: number;
  dedicatedServer?: boolean;
  outputDir?: string;
  maxJsonBytes?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
  apiKey?: string;
  settleMs?: number;
}

export class ComfyHttpError extends Error {
  constructor(readonly endpoint: string, readonly status: number, readonly responseBody: string) {
    super(`ComfyUI ${endpoint} returned HTTP ${status}: ${responseBody.slice(0, 1000)}`);
    this.name = "ComfyHttpError";
  }
}

export class ComfyJobError extends Error {
  constructor(readonly promptId: string, readonly details: unknown) {
    super(`ComfyUI job ${promptId} failed: ${formatDetails(details)}`);
    this.name = "ComfyJobError";
  }
}

export class ComfyCancelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyCancelError";
  }
}

export interface DownloadedOutput {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
  path?: string;
  viewUrl: string;
}

type JsonRecord = Record<string, unknown>;
type HistoryEntry = { status?: JsonRecord; outputs?: unknown; [key: string]: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatDetails(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function workflowSnapshot(workflow: Workflow): Workflow {
  return parseApiWorkflow(workflow) as Workflow;
}

function validId(value: string, label: string): void {
  if (!value || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${label}`);
}

function safeOutputName(filename: string, promptId: string, index: number): string {
  if (!filename || filename === "." || filename === ".." || filename !== basename(filename) ||
      filename.includes("/") || filename.includes("\\") || /[\u0000-\u001f]/.test(filename)) {
    throw new Error(`Unsafe ComfyUI output filename: ${JSON.stringify(filename)}`);
  }
  const prefix = promptId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "job";
  return `${prefix}-${index}-${filename}`;
}

function extractFiles(outputs: unknown): Array<{ nodeId: string; filename: string; subfolder: string; type: string }> {
  const found: Array<{ nodeId: string; filename: string; subfolder: string; type: string }> = [];
  if (!isRecord(outputs)) return found;
  for (const [nodeId, value] of Object.entries(outputs)) {
    const walk = (item: unknown, seen: Set<object>): void => {
      if (!item || typeof item !== "object" || seen.has(item)) return;
      seen.add(item);
      if (Array.isArray(item)) {
        for (const child of item) walk(child, seen);
        return;
      }
      const record = item as JsonRecord;
      if (typeof record.filename === "string") {
        found.push({
          nodeId,
          filename: record.filename,
          subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
          type: typeof record.type === "string" ? record.type : "output",
        });
        return;
      }
      for (const child of Object.values(record)) walk(child, seen);
    };
    walk(value, new Set());
  }
  return found;
}

/**
 * ComfyUI API adapter. A submit whose response is ambiguous throws OutcomeUnknown;
 * callers must reconcile by marker and must never blindly submit the same job again.
 */
export class ComfyClient implements ComfyAdapter {
  readonly baseUrl: string;
  readonly options: Required<Omit<ComfyClientOptions, "outputDir">> & { outputDir?: string };
  private objectInfoCache?: { expiresAt: number; value: ObjectInfo };
  private readonly responseCleanup = new WeakMap<Response, () => void>();

  constructor(baseUrl: string, options: ComfyClientOptions = {}) {
    const url = new URL(baseUrl);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
      throw new Error("ComfyUI URL must be an HTTP(S) URL without credentials, query, or fragment");
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.options = {
      requestMs: options.requestMs ?? 15_000,
      generationMs: options.generationMs ?? 30 * 60_000,
      pollMs: options.pollMs ?? 1_000,
      unknownGraceMs: options.unknownGraceMs ?? 30_000,
      dedicatedServer: options.dedicatedServer ?? false,
      outputDir: options.outputDir,
      maxJsonBytes: options.maxJsonBytes ?? 8 * 1024 * 1024,
      maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024 * 1024,
      maxInputBytes: options.maxInputBytes ?? 4 * 1024 * 1024 * 1024,
      apiKey: options.apiKey ?? "",
      settleMs: options.settleMs ?? 30_000,
    };
    for (const name of ["requestMs", "pollMs", "unknownGraceMs", "maxJsonBytes", "maxOutputBytes", "maxInputBytes", "settleMs"] as const) {
      if (!Number.isSafeInteger(this.options[name]) || this.options[name] < 1) throw new Error(`${name} must be a positive integer`);
    }
    if (!Number.isSafeInteger(this.options.generationMs) || this.options.generationMs < 0) throw new Error('generationMs must be a nonnegative integer (0 means no deadline)');
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async fetchResponse(path: string, init: RequestInit = {}, timeoutMs = this.options.requestMs): Promise<Response> {
    const controller = new AbortController();
    const timer = timeoutMs === 0 ? undefined : setTimeout(() => controller.abort(new Error(`ComfyUI request timed out: ${path}`)), timeoutMs);
    const signal = init.signal;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers = new Headers(init.headers);
      if (this.options.apiKey) headers.set("authorization", `Bearer ${this.options.apiKey}`);
      const response = await fetch(this.endpoint(path), { ...init, headers, redirect: "error", signal: controller.signal });
      this.responseCleanup.set(response, () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      });
      return response;
    } catch (error) {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      throw error;
    }
  }

  private finishResponse(response: Response): void {
    this.responseCleanup.get(response)?.();
    this.responseCleanup.delete(response);
  }

  private async json(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.options.requestMs,
    allowEmptySuccess = false,
  ): Promise<unknown> {
    const response = await this.fetchResponse(path, init, timeoutMs);
    try {
      const body = await readTextLimited(response, this.options.maxJsonBytes, path);
      if (!response.ok) throw new ComfyHttpError(path, response.status, body);
      if (allowEmptySuccess && body.trim() === "") return undefined;
      try { return JSON.parse(body) as unknown; }
      catch { throw new Error(`ComfyUI returned invalid JSON: ${path}`); }
    } finally { this.finishResponse(response); }
  }

  async objectInfo(refresh = false): Promise<ObjectInfo> {
    if (!refresh && this.objectInfoCache && Date.now() < this.objectInfoCache.expiresAt) return this.objectInfoCache.value;
    const value = await this.json("/object_info");
    if (!isRecord(value)) throw new Error("ComfyUI /object_info response must be an object");
    this.objectInfoCache = { value: value as ObjectInfo, expiresAt: Date.now() + 5_000 };
    return this.objectInfoCache.value;
  }

  async uploadInput(filePath: string, subfolder = ""): Promise<{ name: string; subfolder: string; type: string }> {
    const fileName = basename(filePath);
    if (!fileName || fileName === "." || fileName === ".." || /[\r\n\u0000]/.test(fileName)) {
      throw new Error("Input file must have a safe basename");
    }
    if (subfolder && (isAbsolute(subfolder) || subfolder.split(/[\\/]+/).some((part) => part === ".." || part === ".") || /[\r\n\u0000]/.test(subfolder))) {
      throw new Error("Upload subfolder must be a safe relative path");
    }
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("ComfyUI input must be a regular, non-symlink file");
    const fileStats = await stat(filePath);
    if (fileStats.size > this.options.maxInputBytes) throw new Error(`Input file exceeds ${this.options.maxInputBytes} bytes`);

    const boundary = `----piComfy${randomUUID().replaceAll("-", "")}`;
    const fields: Array<[string, string]> = [["type", "input"], ["overwrite", "false"]];
    if (subfolder) fields.push(["subfolder", subfolder]);
    let prefix = "";
    for (const [name, value] of fields) {
      prefix += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    }
    const escapedName = fileName.replace(/\\/g, "_").replace(/"/g, "_");
    prefix += `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${escapedName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const prefixBytes = Buffer.from(prefix, "utf8");
    const suffixBytes = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const bodyLength = prefixBytes.byteLength + fileStats.size + suffixBytes.byteLength;
    const parts = async function* (): AsyncGenerator<Uint8Array> {
      yield prefixBytes;
      for await (const chunk of createReadStream(filePath)) yield chunk as Buffer;
      yield suffixBytes;
    };
    const body = Readable.toWeb(Readable.from(parts()));
    const response = await this.fetchResponse("/upload/image", {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(bodyLength),
      },
      body,
      duplex: "half",
    } as RequestInit);
    try {
      const text = await readTextLimited(response, this.options.maxJsonBytes, "/upload/image");
      if (!response.ok) throw new ComfyHttpError("/upload/image", response.status, text);
      let value: unknown;
      try { value = JSON.parse(text) as unknown; }
      catch { throw new Error("ComfyUI /upload/image returned invalid JSON"); }
      if (!isRecord(value) || typeof value.name !== "string" || !value.name ||
          (value.subfolder !== undefined && typeof value.subfolder !== "string") ||
          (value.type !== undefined && typeof value.type !== "string")) {
        throw new Error("ComfyUI /upload/image returned an invalid file reference");
      }
      const uploaded = {
        name: value.name,
        subfolder: typeof value.subfolder === "string" ? value.subfolder : "",
        type: typeof value.type === "string" ? value.type : "input",
      };
      if (isAbsolute(uploaded.name) || uploaded.name.split(/[\\/]+/).some((part) => part === "..") ||
          uploaded.subfolder.split(/[\\/]+/).some((part) => part === "..")) {
        throw new Error("ComfyUI returned an unsafe uploaded file reference");
      }
      return uploaded;
    } finally { this.finishResponse(response); }
  }

  async queue(): Promise<QueueState> {
    const value = await this.json("/queue");
    if (!isRecord(value)) throw new Error("ComfyUI /queue response must be an object");
    if (!Array.isArray(value.queue_running) || !Array.isArray(value.queue_pending)) {
      throw new Error("ComfyUI /queue response is missing queue_running or queue_pending arrays");
    }
    return { running: queueIds(value.queue_running, "queue_running"), pending: queueIds(value.queue_pending, "queue_pending") };
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    validId(promptId, "prompt ID");
    const value = await this.json(`/history/${encodeURIComponent(promptId)}`);
    if (!isRecord(value)) throw new Error("ComfyUI history response must be an object");
    const entry = value[promptId];
    return isRecord(entry) ? entry as HistoryEntry : undefined;
  }

  async submit(workflowValue: Workflow, jobId: string): Promise<string> {
    validId(jobId, "job ID");
    const workflow = workflowSnapshot(workflowValue);
    const info = await this.objectInfo();
    const validation = validateApiWorkflow(workflow, info);
    if (!validation.valid) {
      throw new Error(`Invalid ComfyUI workflow: ${validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    }
    const clientId = randomUUID();
    const body = JSON.stringify({
      prompt: workflow,
      client_id: clientId,
      extra_data: { pi: { job_id: jobId } },
    });
    let response: Response;
    try {
      response = await this.fetchResponse("/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch (error) {
      throw new OutcomeUnknown(`ComfyUI submit outcome is unknown for job ${jobId}: ${String(error)}`);
    }
    let text: string;
    try {
      text = await readTextLimited(response, Math.min(this.options.maxJsonBytes, 1024 * 1024), "/prompt");
    } catch (error) {
      throw new OutcomeUnknown(`ComfyUI submit outcome is unknown for job ${jobId}: ${String(error)}`);
    } finally { this.finishResponse(response); }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw new OutcomeUnknown(`ComfyUI submit outcome is unknown for job ${jobId}: HTTP ${response.status}`);
      }
      throw new ComfyHttpError("/prompt", response.status, text);
    }
    let result: unknown;
    try { result = JSON.parse(text) as unknown; }
    catch { throw new OutcomeUnknown(`ComfyUI accepted job ${jobId} but returned an unreadable response`); }
    const promptId = isRecord(result) && typeof result.prompt_id === "string" ? result.prompt_id : "";
    if (!promptId) throw new OutcomeUnknown(`ComfyUI accepted job ${jobId} without returning a prompt_id`);
    return promptId;
  }

  async wait(promptId: string, onProgress?: (value: unknown) => void, signal?: AbortSignal): Promise<GenerationResult> {
    validId(promptId, "prompt ID");
    const started = Date.now();
    let absentSince: number | undefined;
    while (this.options.generationMs === 0 || Date.now() - started < this.options.generationMs) {
      if (signal?.aborted) throw new OutcomeUnknown(`Waiting for ${promptId} stopped while its ComfyUI state may still be active`);
      let entry: HistoryEntry | undefined;
      try { entry = await this.history(promptId); }
      catch (error) {
        if (error instanceof ComfyJobError || error instanceof OutcomeUnknown) throw error;
        throw new OutcomeUnknown(`Could not confirm ComfyUI job ${promptId}: ${String(error)}`);
      }
      if (entry) {
        const status = isRecord(entry.status) ? entry.status : {};
        const statusText = typeof status.status_str === "string" ? status.status_str.toLowerCase() : "";
        if (statusText === "error" || statusText === "failed") throw new ComfyJobError(promptId, status.messages ?? status);
        if (status.completed === true && (statusText === "success" || statusText === "completed")) {
          const refs = extractFiles(entry.outputs);
          const outputs: DownloadedOutput[] = [];
          for (const [index, file] of refs.entries()) {
            outputs.push(await this.downloadOutput(promptId, file, index, signal));
          }
          return { promptId, outputs };
        }
        if (status.completed === true && statusText && statusText !== "success") {
          throw new ComfyJobError(promptId, status.messages ?? status);
        }
        absentSince = undefined;
        onProgress?.({ promptId, state: "running", elapsedMs: Date.now() - started });
      } else {
        let queue: QueueState;
        try { queue = await this.queue(); }
        catch (error) { throw new OutcomeUnknown(`Could not confirm ComfyUI job ${promptId}: ${String(error)}`); }
        if (queue.running.includes(promptId) || queue.pending.includes(promptId)) {
          absentSince = undefined;
          onProgress?.({ promptId, state: queue.running.includes(promptId) ? "running" : "pending", elapsedMs: Date.now() - started });
        } else {
          absentSince ??= Date.now();
          if (Date.now() - absentSince >= this.options.unknownGraceMs) {
            throw new OutcomeUnknown(`ComfyUI job ${promptId} is absent from both history and queue`);
          }
          onProgress?.({ promptId, state: "checking", elapsedMs: Date.now() - started });
        }
      }
      try { await delay(this.options.pollMs, signal); }
      catch (error) { throw new OutcomeUnknown(`Waiting for ${promptId} stopped before terminal state was confirmed: ${String(error)}`); }
    }
    throw new OutcomeUnknown(`Timed out waiting for ComfyUI job ${promptId}; it may still be running`);
  }

  async cancel(promptId: string): Promise<void> {
    validId(promptId, "prompt ID");
    const queue = await this.queue();
    if (queue.pending.includes(promptId)) {
      await this.json("/queue", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
      }, this.options.requestMs, true);
      await this.waitUntilQueueAbsent(promptId, "pending cancellation");
      return;
    }
    if (queue.running.includes(promptId)) {
      if (!this.options.dedicatedServer) {
        throw new ComfyCancelError("Refusing /interrupt because it affects the entire ComfyUI server; enable dedicatedServer only for an isolated instance");
      }
      if (queue.running.length !== 1 || queue.running[0] !== promptId) {
        throw new ComfyCancelError("Refusing to interrupt because other or unknown jobs are running");
      }
      await this.json("/interrupt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt_id: promptId }),
      }, this.options.requestMs, true);
      await this.waitUntilQueueAbsent(promptId, "running cancellation");
      return;
    }
    const entry = await this.history(promptId);
    if (!entry) throw new OutcomeUnknown(`Cannot determine whether ComfyUI job ${promptId} is still active`);
    const status = isRecord(entry.status) ? entry.status : {};
    if (status.completed !== true) throw new OutcomeUnknown(`ComfyUI job ${promptId} has no terminal history state`);
  }

  private async waitUntilQueueAbsent(promptId: string, action: string): Promise<void> {
    const deadline = this.options.generationMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + this.options.generationMs;
    while (Date.now() < deadline) {
      const queue = await this.queue();
      if (!queue.running.includes(promptId) && !queue.pending.includes(promptId)) return;
      await delay(this.options.pollMs);
    }
    throw new OutcomeUnknown(`Timed out waiting for ${action} of ${promptId}`);
  }

  async free(): Promise<void> {
    await this.json("/free", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }, this.options.requestMs, true);
  }

  /** Wait for observable GPU headroom after free(); this cannot prove custom nodes released every allocation. */
  async waitForRelease(minFreeMiB?: number): Promise<void> {
    if (minFreeMiB !== undefined && (!Number.isFinite(minFreeMiB) || minFreeMiB < 0)) {
      throw new TypeError("minFreeMiB must be a non-negative number");
    }
    const deadline = Date.now() + this.options.settleMs;
    let previousReserved = Number.POSITIVE_INFINITY;
    let previousDriverFree = -1;
    let stableSamples = 0;
    while (Date.now() < deadline) {
      const queue = await this.queue();
      if (queue.running.length || queue.pending.length) throw new OutcomeUnknown("ComfyUI queue became active while waiting for model release");
      const stats = await this.json("/system_stats");
      const gpu = cudaMemoryStats(stats);
      if (minFreeMiB !== undefined && gpu.driverFreeMiB < minFreeMiB) stableSamples = 0;
      else if (previousReserved !== Number.POSITIVE_INFINITY && gpu.torchReservedMiB <= previousReserved && gpu.driverFreeMiB >= previousDriverFree) stableSamples += 1;
      else stableSamples = 0;
      if (stableSamples >= 2) return;
      previousReserved = gpu.torchReservedMiB;
      previousDriverFree = gpu.driverFreeMiB;
      await delay(Math.min(this.options.pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new OutcomeUnknown("Timed out waiting for ComfyUI GPU memory release; the API did not confirm stable headroom");
  }

  async downloadOutput(
    promptId: string,
    file: { nodeId: string; filename: string; subfolder: string; type: string },
    index: number,
    signal?: AbortSignal,
  ): Promise<DownloadedOutput> {
    const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const viewUrl = this.endpoint(`/view?${params.toString()}`);
    if (!this.options.outputDir) return { ...file, viewUrl };
    const outputDir = resolve(this.options.outputDir);
    await mkdir(outputDir, { recursive: true });
    const target = resolve(outputDir, safeOutputName(file.filename, promptId, index));
    if (!target.startsWith(`${outputDir}${sep}`)) throw new Error("ComfyUI output path escaped output directory");
    try {
      const st = await lstat(target);
      if (st.isSymbolicLink() || st.isDirectory()) throw new Error("Refusing to overwrite a non-regular output path");
      throw new Error(`Output file already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = resolve(outputDir, `.${randomUUID()}.partial`);
    const response = await this.fetchResponse(`/view?${params.toString()}`, { signal }, this.options.generationMs);
    let created = false;
    try {
      if (!response.ok) throw new ComfyHttpError("/view", response.status,
        await readTextLimited(response, Math.min(this.options.maxJsonBytes, 1024 * 1024), "/view"));
      const advertised = Number(response.headers.get("content-length") ?? 0);
      if (advertised > this.options.maxOutputBytes) throw new Error(`ComfyUI output exceeds ${this.options.maxOutputBytes} bytes`);
      if (!response.body) throw new Error("ComfyUI /view returned no body");
      let received = 0;
      const limiter = new Transform({
        transform: (chunk: Uint8Array, _encoding, callback) => {
          received += chunk.byteLength;
          if (received > this.options.maxOutputBytes) callback(new Error(`ComfyUI output exceeds ${this.options.maxOutputBytes} bytes`));
          else callback(null, chunk);
        },
      });
      const handle = await open(temporary, "wx", 0o600);
      created = true;
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), limiter,
        handle.createWriteStream({ autoClose: true }));
      try { await hardLink(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Output file already exists: ${target}`);
        throw error;
      }
      await unlink(temporary);
      created = false;
    } catch (error) {
      if (created) await unlink(temporary).catch(() => undefined);
      throw error;
    } finally { this.finishResponse(response); }
    return { ...file, path: target, viewUrl };
  }
}

function queueIds(value: unknown[], label: string): string[] {
  return value.map((item, index) => {
    if (!Array.isArray(item) || item.length < 2 ||
        (typeof item[1] !== "string" && typeof item[1] !== "number") || !String(item[1])) {
      throw new Error(`ComfyUI /queue ${label}[${index}] has no valid prompt ID`);
    }
    return String(item[1]);
  });
}

function cudaMemoryStats(value: unknown): { driverFreeMiB: number; torchReservedMiB: number } {
  if (!isRecord(value) || !Array.isArray(value.devices)) throw new OutcomeUnknown("ComfyUI /system_stats did not provide GPU devices");
  const device = value.devices.find((entry) => isRecord(entry) && entry.type === "cuda");
  if (!isRecord(device)) throw new OutcomeUnknown("ComfyUI /system_stats has no CUDA-compatible GPU metrics");
  const required = ["vram_free", "torch_vram_free", "torch_vram_total"] as const;
  for (const key of required) {
    if (typeof device[key] !== "number" || !Number.isFinite(device[key]) || device[key] < 0) {
      throw new OutcomeUnknown(`ComfyUI /system_stats has invalid ${key} GPU metric`);
    }
  }
  const driverFreeBytes = device.vram_free as number - (device.torch_vram_free as number);
  if (driverFreeBytes < 0) throw new OutcomeUnknown("ComfyUI /system_stats GPU memory metrics are inconsistent");
  return {
    driverFreeMiB: driverFreeBytes / (1024 * 1024),
    torchReservedMiB: (device.torch_vram_total as number) / (1024 * 1024),
  };
}

async function readTextLimited(response: Response, maxBytes: number, label: string): Promise<string> {
  const advertised = Number(response.headers.get("content-length") ?? 0);
  if (advertised > maxBytes) throw new Error(`ComfyUI response exceeded ${maxBytes} bytes: ${label}`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`ComfyUI response exceeded ${maxBytes} bytes: ${label}`);
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Operation aborted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolvePromise(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Operation aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
