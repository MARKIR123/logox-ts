import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Resources, type SkillVisibility} from '../resources/manager.js';
import type {ActorExecutor} from '../actors/ensemble.js';
import {builtinActors} from '../actors/builtins.js';
import type {RuntimeStore} from '../runtime/store.js';
import {normalizeMessages, type ModelMessage, type ModelRequest, type Provider, type ToolCall, type ToolDefinition} from '../runtime/messages.js';
import {ProviderError, isProviderInterruption} from '../providers/http.js';
import {Tools, toolDefinitions, validToolCall, validateToolCall, type ToolResult} from '../tools/tools.js';

import type {ContextManager} from '../context/manager.js';
import {inputKind, inputMessage} from '../runtime/provenance.js';
import {Steps} from '../runtime/steps.js';
import type {Step} from '../runtime/contracts.js';
import type {TaskModels} from '../actors/task-models.js';
import {TaskProgress, taskProgressTool} from '../runtime/task-progress.js';
import {ActorRecovery} from '../actors/recovery.js';
import {ExecutionRecoveryError, executionRecoveryInstruction, toolProgressFingerprint, type ExecutionRecoveryKind} from './execution-recovery.js';
import {composeBaseSystemPrompt, composeRuntimeSystemPrompt} from '../prompts/index.js';
import {maybePersistLargeOutput} from './scratchpad.js';

export class UserCancelledError extends Error {
  readonly stopReason = 'user' as const;
  constructor(message = '已达到本轮执行额度，用户选择停止') {
    super(message);
    this.name = 'UserCancelledError';
  }
}

export interface AgentOptions {
  cwd: string;
  store: RuntimeStore;
  tools: Tools;
  provider(): Provider;
  taskModels?: TaskModels;
  requestBase?(context: Parameters<ActorExecutor<string>>[1]): Promise<{system: string; tools: readonly ToolDefinition[]}>;
  iterations: number;
  retries: number;
  retryProvider?(context: Parameters<ActorExecutor<string>>[1], error: ProviderError): Promise<boolean>;
  recoverExecution?(context: Parameters<ActorExecutor<string>>[1], kind: ExecutionRecoveryKind): Promise<'retry' | 'handoff' | 'stop'>;
  executionProgress?(context: Parameters<ActorExecutor<string>>[1], fingerprint: string): Promise<boolean>;
  executionNotice?(context: Parameters<ActorExecutor<string>>[1], text: string): void;
  readonlyConcurrency?: number;
  supportsVision?: boolean | (() => boolean);
  context?: ContextManager;
  resources?: Resources;
  extraTools?: readonly ToolDefinition[];
  /** 仅可信装配配置：这些扩展在执行器完整校验参数后自行调用 authorizeExtension。 */
  extraApprovalHandled?: readonly string[];
  executeExtra?(call: ToolCall, context: Parameters<ActorExecutor<string>>[1]): Promise<ToolResult>;
}
export async function agentRequestBase(cwd: string, ownerId: string, extraTools: readonly ToolDefinition[] = [], resources?: Resources,
  role?: {prompt: string; visibility: SkillVisibility}, includeSummary = true, scratchpadDir?: string) {
  const effective = resources ?? new Resources(cwd);
  if (!resources) await effective.reload();
  const rules = effective.prompt(role?.visibility);
  const builtin = builtinActors.find(actor => actor.id === ownerId);
  const {system} = composeBaseSystemPrompt({
    cwd,
    ownerId,
    builtinPrompt: builtin?.prompt,
    customPrompt: role?.prompt,
    rulesContext: rules.context,
    includeSummary,
    scratchpadDir,
  });
  return {system, tools: [...toolDefinitions, taskProgressTool, ...(role || ownerId === 'logox' ? extraTools : [])]};
}
export function createAgent(options: AgentOptions): ActorExecutor<string> {
  const localRecoveries = new Map<string, ActorRecovery>();
  const approvalHandled = new Set(options.extraApprovalHandled ?? []);
  for (const name of approvalHandled) if (!options.executeExtra || !options.extraTools?.some(tool => tool.name === name)) throw new Error('审批交接必须指向已装配扩展：' + name);
  const concurrency = options.readonlyConcurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('只读并发必须为 1–8');
  return async (prompt, context) => {
    const progress = new TaskProgress(options.store, context);
    const steps = new Steps(options.store, context, Date.now, () => progress.current());
    const root = context.rootActivityId ?? context.activityId;
    let localRecovery = localRecoveries.get(context.sessionId);
    if (!localRecovery) {localRecovery = new ActorRecovery(context.sessionId); localRecoveries.set(context.sessionId, localRecovery);}
    const observeProgress = (fingerprint: string) => options.executionProgress?.(context, fingerprint) ?? localRecovery.progress(root, fingerprint);
    const taskModel = await options.taskModels?.begin(context);
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    try {
      const messages: ModelMessage[] = normalizeMessages(context.history.map(entry => entry.role === 'user' ? inputMessage(entry.text, entry)
        : entry.message ?? {role: entry.role === 'tool' ? 'user' : entry.role, text: entry.text}));
      messages.push(inputMessage(prompt, context));
      // 请求修复可能把未配对工具记录转换成 user；审批授权只取原始用户记录。
      const humanTexts = context.authorization ?? [...context.history.filter(entry => entry.role === 'user' && inputKind(entry) === 'human').map(entry => entry.text),
        ...(inputKind(context) === 'human' ? [prompt] : [])];
      const userRequests: ModelMessage[] = [...new Set(humanTexts)].slice(-8).map(text => ({role: 'user', text}));
      context = {...context, reviewMessages: () => [...userRequests, ...messages.filter(message => message.role === 'assistant')]};
      let instruction = await (options.requestBase?.(context) ?? agentRequestBase(options.cwd, context.ownerId, options.extraTools, options.resources));
      const persist = async (message: ModelMessage, step?: Step) => {await context.record(message, step); messages.push(message);};
      let iteration = 0;
      let recovery = '';
      let recoveringKind: ExecutionRecoveryKind | undefined;
      let adjustments = 0;
      const recoverOutput = async (kind: ExecutionRecoveryKind, thinkingId: string): Promise<void> => {
        context.signal.throwIfAborted();
        const decision = await (options.recoverExecution?.(context, kind) ?? localRecovery.execution(root, kind, context.ownerId));
        context.signal.throwIfAborted();
        const note = kind === 'no_delivery' ? '本次只有思考，缩小当前步骤并先交付可核对成果。'
          : kind === 'truncated_tools' ? '工具参数不完整，此批未执行，改为更小的完整调用。' : '输出已满，保留已有内容后从断点接续。';
        options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note}});
        options.executionNotice?.(context, note);
        if (decision !== 'retry') throw new ExecutionRecoveryError(kind, decision);
        context.report(kind === 'no_delivery' ? '调整中' : '接续中', note);
        recovery = executionRecoveryInstruction(kind, context.ownerId, adjustments++ > 0);
        recoveringKind = kind;
      };
      const foreignSignatures = new Set<string>();
      requestLoop: for (;;) {
        context.signal.throwIfAborted();
        if (options.requestBase) instruction = await options.requestBase(context);
        if (options.iterations > 0 && iteration >= options.iterations) {
          const outcome = await context.ask({kind: 'question', title: 'Continue this task? (继续这轮任务？)', questions: [{
            id: 'continue', header: 'Iterations', question: 'Reached ' + options.iterations + ' model round trips. Continue? (已达到 ' + options.iterations + ' 次模型往返。是否继续？)',
            options: [{id: 'yes', label: 'Continue', description: 'Add another budget quota of round trips.'}, {id: 'no', label: 'Stop', description: 'Keep current results and end task.'}],
          }]});
          if (outcome.status !== 'answered' || outcome.response.kind !== 'question' ||
            outcome.response.answers.continue?.type !== 'option' || outcome.response.answers.continue.optionId !== 'yes') {
            throw new UserCancelledError();
          }
          iteration = 0;
        }
        const definitions = context.recovery?.exhausted && !context.recovery.key.startsWith('execution:') ? instruction.tools :
          [...instruction.tools.filter(tool => tool.name !== taskProgressTool.name), taskProgressTool];
        const visionEnabled = typeof options.supportsVision === 'function' ? options.supportsVision() : (options.supportsVision ?? true);
        const baseSystem = composeRuntimeSystemPrompt({
          baseSystem: instruction.system,
          supportsVision: visionEnabled,
          progressInstruction: progress.instruction(),
          recoveryInstruction: recovery,
        });
        const base = {system: baseSystem,
          // 工具字段与校验不变；省去每份 schema 重复的草案版本 URL。
          tools: definitions.map(tool => {const {$schema: _, ...parameters} = tool.parameters; return {...tool, parameters};})};
        const prepared = await options.context?.prepare(context, base, context.signal);
        if (taskModel && prepared && prepared.model.identity !== taskModel.model().identity) {
          throw new ProviderError('任务模型与上下文预算身份不一致；请将 ContextManager.model 接入 TaskModels.model');
        }
        const projected = prepared?.request ?? {...base, messages: normalizeMessages(messages)};
        // 签名只属于生成它的模型；保留完整账本与工具配对，转用请求不回放旧签名思考。
        let request: ModelRequest = foreignSignatures.size ? {...projected, supportsVision: visionEnabled, messages: projected.messages.map(message =>
          message.role === 'assistant' && message.signature && foreignSignatures.has(message.signature)
            ? {role: 'assistant' as const, text: message.text, ...(message.toolCalls ? {toolCalls: message.toolCalls} : {})} : message)} : {...projected, supportsVision: visionEnabled};
        iteration++;
        context.report(recoveringKind ? recoveringKind === 'no_delivery' ? '调整中' : '接续中' : '模型处理中',
          recoveringKind ? recovery : '第 ' + iteration + ' 次往返');
        let emitted = false, textId: string | undefined;
        let thinkingId = steps.thinking();
        let turn;
        for (let attempt = 0;; attempt++) {
          try {
            turn = await (taskModel?.provider() ?? options.provider()).respond(request, delta => {
              emitted = true;
              const kind = delta.kind;
              if (kind === 'text' && steps.get(thinkingId).state === 'running') {
                steps.finish(thinkingId, 'completed'); steps.endGroup('completed'); steps.phase('text');
              }
              let id = kind === 'text' ? textId : thinkingId;
              if (!id) {
                id = options.store.message(context.sessionId, context.ownerId, 'assistant', '', {
                  activityId: context.activityId, ...(kind === 'reasoning' ? {kind: 'thinking' as const} : {}),
                });
                if (kind === 'text') textId = id;
              }
              options.store.appendMessage(id, delta.text);
            }, context.signal);
            options.store.flush();
            break;
          } catch (error) {
            options.store.flush();
            const interruption = isProviderInterruption(error);
            const retry = !context.signal.aborted && error instanceof ProviderError && error.retryable && attempt < options.retries &&
              (interruption ? await (options.retryProvider?.(context, error) ?? Promise.resolve(attempt < 2)) : !emitted);
            if (retry && interruption) {
              const snapshot = options.store.getSnapshot();
              const text = snapshot.messages.find(message => message.id === textId)?.text ?? '';
              const reasoning = snapshot.messages.find(message => message.id === thinkingId)?.text;
              const step = steps.finish(thinkingId, 'failed'); steps.endGroup('failed');
              // 失败尝试只留作历史阅读。重试复用原请求，不拼接半段回复或执行半截工具参数。
              if (emitted) await context.record({role: 'assistant', text, ...(reasoning ? {reasoning} : {}), contextExcluded: true}, step);
              thinkingId = steps.thinking(); textId = undefined; emitted = false;
              context.report('Network retry', 'Connection interrupted; retrying with non-streaming fallback...');
              const resume = steps.wait(thinkingId, 'Waiting for retry');
              try {await delay(Math.min(30_000, 500 * 2 ** attempt), undefined, {signal: context.signal});} finally {resume();}
              // 对齐 Claude Code：流式长连接被代理或中间网关重置后，重试自动降级为非流式请求，彻底规避长流超时
              request = {...request, stream: false};
              continue;
            }
            if (retry) {
              context.report('Network retry', 'Temporary connection failure; retrying (' + (attempt + 1) + ')...');
              const resume = steps.wait(thinkingId, 'Waiting for retry');
              try {await delay(Math.min(30_000, 500 * 2 ** attempt), undefined, {signal: context.signal});} finally {resume();}
              continue;
            }
            // 已显示的增量也保存，下一轮能看见中断前输出。
            const snapshot = options.store.getSnapshot();
            const text = snapshot.messages.find(message => message.id === textId)?.text ?? '';
            const reasoning = snapshot.messages.find(message => message.id === thinkingId)?.text;
            const step = steps.finish(thinkingId, context.signal.aborted ? 'cancelled' : 'failed');
            await persist({role: 'assistant', text, ...(reasoning ? {reasoning} : {})}, step);
            if (await taskModel?.fallback(error)) {
              for (const message of messages) if (message.role === 'assistant' && message.signature) foreignSignatures.add(message.signature);
              options.context?.meter(context).invalidate();
              recovery = '模型已转用。继续已有任务，已完成工具及其结果保留，不重复执行已完成操作。';
              continue requestLoop;
            }
            throw error;
          }
        }
        if (turn.message.text && !textId) {
          if (steps.get(thinkingId).state === 'running') steps.finish(thinkingId, 'completed');
          steps.endGroup('completed'); steps.phase('text');
          options.store.message(context.sessionId, context.ownerId, 'assistant', turn.message.text, {activityId: context.activityId});
        }
        if (turn.message.reasoning && !options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text) options.store.updateMessage(thinkingId, {text: turn.message.reasoning});
        const thinkingStep = steps.get(thinkingId).state === 'running' ? steps.finish(thinkingId, 'completed') : steps.get(thinkingId);
        const ids = new Set<string>();
        for (const call of turn.message.toolCalls ?? []) {
          if (!call.id || ids.has(call.id)) call.id = randomUUID();
          ids.add(call.id);
        }
        const calls = turn.message.toolCalls ?? [];
        if (calls.length) {
          const truncated = turn.stop !== 'tools' || calls.some(call => {
            try { JSON.parse(call.arguments); return false; } catch { return true; }
          });
          let schemaError: {callId: string; name: string; error: string} | undefined;
          if (!truncated) {
            for (const call of calls) {
              if (!base.tools.some(tool => tool.name === call.name)) {
                schemaError = {callId: call.id, name: call.name, error: '未知工具：' + call.name + '。可用工具：' + base.tools.map(t => t.name).join('、')};
                break;
              }
              const extra = call.name === taskProgressTool.name ? taskProgressTool : options.extraTools?.find(tool => tool.name === call.name);
              try {
                const args = JSON.parse(call.arguments);
                if (extra) {
                  const check = z.fromJSONSchema(extra.parameters).safeParse(args);
                  if (!check.success) {
                    schemaError = {callId: call.id, name: call.name, error: check.error.issues.map(i => `${i.path.join('.') || '参数'}: ${i.message}`).join('; ') + ' (参数校验失败)'};
                    break;
                  }
                } else {
                  const check = validateToolCall(call);
                  if (!check.valid) {
                    schemaError = {callId: call.id, name: call.name, error: check.error};
                    break;
                  }
                }
              } catch (e) {
                schemaError = {callId: call.id, name: call.name, error: e instanceof Error ? e.message : String(e)};
                break;
              }
            }
          }
          if (truncated) options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note: '工具参数不完整，此批未执行，改为更小的完整调用。'}});
          else if (schemaError) options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note: '工具参数校验未通过，整批未执行：' + schemaError.error}});
          await persist(truncated ? {...turn.message, toolsExcluded: true} : turn.message, steps.get(thinkingId));
          if (prepared) options.context?.observe(context, request, truncated ? {...turn, stop: 'other'} : turn, prepared.model);
          const completed = new Set<string>();
          const toolIds = new Map(calls.map(call => [call.id, steps.tool(call)]));
          try {
            const execute = async (call: ToolCall): Promise<ToolResult> => {
              if (truncated) return {text: '此批工具未执行：响应未正常结束或参数不完整。请重新发出完整工具调用。', isError: true};
              if (schemaError) {
                if (call.id === schemaError.callId) {
                  return {text: '工具 ' + call.name + ' 参数校验失败：' + schemaError.error + '。为防止部分副作用落盘，整批工具未执行。请修正后重新发出。', isError: true, disposition: 'error'};
                }
                return {text: '同批工具参数校验失败，为防止部分副作用落盘，此工具未执行。请修正后重新发出完整调用。', isError: true, disposition: 'error'};
              }
              context.signal.throwIfAborted();
              context.report('工具执行', call.name);
              const id = toolIds.get(call.id)!;
              const waiting = async <T>(reason: string, operation: () => Promise<T>): Promise<T> => {
                const resume = steps.wait(id, reason); try {return await operation();} finally {resume();}
              };
              const toolContext = {...context, startTool: () => steps.start(id), wait: (reason: string) => steps.wait(id, reason),
                permission: (input: Parameters<typeof context.permission>[0]) => waiting('等待许可', () => context.permission(input)),
                ask: (input: Parameters<typeof context.ask>[0]) => waiting('等待回答', () => context.ask(input))};
              if (call.name === taskProgressTool.name) {
                toolContext.startTool();
                const before = new Set(progress.snapshot().stages.filter(stage => stage.status === 'completed').map(stage => stage.id));
                const result = await progress.update(JSON.parse(call.arguments));
                if (!result.isError) for (const stage of progress.snapshot().stages) if (stage.status === 'completed' && !before.has(stage.id)) {
                  await observeProgress('stage:' + stage.result);
                }
                return result;
              }
              if (options.extraTools?.some(tool => tool.name === call.name) && options.executeExtra) {
                if (!approvalHandled.has(call.name)) {
                  if (!await options.tools.authorizeExtension(call, toolContext)) return {text: '扩展工具操作未获许可，请寻找其他方案。', isError: true, disposition: 'denied'};
                  toolContext.startTool();
                }
                return options.executeExtra(call, toolContext);
              }
              return options.tools.execute(call, toolContext);
            };
            for (let start = 0; start < calls.length;) {
              const readonly = (call: ToolCall) => ['read', 'glob', 'grep'].includes(call.name) && !options.extraTools?.some(tool => tool.name === call.name);
              let end = start + 1;
              if (!truncated && !schemaError && readonly(calls[start]!)) while (end < calls.length && readonly(calls[end]!)) end++;
              for (let offset = start; offset < end; offset += concurrency) {
                context.signal.throwIfAborted();
                const group = calls.slice(offset, Math.min(end, offset + concurrency));
                // 等所有已启动工具收尾，之后按模型序保存，取消也不会留下后台进程。
                const results = await Promise.allSettled(group.map(async call => {
                  const id = toolIds.get(call.id)!;
                  try {
                    const result = await execute(call);
                    steps.finish(id, context.signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'completed', call.name + '\n' + result.text,
                      result.isError ? result.disposition ?? 'error' : undefined);
                    return result;
                  } catch (error) {
                    steps.finish(id, context.signal.aborted ? 'cancelled' : 'failed', call.name + '\n' + (context.signal.aborted ? '工具已取消。' : String(error)));
                    throw error;
                  }
                }));
                for (let index = 0; index < group.length; index++) {
                  const call = group[index]!, settled = results[index]!;
                  const result: ToolResult = settled.status === 'fulfilled' ? settled.value : {text: context.signal.aborted ? '工具已取消。' : String(settled.reason), isError: true};
                  const persistedText = await maybePersistLargeOutput(result.text, options.cwd, call.id, context.sessionId);
                  const step = steps.get(toolIds.get(call.id)!);
                  const toolMessage: ModelMessage = {
                    role: 'tool', callId: call.id, name: call.name,
                    text: persistedText, isError: result.isError,
                    ...(result.images ? {images: [...result.images]} : {}),
                  };
                  await persist(toolMessage, step);
                  const fingerprint = !truncated && !schemaError ? toolProgressFingerprint(call, result) : undefined;
                  if (fingerprint) await observeProgress(fingerprint);
                  completed.add(call.id);
                }
              }
              start = end;
            }
          } finally {
            for (const call of calls) if (!completed.has(call.id)) {
              const step = steps.finish(toolIds.get(call.id)!, 'cancelled', call.name + '\n工具执行已中断，未取得完整结果。');
              await persist({role: 'tool', callId: call.id, name: call.name, text: '工具执行已中断，未取得完整结果。', isError: true}, step);
            }
          }
          if (truncated) await recoverOutput('truncated_tools', thinkingId);
          else {recovery = ''; recoveringKind = undefined;}
          continue;
        }
        if (prepared && !context.signal.aborted) options.context?.observe(context, request, turn, prepared.model);
        const kind: ExecutionRecoveryKind | undefined = !turn.message.text.trim() && ['complete', 'length'].includes(turn.stop) ? 'no_delivery' : turn.stop === 'length' ? 'truncated_text' : undefined;
        if (kind) {
          try {await recoverOutput(kind, thinkingId);}
          finally {await persist(turn.message, steps.get(thinkingId));}
        } else await persist(turn.message, thinkingStep);
        if (turn.stop === 'complete' && turn.message.text.trim()) {outcome = 'completed'; return;}
        if (turn.stop === 'other' || turn.stop === 'tools') throw new Error('模型未正常完成这一轮（缺少有效结束原因或工具调用）');
      }
    } finally {steps.close(context.signal.aborted ? 'cancelled' : outcome); await taskModel?.finish(context.signal.aborted ? 'cancelled' : outcome);}
  };
}
