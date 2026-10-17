/**
 * 提示词缓存分水岭与结构化组装流水线
 * 参考 Claude Code 的 systemPromptSection 与 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 设计：
 * - 静态区段（核心人设、执行宪章、工具规范）：固定内容与顺序，实现最大化 Prompt Caching 命中；
 * - 动态区段（定制补充、工作目录、临时状态、任务推进与恢复）：沉底隔离，避免破坏静态前缀。
 */

import {summaryInstruction} from '../context/contracts.js';
import {CORE_EXECUTION_CHARTER, TOOL_USAGE_RULES, NO_VISION_NOTE} from './charter.js';
import {getScratchpadPromptSection} from '../kernel/scratchpad.js';

export const PROMPT_CACHE_BOUNDARY = '<!-- __LOGOX_PROMPT_CACHE_BOUNDARY__ -->';

export interface PromptSection {
  readonly name: string;
  readonly text: string;
  readonly dynamic?: boolean;
}

export interface ComposeSystemPromptOptions {
  cwd: string;
  ownerId: string;
  builtinPrompt?: string | undefined;
  customPrompt?: string | undefined;
  rulesContext?: string | undefined;
  includeSummary?: boolean | undefined;
  supportsVision?: boolean | undefined;
  progressInstruction?: string | undefined;
  recoveryInstruction?: string | undefined;
  scratchpadDir?: string | undefined;
}

/**
 * 组装基础系统提示词（对应 agentRequestBase）
 * 保留人设“只增不减”原则，并将各模块以高内聚静态切片形式清晰拼装。
 */
export function composeBaseSystemPrompt(options: {
  cwd: string;
  ownerId: string;
  builtinPrompt?: string | undefined;
  customPrompt?: string | undefined;
  rulesContext?: string | undefined;
  includeSummary?: boolean | undefined;
  scratchpadDir?: string | undefined;
}): {system: string; sections: PromptSection[]} {
  const {cwd, ownerId, builtinPrompt, customPrompt, rulesContext, includeSummary = true, scratchpadDir} = options;

  let resolvedPrompt = '';
  if (customPrompt) {
    if (builtinPrompt && customPrompt !== builtinPrompt && !customPrompt.includes(builtinPrompt)) {
      resolvedPrompt = builtinPrompt + '\n\n【定制补充人设】\n' + customPrompt;
    } else {
      resolvedPrompt = customPrompt;
    }
  } else {
    resolvedPrompt = builtinPrompt ?? '';
  }

  if (!resolvedPrompt) {
    throw new Error('角色没有有效人设：' + ownerId);
  }

  const sections: PromptSection[] = [
    {name: 'persona', text: resolvedPrompt},
    {name: 'environment', text: '工作目录：' + cwd},
    {name: 'tool_rules', text: TOOL_USAGE_RULES},
    {name: 'execution_charter', text: CORE_EXECUTION_CHARTER},
  ];

  if (scratchpadDir) {
    sections.push({name: 'scratchpad', text: getScratchpadPromptSection(scratchpadDir), dynamic: true});
  }

  if (rulesContext) {
    sections.push({name: 'rules_context', text: rulesContext, dynamic: true});
  }

  if (includeSummary) {
    sections.push({name: 'summary_instruction', text: summaryInstruction});
  }

  // 拼接为标准系统指令字符串，保持格式稳定与已有断言严格兼容
  const system = resolvedPrompt + '\n工作目录：' + cwd +
    '\n' + TOOL_USAGE_RULES +
    '\n' + CORE_EXECUTION_CHARTER +
    (scratchpadDir ? '\n' + getScratchpadPromptSection(scratchpadDir) : '') +
    (rulesContext ? '\n' + rulesContext : '') +
    (includeSummary ? summaryInstruction : '');
    (includeSummary ? summaryInstruction : '');

  return {system, sections};
}

/**
 * 组装单轮运行时系统提示词（叠加任务进度、视觉约束与自愈指令）
 */
export function composeRuntimeSystemPrompt(options: {
  baseSystem: string;
  supportsVision?: boolean | undefined;
  progressInstruction?: string | undefined;
  recoveryInstruction?: string | undefined;
}): string {
  const parts = [options.baseSystem];

  if (options.supportsVision === false) {
    parts.push(NO_VISION_NOTE);
  }

  if (options.progressInstruction) {
    parts.push(options.progressInstruction);
  }

  if (options.recoveryInstruction) {
    parts.push('Recovery notice: ' + options.recoveryInstruction);
  }

  return parts.join('\n');
}
