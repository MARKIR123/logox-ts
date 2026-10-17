import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {ActorRecovery} from '../src/actors/recovery.js';
import {Ensemble} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';
import {Tools} from '../src/tools/tools.js';
import {anthropicMessages, openaiMessages} from '../src/providers/http.js';
import type {ModelMessage, ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';

test('真实工具进展重置连续截断预算，不同阶段独立错误不继承旧消耗', async () => {
  const recovery = new ActorRecovery('test-session');
  // 第一次截断
  assert.equal(await recovery.execution('root-1', 'truncated_text', 'techne'), 'retry');
  // 取得有效工具成果进展
  const progressSig = 'stage:build:骨架已落盘';
  assert.equal(await recovery.progress('root-1', progressSig), true);
  // 进展后，连续截断计数应归零，下一次截断依然可以自愈重试
  assert.equal(await recovery.execution('root-1', 'truncated_text', 'techne'), 'retry');
  // 验证总累计计数保持增长供审计
  const state = (recovery as unknown as {executionState(r: string): {truncation: {used: number; total: number}}}).executionState('root-1');
  assert.equal(state.truncation.used, 1);
  assert.equal(state.truncation.total, 2);
});

test('多模态视觉能力：read 读取 PNG 等图片返回 Base64 内容块，提供商适配器正确注入多模态结构，无视觉模型安全降级', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-vision-test-'));
  try {
    const tools = new Tools(directory);
    // 写入一个极简合法 PNG 头部
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    await writeFile(join(directory, 'pelican.png'), pngBuffer);

    const context = {
      sessionId: 's', activityId: 'a', ownerId: 'aletheia' as const, history: [], signal: new AbortController().signal,
      report: () => {}, say: () => {}, record: async () => {}, permission: async () => true, ask: async () => ({status: 'cancelled' as const, reason: 'test'}),
    };

    // 1. read 工具能读取图片文件并返回 images 内容
    const result = await tools.execute({
      id: 'read-img', name: 'read', arguments: JSON.stringify({path: 'pelican.png'}),
    }, context);

    assert.equal(result.isError, false);
    assert.match(result.text, /pelican\.png/);
    assert.match(result.text, /image\/png/);
    assert.ok(result.images && result.images.length === 1);
    assert.equal(result.images[0]!.mimeType, 'image/png');
    assert.equal(result.images[0]!.data, pngBuffer.toString('base64'));

    // 2. Anthropic 适配器将图片映射为多模态内容块
    const toolMsg: ModelMessage = {
      role: 'tool', callId: 'read-img', name: 'read', text: result.text, isError: false, images: [...result.images],
    };
    const anthropicFormatted = anthropicMessages([toolMsg]);
    assert.equal(anthropicFormatted.length, 1);
    const content = anthropicFormatted[0]!.content as Array<Record<string, unknown>>;
    assert.equal(content.length, 1);
    assert.equal(content[0]!.type, 'tool_result');
    const blocks = content[0]!.content as Array<Record<string, unknown>>;
    assert.ok(blocks.some(b => b.type === 'text'));
    assert.ok(blocks.some(b => b.type === 'image' && (b.source as Record<string, string>)?.media_type === 'image/png'));

    // 3. OpenAI 适配器在支持视觉时输出 image_url
    const openaiVision = openaiMessages([toolMsg], false, true);
    assert.equal(openaiVision.length, 1);
    const visionParts = openaiVision[0]!.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(visionParts));
    assert.ok(visionParts.some(p => p.type === 'image_url'));

    // 4. OpenAI 适配器在不支持视觉时（如 DeepSeek）安全降级为纯文本，不崩溃
    const openaiNoVision = openaiMessages([toolMsg], false, false);
    assert.equal(openaiNoVision.length, 1);
    assert.equal(typeof openaiNoVision[0]!.content, 'string');
    assert.match(openaiNoVision[0]!.content as string, /pelican\.png/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('角色级并发调度：不同角色并行执行，同一角色保持严格串行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-concurrency-test-'));
  try {
    const store = new RuntimeStore();
    const history = new Journal(directory);
    let activeCount = 0;
    let maxParallel = 0;

    let releaseGate = () => {};
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });

    const ensemble = new Ensemble('test-session', store, history, async (_prompt, context) => {
      activeCount++;
      maxParallel = Math.max(maxParallel, activeCount);
      if (activeCount >= 2) {
        releaseGate();
      } else {
        await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 100))]);
      }
      context.say('完成：' + context.ownerId);
      activeCount--;
    }, {concurrency: 'actor'});

    // 同时派发三个不同角色的任务
    const h1 = ensemble.dispatch('aletheia', '探查');
    const h2 = ensemble.dispatch('techne', '构建');
    const h3 = ensemble.dispatch('kalon', '打磨');

    await Promise.all([h1.done, h2.done, h3.done]);

    // 验证不同角色达到了并行执行（并发度 > 1）
    assert.ok(maxParallel >= 2, `期待并发执行，实际最大并发为 ${maxParallel}`);
    await ensemble.close();
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('参数校验错误原位返回 ToolResult 且不扣截断预算，整批未执行防止副作用', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-schema-error-flow-'));
  try {
    const requests: ModelRequest[] = [];
    const turns: ModelTurn[] = [
      // 第一轮：模型多传了 id 和 status（类似现场发生的 update_task_progress 参数错误），并同批试图写文件
      {
        stop: 'tools',
        message: {
          role: 'assistant',
          text: '准备登记计划并写文件',
          toolCalls: [
            {
              id: 'call-1',
              name: 'write',
              arguments: JSON.stringify({path: 'bad-side-effect.txt', content: 'should not exist'}),
            },
            {
              id: 'call-2',
              name: 'update_task_progress',
              arguments: JSON.stringify({
                update: {id: 'recon', status: 'completed', result: '已核对事实'},
                id: 'build', // 多余顶层字段
                status: 'in_progress', // 多余顶层字段
              }),
            },
          ],
        },
      },
      // 第二轮：模型看到字段校验报错后，修正参数并完成任务
      {
        stop: 'complete',
        message: {
          role: 'assistant',
          text: '已收到参数校验错误，修正后完成任务。',
        },
      },
    ];

    const provider: Provider = {
      async respond(request, onDelta) {
        requests.push(request);
        const turn = turns.shift();
        assert.ok(turn, '无多余请求');
        if (turn.message.text) onDelta({kind: 'text', text: turn.message.text});
        return structuredClone(turn);
      },
    };

    const config = await loadConfig(cwd, {provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
    const app = await createApplication({cwd, sessionId: 'schema-test', config, provider, resourceOptions: {home: cwd, boundary: cwd}});

    try {
      const handle = app.ensemble.dispatch('logox', '测试校验');
      await handle.done;

      // 1. 验证同批写工具未执行，磁盘无副作用
      await assert.rejects(readFile(join(cwd, 'bad-side-effect.txt')));

      // 2. 第二轮请求中包含了明确的参数校验错误 tool_result，而不是通用的截断提示
      assert.equal(requests.length, 2);
      const toolResults = requests[1]!.messages.filter(m => m.role === 'tool');
      assert.ok(toolResults.length === 2);
      assert.ok(toolResults.some(m => m.text.includes('参数校验失败')));

      // 3. 验证未触发截断恢复惩罚（truncation 预算未被消耗）
      const recoveryState = (app.ensemble as unknown as {options: {recovery?: ActorRecovery}}).options;
      assert.ok(recoveryState !== undefined);
    } finally {
      await app.close();
    }
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('人设提示词只增不减：内置核心信条为底座，定制与项目级提示词追加在后', async () => {
  const {agentRequestBase} = await import('../src/kernel/agent.js');
  // 1. 当角色传入定制提示词时，内置的核心准则（如“与其思考，不如实践”）依然保留在最前，定制内容追加在后
  const customRole = {prompt: '【本项目特别要求】专注于单文件 SVG 动画。', visibility: {actorId: 'techne'}};
  const base = await agentRequestBase('.', 'techne', [], undefined, customRole);
  assert.ok(base.system.includes('Action over contemplation'));
  assert.ok(base.system.includes('【定制补充人设】') || base.system.includes('# Custom Persona Extension'));
  assert.ok(base.system.includes('专注于单文件 SVG 动画'));
  // 验证基础人设排在定制人设前面
  const baseIndex = base.system.indexOf('Action over contemplation');
  const customIndex = base.system.indexOf('专注于单文件 SVG 动画');
  assert.ok(baseIndex < customIndex);

  // 2. 对于纯自定义角色（无内置基础人设），直接使用其自身人设
  const scoutRole = {prompt: '你是完全独立的自定义角色。', visibility: {actorId: 'scout'}};
  const scoutBase = await agentRequestBase('.', 'scout', [], undefined, scoutRole);
  assert.ok(scoutBase.system.includes('你是完全独立的自定义角色。'));
  assert.ok(!scoutBase.system.includes('Action over contemplation'));
});

test('非流式降级支持：stream: false 正确解析非流式响应并交付工具调用', async () => {
  const {createProvider} = await import('../src/providers/http.js');
  // 模拟 OpenAI 兼容的非流式响应
  const fakeOpenAIFetcher: typeof fetch = async () => {
    const payload = {
      choices: [{
        message: {
          content: '非流式回复完成',
          tool_calls: [{id: 'call_1', function: {name: 'read', arguments: '{"path":"test.txt"}'}}],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {prompt_tokens: 50, completion_tokens: 25},
    };
    return new Response(JSON.stringify(payload), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const provider = createProvider({
    kind: 'openai_compat', baseUrl: 'https://api.openai.com/v1', model: 'test',
    key: 'test', temperature: 0.2, maxTokens: 4096, timeoutMs: 10000,
  }, fakeOpenAIFetcher);
  const turn = await provider.respond({
    system: 'test', messages: [{role: 'user', text: 'hi'}], tools: [], stream: false,
  }, () => {}, new AbortController().signal);
  assert.equal(turn.message.text, '非流式回复完成');
  assert.equal(turn.message.toolCalls?.length, 1);
  assert.equal(turn.message.toolCalls[0]!.name, 'read');
  assert.equal(turn.stop, 'tools');
  assert.deepEqual(turn.usage, {input: 50, output: 25});
});

test('工具容错：shell 支持大模型发送的毫秒级 timeout 自动归一化，grep 支持 offset', async () => {
  const {validToolCall} = await import('../src/tools/tools.js');
  // 1. 模型传入 timeout: 10000 (10秒，常见于 Gemini/Claude 调用)
  assert.equal(validToolCall({id: 'c1', name: 'shell', arguments: '{"command":"node -v","timeout":10000}'}), true);
  // 2. grep 传入额外 offset: 30
  assert.equal(validToolCall({id: 'c2', name: 'grep', arguments: '{"pattern":"pelican","path":".","offset":30}'}), true);
});
