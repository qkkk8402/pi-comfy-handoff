export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: Record<string, unknown> }>;
export interface ModelState { name: string; status: string; failed?: boolean; error?: string; exitCode?: number }
export interface LlamaAdapter {
  listModels(): Promise<ModelState[]>;
  /** Resolve only after status=loaded, never merely loading/sleeping. */
  load(name: string): Promise<void>;
  /** Resolve only after status=unloaded or model is absent. */
  unload(name: string): Promise<void>;
}
export interface QueueState { running: string[]; pending: string[] }
export interface GenerationResult { promptId: string; outputs: unknown[]; [key: string]: unknown }
export interface ComfyAdapter {
  queue(): Promise<QueueState>;
  submit(workflow: Workflow, jobId: string): Promise<string>;
  wait(promptId: string, onProgress?: (value: unknown) => void, signal?: AbortSignal): Promise<GenerationResult>;
  cancel(promptId: string): Promise<void>;
  /** Request only; observe queue and API memory information afterwards. */
  free(): Promise<void>;
  waitForRelease?(minFreeMiB?: number): Promise<void>;
}
export interface HostConfig {
  comfyuiUrl: string; llamaServerUrl: string;
  stateDir: string;
  llamaModel?: string; comfyApiKey?: string; llamaApiKey?: string;
  minFreeMiB?: number;
  timeouts: { requestMs: number; modelMs: number; generationMs: number; settleMs: number; pollMs: number };
}
export interface ManagerConfig extends HostConfig {
  listenHost: string;
  listenPort: number;
  gpu?: string;
  token?: string;
  logLevel?: 'silent' | 'error' | 'info' | 'debug';
}
export class OutcomeUnknown extends Error { override name = 'OutcomeUnknown'; }
