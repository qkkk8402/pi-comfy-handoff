import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { loadConfig, matchingLlamaUrl, saveEnabled, saveManagerUrl } from './config.js';
import { ComfyClient } from './comfy.js';
import { ManagerClient, ManagerHttpError, type RunState } from './manager-client.js';
import { projectFile, readProjectJson, writeProjectJson } from './files.js';
import { applyWorkflowPatch, summarizeApiWorkflow, validateApiWorkflow, type WorkflowPatch } from './workflow.js';
import type { Workflow } from './types.js';

const text = (value: unknown): { content: [{ type: 'text'; text: string }]; details: unknown; terminate?: boolean } => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], details: value });
const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const COMFY_TOOLS = ['comfy_upload', 'comfy_inspect', 'comfy_workflow', 'comfy_validate', 'comfy_generate'] as const;
interface LocalRun { version: 1; id: string; startedAt: number; downloaded: Record<string, string> }
interface Runtime { manager: ManagerClient; comfy: ComfyClient }
interface SetupContext extends AuthContext { cwd: string; isIdle(): boolean; ui: { input(prompt: string, value: string): Promise<string | undefined>; notify(message: string, level?: string): void } }
type AuthContext = { modelRegistry?: { getProviderAuth?: (provider: string) => Promise<{ auth?: { apiKey?: string; baseUrl?: string }; env?: Record<string, string> } | undefined> } };

export default function extension(pi: ExtensionAPI): void {
  const runtimes = new Map<string, Runtime>();
  const syncDisabledTools = (cwd: string) => {
    if (loadConfig(cwd).enabled) return;
    const comfy = new Set<string>(COMFY_TOOLS);
    pi.setActiveTools(pi.getActiveTools().filter(name => !comfy.has(name)));
  };
  const setToolsEnabled = (enabled: boolean) => {
    const current = pi.getActiveTools();
    const comfy = new Set<string>(COMFY_TOOLS);
    pi.setActiveTools(enabled
      ? [...current, ...COMFY_TOOLS.filter(name => !current.includes(name))]
      : current.filter(name => !comfy.has(name)));
  };
  const requireEnabled = (cwd: string) => {
    if (!loadConfig(cwd).enabled) throw new Error('ComfyUI tools are disabled. Use /comfy to enable them.');
  };
  pi.on('session_start', (_event, ctx) => { syncDisabledTools(ctx.cwd); });
  pi.on('before_agent_start', (_event, ctx) => { syncDisabledTools(ctx.cwd); });
  const runtime = (cwd: string) => {
    let value = runtimes.get(cwd);
    if (!value) {
      const config = loadConfig(cwd);
      value = {
        manager: new ManagerClient(config),
        comfy: new ComfyClient(`${config.managerUrl}/comfy`, { outputDir: config.outputDir, apiKey: config.apiKey, requestMs: config.timeouts.requestMs, generationMs: 0 }),
      };
      runtimes.set(cwd, value);
    }
    return value;
  };

  const refreshAuth = async (ctx: AuthContext, cwd: string, client = runtime(cwd)) => {
    const fallback = loadConfig(cwd).apiKey;
    let apiKey = fallback;
    try {
      const auth = await ctx.modelRegistry?.getProviderAuth?.('llama.cpp');
      const key = auth?.auth?.apiKey;
      if (key && key !== 'local') {
        const llamaUrl = auth?.env?.LLAMA_BASE_URL;
        const matches = llamaUrl !== undefined
          ? matchingLlamaUrl(client.manager.baseUrl, llamaUrl)
          : matchingLlamaUrl(client.manager.baseUrl, auth?.auth?.baseUrl, true);
        if (matches) apiKey = key;
      }
    } catch { /* Keep using the explicitly configured manager token. */ }
    client.manager.setApiKey(apiKey);
    client.comfy.setApiKey(apiKey);
    return client;
  };

  pi.registerTool({
    name: 'comfy_upload', label: 'Upload ComfyUI input', executionMode: 'sequential',
    description: 'Upload a project-local input file through the VRAM manager. Use the returned name and subfolder in workflow inputs.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      requireEnabled(ctx.cwd);
      const client = await refreshAuth(ctx, ctx.cwd);
      return text(await client.comfy.uploadInput(await projectFile(ctx.cwd, args.path)));
    },
  });
  pi.registerTool({
    name: 'comfy_inspect', label: 'Inspect ComfyUI',
    description: 'List available ComfyUI node classes, or inspect one class and its inputs/model choices.',
    parameters: Type.Object({ nodeClass: Type.Optional(Type.String()) }),
    async execute(_id, args, _signal, _update, ctx) {
      requireEnabled(ctx.cwd);
      const info = await (await refreshAuth(ctx, ctx.cwd)).comfy.objectInfo();
      if (args.nodeClass) {
        if (!Object.hasOwn(info, args.nodeClass)) throw new Error(`Unknown node class: ${args.nodeClass}`);
        return text(info[args.nodeClass]);
      }
      return text({ classes: Object.keys(info).sort(), hint: 'Pass nodeClass to inspect inputs, outputs and model choices.' });
    },
  });
  pi.registerTool({
    name: 'comfy_workflow', label: 'Edit ComfyUI workflow', executionMode: 'sequential',
    description: 'Inspect, create, or patch a project-local API-format workflow JSON. Patch operations: setInput(nodeId,input,value), addNode(nodeId,node), removeNode(nodeId,disconnect?), connect(sourceNodeId,outputIndex,targetNodeId,input), disconnect(targetNodeId,input).',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('inspect'), Type.Literal('create'), Type.Literal('patch')]),
      path: Type.String(), workflow: Type.Optional(Type.Unknown()), patches: Type.Optional(Type.Array(Type.Unknown())),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      requireEnabled(ctx.cwd);
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
    description: 'Validate an API-format workflow against live ComfyUI node definitions and model choices.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      requireEnabled(ctx.cwd);
      return text(validateApiWorkflow(await readProjectJson(ctx.cwd, args.path), await (await refreshAuth(ctx, ctx.cwd)).comfy.objectInfo()));
    },
  });
  pi.registerTool({
    name: 'comfy_generate', label: 'Generate with ComfyUI', executionMode: 'sequential',
    description: 'Submit one or more prepared API workflows through the VRAM manager. Waits for completion, downloads output to the project, and never cancels a host job when Pi waiting is interrupted. Continue from /comfy.',
    promptGuidelines: ['Inspect node definitions and validate the workflow first.', 'Use exact installed model filenames and prepare inputs before generation.', 'Do not call ComfyUI or llama-server endpoints directly.'],
    parameters: Type.Object({ path: Type.Optional(Type.String()), paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 32 })) }),
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      requireEnabled(ctx.cwd);
      const { manager, comfy } = await refreshAuth(ctx, ctx.cwd);
      if (Boolean(args.path) === Boolean(args.paths)) throw new Error('Specify exactly one of path or paths');
      const local = await manager.readLocalRun<LocalRun>();
      if (local) throw new Error(`前回の生成 ${local.id} が未解決です。/comfy メニューから待機・復旧を続けてください。`);
      const paths = args.paths ?? [args.path!];
      const info = await comfy.objectInfo();
      const workflows: Workflow[] = [];
      for (const path of paths) {
        const workflow = await readProjectJson(ctx.cwd, path);
        const checked = validateApiWorkflow(workflow, info);
        if (!checked.valid) throw new Error(`${path}: ${JSON.stringify(checked.errors)}`);
        workflows.push(workflow as Workflow);
      }
      const id = createHash('sha256').update(`${ctx.cwd}\0${toolCallId}`).digest('hex');
      const record: LocalRun = { version: 1, id, startedAt: Date.now(), downloaded: {} };
      const before = await manager.status();
      if (busy(before)) throw new Error(`VRAM manager run ${before.id ?? ''} must finish before a new generation`);
      if (signal?.aborted) return { ...text({ state: 'cancelled', message: 'Generation was cancelled before submission.' }), terminate: true };
      await manager.saveLocalRun(record);
      onUpdate?.(text({ id, state: 'starting', message: 'VRAM managerへ生成を依頼しました。完了までPiは待機します。' }));
      try {
        let accepted: RunState;
        let attempted = false;
        while (true) {
          if (signal?.aborted) {
            if (attempted) return interrupted(ctx, { id, state: 'running', phase: 'submitting', completed: [] });
            await manager.clearLocalRun();
            return { ...text({ id, state: 'cancelled', message: 'Generation was cancelled before submission.' }), terminate: true };
          }
          try {
            attempted = true;
            accepted = await manager.generate({ id, modelId: ctx.model?.id, workflows }, signal);
            break;
          } catch (error) {
            if (signal?.aborted) return interrupted(ctx, { id, state: 'running', phase: 'submitting', completed: [] });
            if (!retryable(error)) {
              if (definitelyRejected(error)) await manager.clearLocalRun();
              throw error;
            }
            await delay(manager.config.timeouts.pollMs, signal);
          }
        }
        if (accepted.id && accepted.id !== id) throw new Error('VRAM manager accepted a different run ID');
        return await waitForRun(manager, comfy, record, accepted, signal, ctx);
      } catch (error) {
        if (signal?.aborted) return interrupted(ctx, { id, state: 'running', phase: 'waiting', completed: [] });
        if (definitelyRejected(error)) {
          ctx.abort();
          return { ...text({ id, state: 'failed', error: errorMessage(error) }), terminate: true };
        }
        ctx.abort();
        return { ...text({ id, state: 'recovery_required', error: errorMessage(error), message: '状態が確定できません。/comfy メニューから待機・復旧を続けてください。' }), terminate: true };
      }
    },
  });

  pi.registerCommand('comfy', {
    description: 'ComfyUIツールの有効・無効切替、状態確認、待機・復旧、接続設定',
    async handler(args, ctx) {
      try {
        const command = args.trim();
        const initialConfig = loadConfig(ctx.cwd);
        if (!initialConfig.enabled) {
          const status = 'ComfyUIツール: 無効';
          if (command === 'status' || !ctx.hasUI) { ctx.ui.notify(status, 'info'); return; }
          if (command) throw new Error('使い方: /comfy（操作メニュー）または /comfy status');
          const choice = await ctx.ui.select(status, ['ComfyUIツールを有効にする', '閉じる']);
          if (choice !== 'ComfyUIツールを有効にする') return;
          if (!ctx.isIdle()) throw new Error('Piが実行中のため切り替えできません。アイドル状態で再度お試しください。');
          await saveEnabled(ctx.cwd, true);
          setToolsEnabled(true);
          ctx.ui.notify('ComfyUIツールを有効にしました。次の推論リクエストから利用できます。', 'info');
          return;
        }
        if (command === 'status') {
          const { manager } = await refreshAuth(ctx, ctx.cwd);
          const state = await manager.status();
          const local = await manager.readLocalRun<LocalRun>();
          ctx.ui.notify(`ComfyUIツール: 有効\n${formatComfyStatus(state, local, manager.baseUrl, ctx.model?.id)}`, 'info');
          return;
        }
        if (command && command !== 'status') throw new Error('使い方: /comfy（操作メニュー）または /comfy status');
        if (!ctx.hasUI) {
          const { manager } = await refreshAuth(ctx, ctx.cwd);
          ctx.ui.notify(`ComfyUIツール: 有効\n${formatComfyStatus(await manager.status(), await manager.readLocalRun<LocalRun>(), manager.baseUrl, ctx.model?.id)}`, 'info');
          return;
        }

        // Keep menu entry available even when the manager is down so its URL can be repaired.
        const { manager } = await refreshAuth(ctx, ctx.cwd);
        const localAtOpen = await manager.readLocalRun<LocalRun>();
        let state: RunState | undefined;
        let statusError: string | undefined;
        try { state = await manager.status(); } catch (error) { statusError = errorMessage(error); }
        const lines = ['ComfyUIツール: 有効', formatComfyStatus(state, localAtOpen, manager.baseUrl, ctx.model?.id)];
        if (statusError) lines.push(`接続エラー: ${statusError}`);
        const unresolved = Boolean(localAtOpen) || (state && (busy(state) || state.state === 'recovery_required'));
        const choices = [
          '状態を表示',
          ...(unresolved ? ['生成の待機・復旧を続ける'] : []),
          ...(state && busy(state) ? ['生成をキャンセル'] : []),
          ...(!unresolved ? ['LLMを接続（現在のモデル）'] : []),
          '接続設定', 'ComfyUIツールを無効にする', '閉じる',
        ];
        const choice = await ctx.ui.select(lines.join('\n'), choices);
        if (!choice || choice === '閉じる') return;
        if (choice === 'ComfyUIツールを無効にする') {
          if (!ctx.isIdle()) throw new Error('Piが実行中のため切り替えできません。アイドル状態で再度お試しください。');
          await saveEnabled(ctx.cwd, false);
          setToolsEnabled(false);
          ctx.ui.notify('ComfyUIツールを無効にしました。次の推論リクエストから反映されます。実行中のホスト生成は継続します。', 'info');
          return;
        }
        if (choice === '状態を表示') {
          ctx.ui.notify(lines.join('\n'), statusError ? 'warning' : 'info'); return;
        }
        if (choice === '接続設定') {
          const setting = await ctx.ui.select('接続設定', ['接続先を変更', '接続先を初期値に戻す', '戻る']);
          if (setting && setting !== '戻る') {
            await configureManagerUrl(ctx, runtime(ctx.cwd), setting === '接続先を初期値に戻す');
            runtimes.delete(ctx.cwd);
          }
          return;
        }
        if (choice === 'LLMを接続（現在のモデル）') {
          await manager.connect(ctx.model?.id);
          ctx.ui.notify(`現在のモデル${ctx.model?.id ? ` (${ctx.model.id})` : ''}をLLMに接続しました。`, 'info');
          return;
        }
        if (choice === '生成をキャンセル') {
          const confirmed = await ctx.ui.select('実行中のComfyUI生成をキャンセルしますか？', ['戻る', 'キャンセルする']);
          if (confirmed !== 'キャンセルする') return;
          await manager.cancel(state?.id ?? localAtOpen?.id);
          ctx.ui.notify('生成のキャンセルを依頼しました。モデルの復帰が完了するまで /comfy で状態を確認できます。', 'info');
          return;
        }
        if (choice === '生成の待機・復旧を続ける') {
          let result: unknown;
          const local = await manager.readLocalRun<LocalRun>();
          let current = await manager.status();
          if (local && TERMINAL.has(current.state) && current.id === local.id) {
            const result = await waitForRun(manager, runtime(ctx.cwd).comfy, local, current, ctx.signal, ctx);
            notifyRunResult(ctx, result); return;
          }
          if (local && !busy(current) && (current.state === 'idle' || current.id !== local.id)) {
            await manager.clearLocalRun();
            ctx.ui.notify('ホスト側に該当する実行中の生成はありません。古いPi待機記録を削除しました。生成は再送していません。', 'info'); return;
          }
          if (current.state === 'recovery_required') {
            if (local && current.id && current.id !== local.id) throw new Error(`保存された生成 ${local.id} と管理側の生成 ${current.id} が一致しません。安全のため続行を止めました。`);
            current = await waitForRecovery(manager, await manager.recover(local?.id), ctx.signal, ctx);
            if (local && current.id === local.id && TERMINAL.has(current.state)) {
              const result = await waitForRun(manager, runtime(ctx.cwd).comfy, local, current, ctx.signal, ctx);
              notifyRunResult(ctx, result); return;
            }
            if (local && (TERMINAL.has(current.state) || current.state === 'idle')) {
              await manager.clearLocalRun();
              ctx.ui.notify('ホスト側の生成は終了していました。保存されたPiの待機記録を削除しました。生成は再送していません。', 'info'); return;
            }
          }
          if (!local && !busy(current)) { result = current; }
          else {
            const saved: LocalRun = local ?? { version: 1, id: current.id ?? '', startedAt: Date.now(), downloaded: {} };
            if (!saved.id) throw new Error('VRAM manager has no resumable run');
            if (!local) await manager.saveLocalRun(saved);
            if (current.id !== saved.id) throw new Error(`VRAM manager does not have saved run ${saved.id}; it will not be resubmitted`);
            result = await waitForRun(manager, runtime(ctx.cwd).comfy, saved, current, ctx.signal, ctx);
          }
          notifyRunResult(ctx, result); return;
        }
      } catch (error) { ctx.ui.notify(`${errorMessage(error)}\n操作メニュー: /comfy`, 'error'); }
    },
  });

  pi.on('input', async (_event, ctx) => {
    if (!loadConfig(ctx.cwd).enabled) return { action: 'continue' as const };
    const manager = (await refreshAuth(ctx, ctx.cwd)).manager;
    const local = await manager.readLocalRun<LocalRun>();
    let state: RunState;
    try { state = await manager.status(); }
    catch { if (local) { ctx.ui.notify('生成状態を確認できません。/comfy メニューから待機・復旧を続けてください。', 'warning'); return { action: 'handled' as const }; } return { action: 'continue' as const }; }
    if (local || busy(state)) {
      ctx.ui.notify('ComfyUI処理が実行中か復旧待ちです。/comfy メニューから状態を確認してください。', 'warning');
      return { action: 'handled' as const };
    }
    return { action: 'continue' as const };
  });

  async function ensureSetupAllowed(ctx: { cwd: string; isIdle(): boolean }, initial: Runtime): Promise<void> {
    if (!ctx.isIdle()) throw new Error('Cannot change the manager URL while Pi is running a turn or tool');
    if (runtimes.get(ctx.cwd) !== initial) throw new Error('接続設定中にランタイムが変わりました。/comfy からやり直してください。');
    const { manager } = initial;
    const local = await manager.readLocalRun<LocalRun>();
    if (local) throw new Error('前回の生成記録が残っています。/comfy メニューから待機・復旧を続けてから接続先を変更してください。');
    let state: RunState | undefined;
    try { state = await manager.status(); } catch { /* Connection settings must remain available when the manager is unreachable. */ }
    if (state && busy(state)) throw new Error('実行中または復旧が必要な間は接続先を変更できません。/comfy メニューから処理を解決してください。');
  }

  async function configureManagerUrl(ctx: SetupContext, initial: Runtime, reset: boolean): Promise<void> {
    await refreshAuth(ctx, ctx.cwd, initial);
    await ensureSetupAllowed(ctx, initial);
    const config = loadConfig(ctx.cwd);
    const defaultUrl = 'http://127.0.0.1:8090';
    const value = await ctx.ui.input(`VRAM manager URL (Enter: ${reset ? defaultUrl : config.managerUrl})`, reset ? '' : config.managerUrl);
    if (value === undefined) return;
    await ensureSetupAllowed(ctx, initial);
    await saveManagerUrl(ctx.cwd, value.trim() || (reset ? defaultUrl : config.managerUrl));
    ctx.ui.notify('VRAM manager接続先を保存しました。llama.cppの接続先も変更する場合は /login llama.cpp を実行してください。', 'info');
  }
}

function formatComfyStatus(state: RunState | undefined, local: LocalRun | undefined, managerUrl: string, modelId?: string): string {
  if (!state) return [`ComfyUI / VRAM manager`, `状態: 確認できません${local ? `（保存済み生成 ${local.id} の待機記録あり）` : ''}`, `接続先: ${managerUrl}`, `モデル: ${modelId ?? '未選択'}`, '次の操作: 接続設定からURLを確認してください。'].join('\n');
  const modelOperation = state.modelOperation && typeof state.modelOperation === 'object' ? state.modelOperation as Record<string, unknown> : undefined;
  const vram = state.vram ?? state.vramUsed ?? state.vram_used;
  const vramText = typeof vram === 'number' ? `${Math.round(vram / (vram > 1024 * 1024 ? 1024 * 1024 : 1))} MiB`
    : vram && typeof vram === 'object' && ('usedMiB' in vram || 'freeMiB' in vram)
      ? `使用 ${String((vram as Record<string, unknown>).usedMiB ?? '不明')} / 空き ${String((vram as Record<string, unknown>).freeMiB ?? '不明')} / 合計 ${String((vram as Record<string, unknown>).totalMiB ?? '不明')} MiB`
      : vram === undefined ? '不明' : typeof vram === 'object' ? JSON.stringify(vram) : String(vram);
  const stateLabel: Record<string, string> = { idle: '待機中', running: '実行中', complete: '完了', failed: '失敗', cancelled: 'キャンセル済み', recovery_required: '復旧が必要' };
  const phaseLabel: Record<string, string> = { idle: '待機中', queued: '待ち行列', generating: '生成中', starting: '起動中', loading_model: 'モデル読込中', unloading_model: 'モデル解放中', unloading_llm: 'LLM解放中', freeing_comfy: 'ComfyUIメモリ解放中', restoring_llm: 'LLM復元中', recovering: '復旧中', recovery_required: '復旧が必要', complete: '完了', failed: '失敗', cancelled: 'キャンセル済み', waiting_on_host: 'ホスト側の完了待ち' };
  const action = state.state === 'recovery_required' ? 'ComfyUIを再起動した場合は、起動後に「生成の待機・復旧を続ける」を選んでください。'
    : busy(state) ? 'メニューから待機を続けるか、必要なら生成をキャンセルできます。'
      : state.state === 'failed' ? 'エラーを確認し、必要ならComfyUIを復旧してください。'
        : '生成するには comfy_generate ツールを使えます。';
  const modelOperationLines = modelOperation ? [
    `モデル操作: ${String(modelOperation.operation ?? 'unknown')} ${String(modelOperation.model ?? '')} / ${String(modelOperation.phase ?? modelOperation.state ?? 'unknown')} / ${Math.floor(Number(modelOperation.elapsedMs ?? 0) / 1000)}秒`,
    ...(typeof modelOperation.error === 'string' ? [`モデル操作エラー: ${modelOperation.error}`] : []),
  ] : [];
  return [`ComfyUI / VRAM manager`, `状態: ${stateLabel[state.state] ?? state.state}`, `段階: ${state.phase ? phaseLabel[state.phase] ?? state.phase : '不明'}`, `管理サーバー: ${managerUrl}`, `モデル: ${modelId ?? '未選択'}`, `VRAM: ${vramText}`, ...modelOperationLines, ...(local ? [`Pi待機記録: ${local.id}`] : []), ...(state.error ? [`エラー: ${state.error}`] : []), `次の操作: ${action}`].join('\n');
}

function notifyRunResult(ctx: { ui: { notify(message: string, level?: string): void } }, value: unknown): void {
  const wrapper = value as { details?: unknown };
  const result = (wrapper.details ?? value) as { state?: string; completed?: Array<{ outputs?: Array<{ path?: string; filename?: string }> }>; error?: string };
  const outputs = result.completed?.flatMap(item => item.outputs ?? []).map(output => output.path ?? output.filename).filter(Boolean) ?? [];
  const message = result.state === 'complete' ? `生成が完了しました。${outputs.length ? `\n出力:\n${outputs.join('\n')}` : ''}`
    : result.state === 'recovery_required' ? `生成状態の復旧が必要です。/comfy メニューから再度お試しください。${result.error ? `\nエラー: ${result.error}` : ''}${outputs.length ? `\n取得済み出力:\n${outputs.join('\n')}` : ''}`
      : `生成状態: ${result.state ?? '不明'}${result.error ? `\nエラー: ${result.error}` : ''}${outputs.length ? `\n出力:\n${outputs.join('\n')}` : ''}`;
  ctx.ui.notify(message, result.state === 'failed' || result.state === 'recovery_required' ? 'warning' : 'info');
}

async function waitForRun(
  manager: ManagerClient, comfy: ComfyClient, local: LocalRun, initial: RunState, signal: AbortSignal | undefined,
  ctx: { abort(): void; hasUI?: boolean; ui?: { setStatus?: (key: string, value: string | undefined) => void } },
): Promise<ReturnType<typeof text>> {
  try { return await waitForRunImpl(manager, comfy, local, initial, signal, ctx); }
  finally { if (ctx.hasUI) ctx.ui?.setStatus?.('comfy', undefined); }
}

async function waitForRecovery(
  manager: ManagerClient, initial: RunState, signal: AbortSignal | undefined,
  ctx: { hasUI?: boolean; ui?: { setStatus?: (key: string, value: string | undefined) => void } },
): Promise<RunState> {
  let state = initial;
  let retry = manager.config.timeouts.pollMs;
  const started = Date.now();
  try {
    while (state.managerPhase === 'generation') {
      if (signal?.aborted) return state;
      updateWaitStatus(ctx, { ...state, phase: 'recovering' }, started);
      await delay(manager.config.timeouts.pollMs, signal);
      if (signal?.aborted) return state;
      try {
        const current = await manager.status();
        if (current.id !== state.id) throw new Error(`VRAM manager is tracking a different run (${current.id || 'idle'})`);
        state = current;
        retry = manager.config.timeouts.pollMs;
      } catch (error) {
        if (signal?.aborted) return state;
        if (!retryable(error)) throw error;
        await delay(retry, signal);
        retry = Math.min(15_000, Math.max(retry * 2, manager.config.timeouts.pollMs));
      }
    }
    return state;
  } finally { if (ctx.hasUI) ctx.ui?.setStatus?.('comfy', undefined); }
}

async function waitForRunImpl(
  manager: ManagerClient, comfy: ComfyClient, local: LocalRun, initial: RunState, signal: AbortSignal | undefined,
  ctx: { abort(): void; hasUI?: boolean; ui?: { setStatus?: (key: string, value: string | undefined) => void } },
): Promise<ReturnType<typeof text>> {
  let state = initial;
  let retry = manager.config.timeouts.pollMs;
  const started = local.startedAt;
  while (!TERMINAL.has(state.state)) {
    if (state.state === 'recovery_required') {
      ctx.abort();
      return { ...text(state), terminate: true };
    }
    if (signal?.aborted) return interrupted(ctx, state);
    updateWaitStatus(ctx, state, started);
    await delay(manager.config.timeouts.pollMs, signal);
    if (signal?.aborted) return interrupted(ctx, state);
    try {
      state = await manager.status();
      if (state.id !== local.id) throw new Error(`VRAM manager is tracking a different run (${state.id || 'idle'})`);
      retry = manager.config.timeouts.pollMs;
    } catch (error) {
      if (!retryable(error)) {
        ctx.abort();
        return { ...text({ id: local.id, state: 'recovery_required', error: errorMessage(error) }), terminate: true };
      }
      updateWaitStatus(ctx, { id: local.id, state: 'running', phase: 'manager_unavailable' }, started);
      await delay(retry, signal);
      retry = Math.min(15_000, Math.max(retry * 2, manager.config.timeouts.pollMs));
    }
  }

  const completed: Array<{ promptId: string; outputs: Array<Record<string, unknown>> }> = [];
  try {
    for (const result of state.completed ?? []) {
      const outputs: Array<Record<string, unknown>> = [];
      for (const [index, ref] of result.outputs.entries()) {
        const key = `${result.promptId}:${index}`;
        let path = local.downloaded[key];
        if (!path) {
          const downloaded = await comfy.downloadOutput(result.promptId, ref, index, signal);
          if (!downloaded.path) throw new Error('Output directory is not configured');
          path = downloaded.path;
        }
        local.downloaded[key] = path;
        await manager.saveLocalRun(local);
        outputs.push({ ...ref, path });
      }
      completed.push({ promptId: result.promptId, outputs });
    }
    await manager.clearLocalRun();
    return text({ ...state, completed });
  } catch (error) {
    if (signal?.aborted) return interrupted(ctx, state);
    updateWaitStatus(ctx, { ...state, phase: 'download_retry' }, started);
    ctx.abort();
    return { ...text({ ...state, state: 'recovery_required', error: errorMessage(error) }), terminate: true };
  }
}

function interrupted(ctx: { abort(): void; hasUI?: boolean; ui?: { setStatus?: (key: string, value: string | undefined) => void } }, state: RunState): ReturnType<typeof text> {
  ctx.abort();
  return { ...text({ ...state, state: 'recovery_required', phase: 'waiting_on_host', message: 'Piの待機を中断しました。ホスト生成は継続中です。/comfy メニューから再開できます。' }), terminate: true };
}
function updateWaitStatus(ctx: { hasUI?: boolean; ui?: { setStatus?: (key: string, text: string | undefined) => void } }, state: RunState, started: number): void {
  if (!ctx.hasUI) return;
  const elapsed = Math.floor((Date.now() - started) / 60_000);
  const phase = state.phase ? ` · ${state.phase}` : '';
  ctx.ui?.setStatus?.('comfy', `生成待機 ${elapsed}分${phase}`);
}
function busy(state: RunState): boolean { return state.state === 'running' || state.state === 'recovery_required'; }
function retryable(error: unknown): boolean {
  return error instanceof ManagerHttpError ? error.status === 429 || error.status >= 500
    : error instanceof TypeError || (error instanceof Error && error.name === 'AbortError');
}
function definitelyRejected(error: unknown): boolean { return error instanceof ManagerHttpError && error.status >= 400 && error.status < 500 && error.status !== 429; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Aborted')); return; }
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Aborted')); };
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
