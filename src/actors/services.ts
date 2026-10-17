import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {ActorContext, TaskHandle, TaskOrigin, TaskResult} from './ensemble.js';
import {ActorRecovery, modelUnavailable} from './recovery.js';
import {isProviderInterruption, ProviderError} from '../providers/http.js';
import type {ActorCatalog} from './catalog.js';
import {ActorManagement} from './management.js';
import type {ActorDefinition} from './definitions.js';
import {builtinActors} from './builtins.js';
import {Collaboration} from './collaboration.js';
import type {Resources} from '../resources/manager.js';
import type {Journal} from '../store/journal.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {ToolCall, ToolDefinition} from '../runtime/messages.js';
import type {ToolResult} from '../tools/tools.js';
import {contextPolicySchema, type Config} from '../config/config.js';
import type {RoundStatus} from '../context/contracts.js';
import {ExecutionRecoveryError} from '../kernel/execution-recovery.js';
import {DISPATCH_ROLE_PROMPT, CRAFT_ACTOR_PROMPT, READ_ACTOR_PROMPT, BORROW_SKILL_PROMPT} from '../prompts/index.js';

const tasksSchema = z.strictObject({
  tasks: z.array(z.strictObject({
    ownerId: z.string(), prompt: z.string().trim().min(1),
    skills: z.array(z.string()).max(16).optional(), resumeTask: z.string().optional(),
    goal: z.string().optional(), constraints: z.array(z.string()).optional(),
    minDeliverable: z.string().optional(), stopCondition: z.string().optional(),
  })).max(16).default([]),
  resumeBatch: z.string().optional(),
}).refine(input => input.tasks.length > 0 || !!input.resumeBatch, '至少指定任务或待恢复批次');
const craftSchema = z.strictObject({content: z.string().min(1).max(65536)});
const historySchema = z.strictObject({ownerId: z.string(), activityId: z.string().optional()});
const borrowSchema = z.strictObject({name: z.string().min(1)});
const tool = (name: string, description: string, schema: z.ZodType): ToolDefinition => ({name, description, parameters: z.toJSONSchema(schema)});
const directorTools = [
  tool('dispatch_role', DISPATCH_ROLE_PROMPT.description, tasksSchema),
  tool('craft_actor', CRAFT_ACTOR_PROMPT.description, craftSchema),
  tool('read_actor', READ_ACTOR_PROMPT.description, historySchema),
];
const borrowTool = tool('borrow_skill', BORROW_SKILL_PROMPT.description, borrowSchema);

export interface ActorServicesOptions {
  sessionId: string; catalog: ActorCatalog; registry: ProviderRegistry; resources: Resources; journal: Journal; config: Config;
  enqueue(owner: string, prompt: string, source: string, origin?: TaskOrigin): TaskHandle;
  pauseBatch?(batchId: string): void;
  resumeBatch?(batchId: string): void;
  coordinationPath?: string;
  approve(context: ActorContext, review: {path: string; content: string; previous: string | undefined}): Promise<boolean>;
  requireIdle(): void;
  authorize?(call: ToolCall, context: ActorContext): Promise<boolean>;
}
/** 角色配置、单次技能借阅与摘要交接；执行队列仍由 Ensemble 拥有。 */
export class ActorServices {
  readonly management: ActorManagement;
  readonly collaboration: Collaboration;
  readonly recovery: ActorRecovery;
  private readonly definitions = new Map<string, ActorDefinition>();
  private readonly active = new Map<string, ActorDefinition>();
  private readonly borrowed = new Map<string, Set<string>>();
  private readonly depths = new Map<string, number>();
  private readonly origins = new Map<string, TaskOrigin>();
  private readonly stoppedActors = new Set<string>();
  private readonly continuedTasks = new Set<string>();
  private readonly resumableBatches = new Set<string>();
  private readonly dispatchSignatures = new Map<string, number>();
  private readonly groups = new Map<string, {remaining: Set<string>; reports: string[]; depth: number; batchId: string; origin: TaskOrigin; paused: boolean}>();
  constructor(readonly options: ActorServicesOptions) {
    this.management = new ActorManagement(options.catalog, options.registry, options.requireIdle, owner => this.policy(owner));
    this.collaboration = new Collaboration({...options, member: owner => !!options.catalog.find(owner)});
    this.recovery = new ActorRecovery(options.sessionId, options.coordinationPath);
  }
  definition(context: ActorContext): ActorDefinition {
    this.origins.set(context.activityId, context);
    let definition = this.definitions.get(context.activityId);
    if (!definition) {
      definition = this.options.catalog.find(context.ownerId);
      if (!definition) throw new Error('角色已不可用：' + context.ownerId);
      this.definitions.set(context.activityId, definition); this.active.set(context.ownerId, definition);
    }
    return definition;
  }
  policy(ownerId: string) {
    const role = this.active.get(ownerId) ?? this.options.catalog.find(ownerId);
    if (ownerId === 'logox' && role === builtinActors[0]) return this.options.config.context;
    return contextPolicySchema.parse({...this.options.config.context, ...role?.context});
  }
  contract(ownerId: string): string | undefined {return (this.active.get(ownerId) ?? this.options.catalog.find(ownerId))?.compression;}
  skills(context: ActorContext) {return {actorId: context.ownerId, skills: this.definition(context).skills,
    borrowed: [...this.borrowed.get(context.activityId) ?? []]};}
  tools(ownerId: string): readonly ToolDefinition[] {
    return [...(ownerId === 'logox' ? directorTools : [borrowTool]), ...this.collaboration.tools(ownerId)];
  }
  definitionsForValidation(): readonly ToolDefinition[] {return [...directorTools, borrowTool, ...this.collaboration.tools('logox'), ...this.collaboration.tools('actor')];}
  async execute(call: ToolCall, context: ActorContext): Promise<ToolResult> {
    try {
      if (!this.tools(context.ownerId).some(tool => tool.name === call.name)) throw new Error('角色无权执行此工具');
      const input: unknown = JSON.parse(call.arguments);
      z.fromJSONSchema(this.tools(context.ownerId).find(tool => tool.name === call.name)!.parameters).parse(input);
      if (call.name !== 'craft_actor' && this.options.authorize && !await this.options.authorize(call, context)) return {text: '角色操作未获许可，请寻找其他方案。', isError: true, disposition: 'denied'};
      if (call.name !== 'craft_actor') context.startTool?.();
      if (call.name === 'dispatch_role') {
        if (context.recovery?.exhausted) throw new Error('同一故障已补救两次，需要用户决定下一步，不能继续自动派工');
        const {tasks, resumeBatch} = tasksSchema.parse(input);
        const saved = tasks.some(task => task.resumeTask) ? await this.options.journal.activeTasks(context.sessionId) : [];
        const resumed = new Set<string>(), roots = new Set<string>();
        for (const task of tasks) {
          if (task.goal || task.minDeliverable || task.stopCondition || task.constraints?.length) {
            const parts: string[] = [];
            if (task.goal) parts.push('【User Goal / 用户目标】\n' + task.goal);
            if (task.constraints?.length) parts.push('【Confirmed Constraints / 硬约束】\n' + task.constraints.join('; '));
            if (task.minDeliverable) parts.push('【Minimum Deliverable / 本轮最小成果】\n' + task.minDeliverable + '\n(Deliver a runnable/usable version in the text channel; do not perform work entirely in thinking blocks)');
            if (task.stopCondition) parts.push('【Completion Criteria / 收尾条件】\n' + task.stopCondition + '\n(Return deliverables and findings once sufficient evidence is gathered; avoid unbounded exploration)');
            parts.push('【Task Instructions / 任务要求】\n' + task.prompt);
            task.prompt = parts.join('\n\n');
          }
          if (task.ownerId === 'logox' || !this.options.catalog.find(task.ownerId)) throw new Error('角色无效：' + task.ownerId);
          for (const name of task.skills ?? []) if (!this.options.resources.snapshot().skills.some(skill => skill.name === name)) throw new Error('技能不存在：' + name);
          if (task.resumeTask) {
            const previous = saved.find(previous => previous.activityId === task.resumeTask);
            if (!previous) throw new Error('续做活动不存在或不在当前会话有效历史中：' + task.resumeTask);
            if (previous.ownerId !== task.ownerId) throw new Error('续做角色不匹配：原活动属于 ' + previous.ownerId);
            if (previous.stopReason === 'user') throw new Error('该活动由用户主动停止，不能自动续做');
            if (previous.status !== 'failed') throw new Error('只能续做失败活动；该活动当前状态：' + previous.status);
            const root = previous.rootActivityId ?? previous.activityId;
            if (root !== (context.rootActivityId ?? context.activityId) && !this.recovery.canResume(context.activityId, root)) {
              throw new Error('续做目标未交接到当前任务，不能续做其它根目标');
            }
            if (resumed.has(task.resumeTask) || this.continuedTasks.has(task.resumeTask)) throw new Error('该失败活动已经安排续做，不能重复派发：' + task.resumeTask);
            roots.add(root);
            resumed.add(task.resumeTask);
            task.prompt = '【原 Actor 任务断点续做】\n原活动：' + previous.activityId + '\n原目标：' + previous.prompt +
              '\n继续要求：' + task.prompt + '\n先核对自身历史摘要和已完成工具结果，只做未完成部分。保留已有输出，不重新执行已成功的写入或命令；未完整生成的工具调用没有执行，审批拒绝仍有效。';
          }
        }
        if (roots.size > 1) throw new Error('一次派发不能混合不同根目标的续做，请分别安排');
        const rootActivityId = roots.values().next().value ?? context.rootActivityId ?? context.activityId;
        const currentSigs = this.recovery.signaturesCount(rootActivityId);
        const lastSigs = this.dispatchSignatures.get(rootActivityId) ?? 0;
        const hasProgress = currentSigs > lastSigs;
        if (hasProgress) this.dispatchSignatures.set(rootActivityId, currentSigs);
        const baseDepth = hasProgress ? 0 : (this.depths.get(context.activityId) ?? 0);
        if (tasks.some(task => !task.resumeTask) && baseDepth >= 3) {
          throw new Error('已达到三次无新进展的角色调度，请根据已有结果收束任务');
        }
        const grouped = new Map<string, {prompts: string[]; skills: Set<string>; resumeTaskId?: string}>();
        for (const task of tasks) {
          const group = grouped.get(task.ownerId) ?? {prompts: [], skills: new Set<string>(), ...(task.resumeTask ? {resumeTaskId: task.resumeTask} : {})};
          if (task.resumeTask && group.resumeTaskId && task.resumeTask !== group.resumeTaskId) throw new Error('同一角色一次只能续做一个原活动，不能合并不同断点');
          if (task.resumeTask) group.resumeTaskId = task.resumeTask;
          group.prompts.push(task.prompt); for (const skill of task.skills ?? []) group.skills.add(skill); grouped.set(task.ownerId, group);
        }
        if (resumeBatch) {
          const group = [...this.groups.values()].find(group => group.batchId === resumeBatch);
          const finishedBatch = !group && saved.some(previous => previous.batchId === resumeBatch && resumed.has(previous.activityId)) &&
            !saved.some(previous => previous.batchId === resumeBatch && !['completed', 'failed', 'cancelled'].includes(previous.status));
          if (!finishedBatch && (!group || (group.origin.rootActivityId !== rootActivityId && !this.resumableBatches.has(resumeBatch)))) {
            throw new Error('不能恢复其它任务或不存在的批次');
          }
          if (group) {this.resumableBatches.delete(resumeBatch); group.paused = false; this.options.resumeBatch?.(resumeBatch);}
          if (!tasks.length) return {text: '已恢复原批次：' + resumeBatch, isError: false};
        }
        const origin: TaskOrigin = {parentActivityId: context.activityId, rootActivityId,
          inputKind: 'director', authorization: context.reviewMessages?.().filter(message => message.role === 'user').map(message => message.text).slice(-8) ?? context.authorization ?? [],
          ...(context.recovery ? {recovery: context.recovery} : {})};
        const nextDepth = baseDepth + (tasks.every(task => task.resumeTask) ? 0 : 1);
        const group = {remaining: new Set<string>(), reports: [] as string[], depth: nextDepth, batchId: randomUUID(), origin, paused: false};
        const handles = [...grouped].map(([owner, task]) => {
          const childOrigin = {...origin, batchId: group.batchId, ...(task.resumeTaskId ? {resumeTaskId: task.resumeTaskId} : {})};
          const handle = this.options.enqueue(owner, task.prompts.join('\n\n'), 'logox', childOrigin);
          this.origins.set(handle.activityId, childOrigin);
          this.depths.set(handle.activityId, nextDepth); this.borrowed.set(handle.activityId, task.skills);
          group.remaining.add(handle.activityId); this.groups.set(handle.activityId, group);
          return handle;
        });
        for (const activityId of resumed) this.continuedTasks.add(activityId);
        return {text: '角色任务已排队（批次 ' + group.batchId + '）：' + handles.map(handle => handle.activityId).join('、'), isError: false};
      }
      if (call.name === 'craft_actor') {
        const {content} = craftSchema.parse(input);
        const result = await this.management.craftActor(content, async review => {
          const allowed = await this.options.approve(context, review); if (allowed) context.startTool?.(); return allowed;
        }, context.signal);
        return {text: (result.status === 'saved' ? '已保存并重载：' : '用户拒绝，未写入：') + result.path, isError: result.status === 'denied', ...(result.status === 'denied' ? {disposition: 'denied' as const} : {})};
      }
      if (call.name === 'read_actor') {
        const {ownerId, activityId} = historySchema.parse(input);
        const entries = await this.options.journal.load(context.sessionId, ownerId);
        const rounds = await this.options.journal.rounds(context.sessionId, ownerId, entries);
        const relevantRounds = rounds.filter(round => !activityId || round.activityId === activityId).slice(-4);
        const relevantEntries = entries.filter(entry => !activityId || entry.activityId === activityId);
        const finalAssistant = relevantEntries.findLast(entry => entry.role === 'assistant' && entry.text.trim());
        const toolsCalled = [...new Set(relevantEntries.flatMap(e => (e.message && e.message.role === 'assistant' ? e.message.toolCalls?.map(c => c.name) ?? [] : [])))];

        const summaryText = relevantRounds.map(r => `[Round ${r.activityId}]: ${r.summary.title}\n${r.summary.report}`).join('\n\n');
        const report = [
          `# Subagent Report: ${ownerId}`,
          summaryText ? summaryText : (finalAssistant?.text ? `Final Output:\n${finalAssistant.text}` : 'No text response recorded.'),
          toolsCalled.length ? `Tools executed: ${toolsCalled.join(', ')}` : '',
        ].filter(Boolean).join('\n\n');

        return {text: report.slice(0, 4000), isError: false};
      }
      if (call.name === 'borrow_skill') {
        const {name} = borrowSchema.parse(input);
        if (!this.options.resources.snapshot().skills.some(skill => skill.name === name)) throw new Error('技能不存在');
        const borrowed = this.borrowed.get(context.activityId) ?? new Set<string>(); borrowed.add(name); this.borrowed.set(context.activityId, borrowed);
        return {text: '本任务已借阅 ' + name + '；请读取技能正文后使用。', isError: false};
      }
      const collab = await this.collaboration.execute(call, context);
      return {text: collab.text, isError: collab.isError, ...(collab.images ? {images: collab.images} : {})};
    } catch (error) {return {text: error instanceof Error ? error.message : '角色操作失败', isError: true};}
  }
  stopDirector(_activityId: string): void {this.recovery.stop();}
  stopActor(activityId: string): void {
    this.stoppedActors.add(activityId);
    const group = this.groups.get(activityId);
    const batchId = group?.batchId ?? this.origins.get(activityId)?.batchId;
    if (group) group.paused = true;
    if (batchId) this.options.pauseBatch?.(batchId);
  }
  resumeDirector(activityId?: string): string {
    const report = this.recovery.resume(activityId);
    const batches = [...new Set([...this.groups.values()].filter(group => group.paused).map(group => group.batchId))];
    if (activityId) for (const batch of batches) this.resumableBatches.add(batch);
    return [report, batches.length ? '此前依赖任务仍暂停。先根据用户新指示判断；需要续做时用 dispatch_role({resumeBatch: "批次ID"}) 恢复已有队列，不重复派发。批次：' + batches.join('、') : ''].filter(Boolean).join('\n');
  }
  recover(validActivities?: ReadonlySet<string>): Promise<void> {return this.recovery.recover(validActivities);}
  flush(): Promise<void> {return this.recovery.flush();}
  async handoff(result: Omit<TaskResult, 'sessionId'> & {sessionId?: string}) {
    const group = this.groups.get(result.activityId);
    const executionError = result.error instanceof ExecutionRecoveryError ? result.error : undefined;
    if (result.ownerId === 'logox' && (result.status === 'completed' || (!result.recovery && !executionError))) return;
    const origin = group?.origin ?? this.origins.get(result.activityId) ?? result;
    const rootActivityId = origin.rootActivityId ?? result.rootActivityId ?? result.activityId;
    const cause = executionError?.message ?? (result.error instanceof ProviderError ? result.error.message : undefined);
    const failure = cause ? '\n终止原因（运行时）：' + cause + '。此前工具报错不等于本次终止原因，请分别判断。' : '';
    const report = `角色 ${result.ownerId} 任务 ${result.activityId}（${result.status}）${failure}\n标题：${result.summary.title}\n报告：${result.summary.report}`;
    if (group) {
      group.reports.push(report); group.remaining.delete(result.activityId); this.groups.delete(result.activityId);
    }
    if (result.stopReason === 'shutdown') return;
    const userStopped = result.stopReason === 'user' || this.stoppedActors.delete(result.activityId);
    if (userStopped) {
      if (group) group.paused = true;
      const batchId = group?.batchId ?? origin.batchId;
      if (batchId) this.options.pauseBatch?.(batchId);
      this.recovery.defer(rootActivityId, '用户主动停止了此角色任务，不要自动重试、重派或接替。\n' + report);
      return;
    }
    const failed = result.status !== 'completed';
    if (failed) {
      if (group) group.paused = true;
      const batchId = group?.batchId ?? origin.batchId;
      if (batchId) this.options.pauseBatch?.(batchId);
    }
    if (this.recovery.stopped() || modelUnavailable(result.error)) {
      this.recovery.defer(rootActivityId, report); return;
    }
    if (executionError?.disposition === 'stop' || (origin.recovery?.exhausted && !origin.recovery.key.startsWith('execution:'))) {
      this.recovery.defer(rootActivityId, report); return;
    }
    if (!failed && (result.source === 'direct' || !group || group.remaining.size || group.paused)) return;
    const recovery = failed ? executionError ? await this.recovery.directorClaim(rootActivityId, executionError.kind)
      : await this.recovery.next(rootActivityId, result.error, origin.recovery) : origin.recovery;
    if (executionError && !recovery) {this.recovery.defer(rootActivityId, report); return;}
    if (recovery) {
      const actorTask = !failed ? undefined : result.ownerId === 'logox' ? origin.recovery?.actorTask
        : isProviderInterruption(result.error) ? {ownerId: result.ownerId, activityId: result.activityId} : undefined;
      delete recovery.actorTask;
      if (actorTask) recovery.actorTask = actorTask;
    }
    if (this.recovery.stopped()) {this.recovery.defer(rootActivityId, report); return;}
    const instruction = executionError
      ? executionError.kind === 'no_delivery'
        ? 'Actor 已在原任务内纠偏，仍未交付当前步骤。根据已确认目标与已有成果，缩小当前阶段或调整分工；需要续做时用 resumeTask 指向原失败活动 ' + result.activityId + '，不能新建重复目标，不重放已完成工具。此次调整仍无交付则收束，向用户简短交代卡点。'
        : 'Actor 的自动接续已达上限，已保留合法正文与工具结果。核对部分成果和剩余工作，按实际成果决定下一步；不完整工具整批未执行，不再自动接续相同截断，不提高输出额度或重放已完成副作用。'
      : recovery?.exhausted
      ? '同一故障已自动补救两次。只简短说明原因、已完成内容和需要用户决定的下一步；不要执行工具或重新派工。'
      : failed && recovery?.actorTask ? '模型请求超时或连接中断，具体原因见运行时报告。优先指派原 Actor 从断点续做：dispatch_role(' +
          JSON.stringify({tasks: [{ownerId: recovery.actorTask.ownerId, resumeTask: recovery.actorTask.activityId,
            prompt: '从已保存进展继续原任务，只完成剩余部分。'}]}) +
          ')。已有工具结果和中断输出保留，不重放已完成副作用，不绕过审批拒绝；不要重新调查整项任务或直接接替 Actor。'
        : failed ? '角色任务异常终止，请立即核对已有结果并决定修复、续做、改派或自己接手；不要重放已完成副作用或绕过审批拒绝。'
        : '角色结果已返回。核对后继续原任务，不能把失败当成完成。';
    const batches = group?.paused && group.remaining.size ? '\n后续任务已暂停，批次：' + group.batchId + '。确认可继续时用 dispatch_role 的 resumeBatch 恢复，勿重复派发已有任务。' : '';
    const handle = this.options.enqueue('logox', instruction + batches + '\n' + (failed ? report : group!.reports.join('\n\n')),
      result.ownerId, {parentActivityId: result.activityId, rootActivityId, priority: failed, inputKind: 'actor',
        authorization: origin.authorization ?? [], ...(recovery ? {recovery} : {})});
    this.depths.set(handle.activityId, group?.depth ?? 0);
    this.origins.set(handle.activityId, {rootActivityId, ...(recovery ? {recovery} : {})});
  }
  async settled(activityId: string, status: RoundStatus) {
    await this.recovery.settled(activityId, status);
    await this.collaboration.settle(activityId, status);
    if (this.groups.has(activityId)) await this.handoff({ownerId: this.definitions.get(activityId)?.id ?? 'actor', activityId,
      source: 'logox', status, summary: {title: '任务未正常交接', report: '任务在排队或记录阶段结束，请核对状态。', source: 'local'},
      ...(status === 'cancelled' ? {stopReason: 'shutdown'} : {})});
    const definition = this.definitions.get(activityId);
    if (definition && this.active.get(definition.id) === definition) this.active.delete(definition.id);
    this.definitions.delete(activityId); this.borrowed.delete(activityId); this.depths.delete(activityId); this.origins.delete(activityId); this.stoppedActors.delete(activityId);
  }
}
