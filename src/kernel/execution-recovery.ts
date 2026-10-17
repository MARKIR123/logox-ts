import {createHash} from 'node:crypto';
import type {ToolCall} from '../runtime/messages.js';
import type {ToolResult} from '../tools/tools.js';

export type ExecutionRecoveryKind = 'no_delivery' | 'truncated_text' | 'truncated_tools';
export type ExecutionRecoveryDecision = 'retry' | 'handoff' | 'stop';

/** 输出结束问题，不属于提供商故障；结束执行后由剧团按原根目标接管。 */
export class ExecutionRecoveryError extends Error {
  constructor(readonly kind: ExecutionRecoveryKind, readonly disposition: 'handoff' | 'stop', message?: string) {
    super(message ?? (kind === 'no_delivery' ? '模型只返回思考或空回复，未交付当前步骤成果'
      : kind === 'truncated_tools' ? '工具参数连续截断，未执行不完整调用' : '模型输出连续截断，已保留部分成果'));
    this.name = 'ExecutionRecoveryError';
  }
}

export function executionRecoveryInstruction(kind: ExecutionRecoveryKind, ownerId: string, adjustment = false): string {
  const next = kind === 'no_delivery'
    ? adjustment && ownerId === 'logox'
      ? 'Pivot action plan (改变下一步行动方案): Narrow current phase or delegate explicit smaller steps to a suitable actor. Deliver concrete artifacts or complete tool calls first.'
      : 'Previous turn returned only thinking or an empty response (output quota exhausted before tools were called). Narrow to the minimum deliverable step (最小可交付步骤), avoid drafting full files in thoughts, and immediately call tools to persist artifacts.'
    : kind === 'truncated_tools'
      ? 'Previous tool arguments were truncated; the entire batch was not executed (整批调用未执行). Issue smaller, complete tool calls without replaying completed tools.'
      : 'Previous output reached token limits. Continue the current step from the break point using existing text (沿已有正文从断点完成当前小步); do not replan or regenerate delivered content.';
  return next + ' Adhere to confirmed goals, active stage, and completed tool results. Do not bypass approval denials or change model effort tiers.';
}

const coordinationTools = new Set(['dispatch_role', 'craft_actor', 'read_actor', 'borrow_skill', 'update_task_progress',
  'request_assist', 'approve_assist', 'send_message', 'ask_user', 'ask', 'read_skill', 'list_skills']);

/** 参数 JSON 的属性顺序和格式差异不算新进展，重复读取同一结果也不刷新预算。 */
export function toolProgressFingerprint(call: ToolCall, result: ToolResult): string | undefined {
  if (result.isError || coordinationTools.has(call.name)) return;
  let argumentsValue: unknown;
  try {argumentsValue = JSON.parse(call.arguments);} catch {return;}
  return createHash('sha256').update(JSON.stringify([call.name, canonical(argumentsValue), result.text])).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
