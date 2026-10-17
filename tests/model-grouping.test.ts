import test from 'node:test';
import assert from 'node:assert/strict';
import {groupModelsForProvider, resolveActualModel} from '../src/config/model-grouping.js';

test('模型折叠：gemini 同族按思考强度后缀的模型自动折叠合并，左右键切换真实模型', () => {
  const models = [
    'gemini-3.8-flash',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-tiered',
    'gpt-oss-120b-medium',
  ];

  const grouped = groupModelsForProvider(models, 'antigravity', 'gemini-3.8-flash-high');

  // 1. 5 个 gemini-3.8 变体合并为一个，列表仅展示 2 个条目（gemini-3.8-flash 与 gpt-oss-120b-medium）
  assert.equal(grouped.length, 2);

  const gemini = grouped.find(g => g.baseModel === 'gemini-3.8-flash')!;
  assert.ok(gemini);
  assert.equal(gemini.isCurrent, true);
  assert.equal(gemini.currentEffort, 'high');
  assert.deepEqual(gemini.effortLevels, ['low', 'medium', 'high', 'auto']);

  // 2. 选择不同档位，自动映射回对应的真实底层模型 ID
  assert.equal(resolveActualModel(gemini, 'low').modelId, 'gemini-3.8-flash-low');
  assert.equal(resolveActualModel(gemini, 'medium').modelId, 'gemini-3.8-flash-medium');
  assert.equal(resolveActualModel(gemini, 'high').modelId, 'gemini-3.8-flash-high');
  assert.equal(resolveActualModel(gemini, 'auto').modelId, 'gemini-3.8-flash');

  // 3. 独立模型不被误合并
  const gpt = grouped.find(g => g.baseModel === 'gpt-oss-120b-medium')!;
  assert.ok(gpt);
  assert.equal(gpt.effortLevels.length, 0);
  assert.equal(resolveActualModel(gpt).modelId, 'gpt-oss-120b-medium');
});

test('模型折叠：claude-sonnet-4-6 与 claude-sonnet-4-6-thinking 合并', () => {
  const models = ['claude-sonnet-4-6', 'claude-sonnet-4-6-thinking'];
  const grouped = groupModelsForProvider(models, 'antigravity', 'claude-sonnet-4-6');

  assert.equal(grouped.length, 1);
  const claude = grouped[0]!;
  assert.equal(claude.baseModel, 'claude-sonnet-4-6');
  assert.deepEqual(claude.effortLevels, ['high', 'auto']);
  assert.equal(resolveActualModel(claude, 'high').modelId, 'claude-sonnet-4-6-thinking');
  assert.equal(resolveActualModel(claude, 'auto').modelId, 'claude-sonnet-4-6');
});

test('思考档位探测：DeepSeek 仅保留合法档位 (无 max)，Claude 支持 max，非思考模型为空', () => {
  const deepseek = groupModelsForProvider(['deepseek-chat', 'deepseek-reasoner'], 'deepseek', 'deepseek-reasoner');
  assert.equal(deepseek.length, 2);
  const reasoner = deepseek.find(m => m.baseModel === 'deepseek-reasoner')!;
  assert.ok(reasoner);
  // DeepSeek 官方支持 low, medium, high；绝无 max
  assert.deepEqual(reasoner.effortLevels, ['auto', 'off', 'low', 'medium', 'high']);
  assert.ok(!reasoner.effortLevels.includes('max'));

  const anthropic = groupModelsForProvider(['claude-3-7-sonnet'], 'anthropic', 'claude-3-7-sonnet');
  assert.equal(anthropic.length, 1);
  assert.deepEqual(anthropic[0]!.effortLevels, ['auto', 'off', 'low', 'medium', 'high', 'max']);

  const plain = groupModelsForProvider(['text-embedding-3-small'], 'openai', 'text-embedding-3-small');
  assert.equal(plain.length, 1);
  assert.deepEqual(plain[0]!.effortLevels, []);
});
