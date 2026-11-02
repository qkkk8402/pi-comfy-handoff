import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { loadConfig, saveEndpoints } from './config.js';
import { ComfyClient } from './comfy.js';
import { LlamaRouterClient } from './llama.js';
import { Runner } from './runner.js';
import { projectFile, readProjectJson, writeProjectJson } from './files.js';
import { applyWorkflowPatch, summarizeApiWorkflow, validateApiWorkflow, type WorkflowPatch } from './workflow.js';
import type { Workflow } from './types.js';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], details: value });

export default function extension(pi: ExtensionAPI): void {
  const runtimes = new Map<string, { comfy: ComfyClient; runner: Runner }>();
  const runtime = (cwd: string) => {
    let value = runtimes.get(cwd);
    if (!value) {
      const config = loadConfig(cwd);
      const comfy = new ComfyClient(config.comfyuiUrl, {
        ...config.timeouts, outputDir: config.outputDir, apiKey: config.comfyApiKey, dedicatedServer: true,
      });
      value = { comfy, runner: new Runner(config, {
        comfy, llama: new LlamaRouterClient(config.llamaServerUrl, { ...config.timeouts, apiKey: config.llamaApiKey }),
      }) };
      runtimes.set(cwd, value);
    }
    return value;
  };
  pi.registerTool({
    name: 'comfy_upload', label: 'Upload ComfyUI input',
    executionMode: 'sequential',
    description: 'Upload a project-local input file to the dedicated ComfyUI instance without overwriting existing inputs. Use the exact returned name/subfolder in workflow inputs.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      const client = runtime(ctx.cwd).comfy;
      return text(await client.uploadInput(await projectFile(ctx.cwd, args.path)));
    },
  });
  pi.registerTool({
    name: 'comfy_inspect', label: 'Inspect ComfyUI',
    description: 'List available ComfyUI node classes, or inspect one class including its inputs and model choices. Does not load models.',
    parameters: Type.Object({ nodeClass: Type.Optional(Type.String()) }),
    async execute(_id, args, _signal, _update, ctx) {
      const info = await runtime(ctx.cwd).comfy.objectInfo();
      if (args.nodeClass) {
        if (!Object.hasOwn(info, args.nodeClass)) throw new Error(`Unknown node class: ${args.nodeClass}`);
        return text(info[args.nodeClass]);
      }
      return text({ classes: Object.keys(info).sort(), hint: 'Pass nodeClass to inspect inputs, outputs and model choices.' });
    },
  });
  pi.registerTool({
    name: 'comfy_workflow', label: 'Edit ComfyUI workflow',
    executionMode: 'sequential',
    description: 'Inspect, create, or patch a project-local API-format workflow JSON. UI canvas JSON is unsupported. Patch operations: setInput(nodeId,input,value), addNode(nodeId,node), removeNode(nodeId,disconnect?), connect(sourceNodeId,outputIndex,targetNodeId,input), disconnect(targetNodeId,input). Edits are saved atomically.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('inspect'), Type.Literal('create'), Type.Literal('patch')]),
      path: Type.String(), workflow: Type.Optional(Type.Unknown()), patches: Type.Optional(Type.Array(Type.Unknown())),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (args.action === 'inspect') return text(summarizeApiWorkflow(await readProjectJson(ctx.cwd, args.path)));
      let workflow: unknown = args.workflow;
      if (args.action === 'patch') {
        if (!args.patches?.length) throw new Error('patches is required for patch');
        workflow = applyWorkflowPatch(await readProjectJson(ctx.cwd, args.path), args.patches as WorkflowPatch[]);
      }
      const check = validateApiWorkflow(workflow);
      if (!check.valid) throw new Error(JSON.stringify(check.errors));
      const path = await writeProjectJson(ctx.cwd, args.path, workflow);
      return text({ path, summary: summarizeApiWorkflow(workflow), validation: 'Structure checked; use comfy_validate to check live node definitions before generating.' });
    },
  });
  pi.registerTool({
    name: 'comfy_validate', label: 'Validate ComfyUI workflow',
    description: 'Validate an API-format workflow against live node definitions and model choices. No generation or model loading.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      const client = runtime(ctx.cwd).comfy;
      return text(validateApiWorkflow(await readProjectJson(ctx.cwd, args.path), await client.objectInfo()));
    },
  });
  pi.registerTool({
    name: 'comfy_generate', label: 'Generate with ComfyUI',
    executionMode: 'sequential',
    description: 'Generate from a validated API workflow, or up to 32 prepared workflow paths. Calls ComfyUI and llama-server directly; waits for generation and LLM restoration. Cancellation attempts targeted stop and cleanup. Use /comfy status, cancel, or recover if interrupted.',
    promptGuidelines: ['Inspect node definitions and validate the workflow first.', 'Use exact installed model filenames. Prepare input files before generation.', 'Do not call llama-server or ComfyUI generation endpoints directly.'],
    parameters: Type.Object({ path: Type.Optional(Type.String()), paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 32 })) }),
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      const { comfy, runner } = runtime(ctx.cwd);
      if (Boolean(args.path) === Boolean(args.paths)) throw new Error('Specify exactly one of path or paths');
      const paths = args.paths ?? [args.path!];
      const info = await comfy.objectInfo();
      const workflows: Workflow[] = [];
      for (const path of paths) {
        const workflow = await readProjectJson(ctx.cwd, path);
        const checked = validateApiWorkflow(workflow, info);
        if (!checked.valid) throw new Error(`${path}: ${JSON.stringify(checked.errors)}`);
        workflows.push(workflow as Workflow);
      }
      const key = createHash('sha256').update(`${ctx.cwd}\0${toolCallId}`).digest('hex');
      return text(await runner.generate(workflows, {
        signal, modelId: ctx.model?.id, idempotencyKey: key,
        onProgress: value => onUpdate?.(text(value)),
      }));
    },
  });
  pi.registerCommand('comfy', {
    description: 'Direct API control without the LLM: status | cancel | recover | connect [MODEL_ID] | setup',
    async handler(args, ctx) {
      try {
        const [command = 'status', id] = args.trim().split(/\s+/);
        if (command === 'setup') {
          if (!ctx.hasUI) throw new Error('Interactive setup requires Pi UI mode');
          const existing = runtime(ctx.cwd);
          const checkSetupState = async () => {
            if (!ctx.isIdle()) throw new Error('Cannot change connections while Pi is running a turn or tool');
            if (runtimes.get(ctx.cwd) !== existing) throw new Error('Runtime changed during setup; run /comfy setup again');
            const state = await existing.runner.status();
            if (existing.runner.isBusy || state.state === 'running' || state.state === 'recovery_required') {
              throw new Error('Cannot change connections during an active or unresolved run');
            }
          };
          await checkSetupState();
          const config = loadConfig(ctx.cwd);
          const comfyuiUrl = await ctx.ui.input(`ComfyUI URL (Enter: ${config.comfyuiUrl})`, config.comfyuiUrl);
          if (comfyuiUrl === undefined) return;
          const llamaServerUrl = await ctx.ui.input(`llama-server URL (Enter: ${config.llamaServerUrl})`, config.llamaServerUrl);
          if (llamaServerUrl === undefined) return;
          await checkSetupState();
          await saveEndpoints(ctx.cwd, comfyuiUrl.trim() || config.comfyuiUrl, llamaServerUrl.trim() || config.llamaServerUrl);
          runtimes.delete(ctx.cwd);
          ctx.ui.notify('接続先を保存しました。新しい設定を使用します。', 'info');
          return;
        }
        const { runner } = runtime(ctx.cwd);
        let result: unknown;
        if (command === 'status') result = await runner.status();
        else if (command === 'recover') result = await runner.recover();
        else if (command === 'cancel') { await runner.cancel(); result = await runner.status(); }
        else if (command === 'connect') { await runner.connect(id ?? ctx.model?.id); result = 'Model ready'; }
        else throw new Error('Usage: /comfy status | cancel | recover | connect [MODEL_ID] | setup');
        ctx.ui.notify(JSON.stringify(result, null, 2), 'info');
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
    },
  });
  pi.on('input', async (_event, ctx) => {
    const state = await runtime(ctx.cwd).runner.status();
    if (state.state === 'running' || state.state === 'recovery_required') {
      ctx.ui.notify('ComfyUI handoff is active or needs recovery. Use /comfy status, cancel, or recover before resuming chat.', 'warning');
      return { action: 'handled' as const };
    }
    return { action: 'continue' as const };
  });
}
