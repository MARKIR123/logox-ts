/**
 * 模型目录智能折叠与档位合并
 * 将反代或提供商返回的大量按思考强度后缀命名的同族模型（如 *-low, *-medium, *-high, *-tiered, *-thinking）
 * 折叠合并为单一基准模型，支持通过 ← → 方向键直接切换底层思考档位与对应真实模型。
 */

const SUFFIX_REGEX = /^(.*?)-(low|medium|high|extra-low|max|tiered|thinking)$/;

export interface GroupedModelVariant {
  readonly id: string; // 实际模型 ID，例如 gemini-3.8-flash-high
  readonly effort: string; // 对应的档位，例如 high
}

export interface GroupedModel {
  readonly id: string; // 选择器中的选项 ID
  readonly baseModel: string; // 折叠后的显示基准名，例如 gemini-3.8-flash
  readonly provider: string;
  readonly isCurrent: boolean;
  readonly effortLevels: readonly string[];
  readonly currentEffort: string;
  readonly variantMap: Record<string, string>; // effort -> actual modelId
}

/**
 * 规整化模型名称后缀为标准思考档位
 */
function normalizeTier(suffix: string): string {
  if (suffix === 'thinking') return 'high';
  if (suffix === 'tiered') return 'auto';
  if (suffix === 'extra-low') return 'low';
  return suffix;
}

/**
 * 探测模型和提供商支持的思考档位
 */
export function detectEffortLevels(modelId: string, provider: string): readonly string[] {
  const cleanModel = modelId.toLowerCase();
  const cleanProvider = provider.toLowerCase();

  // 1. DeepSeek: 官方接口只支持 low, medium, high (以及 auto, off)
  if (cleanProvider === 'deepseek' || cleanModel.includes('deepseek') || cleanModel.includes('reasoner') || cleanModel.includes('r1')) {
    return ['auto', 'off', 'low', 'medium', 'high'];
  }
  // 2. Anthropic / Claude: 支持 low, medium, high, max (以及 auto, off)
  if (cleanProvider === 'anthropic' || cleanModel.includes('claude')) {
    return ['auto', 'off', 'low', 'medium', 'high', 'max'];
  }
  // 3. OpenAI Reasoning models (o1, o3, o4): 官方 reasoning_effort 仅支持 low, medium, high
  if (/^o[134](-|$)/.test(cleanModel) || cleanModel.includes('o1-') || cleanModel.includes('o3-')) {
    return ['low', 'medium', 'high'];
  }
  // 4. Gemini thinking / QwQ 等通识思考模型
  if (cleanModel.includes('thinking') || cleanModel.includes('qwq')) {
    return ['auto', 'off', 'low', 'medium', 'high', 'max'];
  }
  // 5. Antigravity 本地/代理提供商（若模型名自身含思考词）
  if (cleanProvider === 'antigravity' && (cleanModel.includes('thinking') || cleanModel.includes('gemini') || cleanModel.includes('claude'))) {
    return ['auto', 'off', 'low', 'medium', 'high', 'max'];
  }
  return [];
}

/**
 * 将同提供商的模型列表按族群折叠合并
 */
export function groupModelsForProvider(
  models: readonly string[],
  provider: string,
  currentModel: string
): GroupedModel[] {
  // 1. 扫描候选并按 baseModel 归组
  const groups = new Map<string, Array<{modelId: string; tier?: string}>>();

  for (const modelId of models) {
    const match = SUFFIX_REGEX.exec(modelId);
    if (match) {
      const base = match[1]!;
      const tier = normalizeTier(match[2]!);
      const list = groups.get(base) ?? [];
      list.push({modelId, tier});
      groups.set(base, list);
    } else {
      const list = groups.get(modelId) ?? [];
      list.push({modelId, tier: 'auto'});
      groups.set(modelId, list);
    }
  }

  const result: GroupedModel[] = [];

  for (const [base, items] of groups.entries()) {
    // 只有组内存在多个同族变体时，才进行折叠合并
    const hasVariants = items.length > 1;

    if (hasVariants) {
      const variantMap: Record<string, string> = {};
      const tiersSet = new Set<string>();

      for (const item of items) {
        const tier = item.tier ?? 'auto';
        if (!variantMap[tier] || item.modelId === base) {
          variantMap[tier] = item.modelId;
        }
        tiersSet.add(tier);
      }

      // 如果没有显式的 auto，指向基础名或默认项
      if (!variantMap['auto']) {
        const fallback = items.find(i => i.modelId === base)?.modelId ?? items[0]!.modelId;
        variantMap['auto'] = fallback;
        tiersSet.add('auto');
      }

      // 按照标准顺序排序展示档位
      const order = ['off', 'low', 'medium', 'high', 'max', 'auto'];
      const effortLevels = order.filter(t => tiersSet.has(t));

      // 判断当前是否在使用本族模型
      const matchingCurrent = items.find(i => i.modelId === currentModel);
      const isCurrent = Boolean(matchingCurrent || base === currentModel);
      const currentEffort = matchingCurrent?.tier ?? 'high';

      result.push({
        id: JSON.stringify([provider, base]),
        baseModel: base,
        provider,
        isCurrent,
        effortLevels,
        currentEffort: tiersSet.has(currentEffort) ? currentEffort : (effortLevels[0] ?? 'auto'),
        variantMap,
      });
    } else {
      // 独立模型，无后缀族群
      const single = items[0]!;
      const isCurrent = single.modelId === currentModel;
      const detectedLevels = detectEffortLevels(single.modelId, provider);
      result.push({
        id: JSON.stringify([provider, single.modelId]),
        baseModel: single.modelId,
        provider,
        isCurrent,
        effortLevels: detectedLevels,
        currentEffort: detectedLevels.includes('high') ? 'high' : (detectedLevels[0] ?? 'auto'),
        variantMap: {auto: single.modelId},
      });
    }
  }

  return result;
}

/**
 * 根据选定的基准模型与用户调节的思考档位，解析出实际请求的模型 ID
 */
export function resolveActualModel(
  grouped: GroupedModel,
  chosenEffort?: string
): {modelId: string; effort?: string} {
  const effort = chosenEffort ?? grouped.currentEffort;
  const actualModel = grouped.variantMap[effort] ?? grouped.variantMap['auto'] ?? grouped.baseModel;
  return {modelId: actualModel, effort};
}
