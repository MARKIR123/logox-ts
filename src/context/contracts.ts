import {z} from 'zod';
import type {ModelMessage} from '../runtime/messages.js';

import {roundSummarySchema as summarySchema, type RoundSummary} from '../runtime/contracts.js';
export {summarySchema, type RoundSummary};
export const terminalSchema = z.enum(['completed', 'failed', 'cancelled']);
export type RoundStatus = z.infer<typeof terminalSchema>;
export const roundSchema = z.strictObject({
  activityId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(),
  sourceHash: z.string(), status: terminalSchema, summary: summarySchema,
});
export type RoundRecord = z.infer<typeof roundSchema>;
export const contextStateSchema = z.strictObject({
  version: z.literal(1), sessionId: z.string(), ownerId: z.string(),
  sourceLength: z.number().int().nonnegative(), sourceHash: z.string(),
  folded: z.array(z.number().int().nonnegative()),
  archives: z.array(z.strictObject({callIndex: z.number().int().nonnegative(), resultIndex: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/)})),
  memo: z.strictObject({end: z.number().int().positive(), text: z.string().min(1)}).optional(),
  working: z.strictObject({start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1)}).optional(),
});
export type ContextState = z.infer<typeof contextStateSchema>;
export interface ModelCapacity {
  identity: string;
  window: number;
  maxOutput?: number;
}
export const summaryInstruction = '\n# Task Delivery & Round Summary\nYou must provide your final response and summary in the message text channel. Thinking is purely an internal scratchpad; internal thinking is never used as a deliverable. If you do not invoke a tool, you MUST provide a text response with the round summary in the user\'s language:\n【轮次摘要】\n标题：一句话结果\n报告：简短报告（保留目标、已确认决定、验证状态及未完成事项）。';

export function summarizeRound(messages: readonly ModelMessage[], status: RoundStatus): RoundSummary {
  messages = messages.filter(message => message.role !== 'assistant' || !message.contextExcluded);
  const final = messages.findLast(message => message.role === 'assistant' && message.text.trim())?.text ?? '';
  const match = /(?:【轮次摘要】|\[Round Summary\])\s*(?:标题|Title)[：:]\s*([^\n]+)\s*(?:报告|Report)[：:]\s*([\s\S]+)$/i.exec(final);
  const parsed = match ? summarySchema.safeParse({title: match[1], report: match[2], source: 'model'}) : undefined;
  if (status === 'completed' && parsed?.success) return parsed.data;
  const goal = messages.find(message => message.role === 'user')?.text ?? '';
  const tools = messages.filter(message => message.role === 'tool').slice(-4)
    .map(message => message.role === 'tool' ? message.name + '：' + (message.isError ? '失败/未执行；' : '') + message.text.slice(0, 140) : '');
  const label = status === 'completed' ? '完成' : status === 'cancelled' ? '已中断，需核对后续工作' : '执行失败，需继续处理';
  return {title: (status === 'completed' ? final.split('\n')[0]?.trim() || label : label).slice(0, 100),
    report: ['目标：' + goal.slice(0, 350), '状态：' + label, final ? '回复：' + final.slice(-850) : '没有完整助手回复。',
      ...tools].join('\n').slice(0, 2000), source: 'local'};
}

/** 供 Agent 的 requestBase 与历史归并共用角色契约。 */
export function roleSummaryInstruction(contract?: string): string {
  return summaryInstruction + (contract?.trim() ? "\n角色摘要保留重点：\n" + contract.trim() : "");
}
