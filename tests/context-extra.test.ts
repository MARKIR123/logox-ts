import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {createProvider} from '../src/providers/http.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';

test('HTTP 输出额度按请求裁剪；Anthropic 缓存计入总输入，DeepSeek 汇总显式关闭 thinking', async () => {
  const requests: Record<string, unknown>[] = [];
  const frames = [
    {type: 'message_start', message: {usage: {input_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 20}}},
    {type: 'content_block_start', index: 0, content_block: {type: 'text', text: '结果'}},
    {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 7}},
  ];
  const native = createProvider({kind: 'anthropic', baseUrl: 'https://synthetic.invalid', model: 'fixture', key: '', temperature: 0.2, maxTokens: 1024, timeoutMs: 1000}, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''));
  });
  const request: ModelRequest = {system: 'summary', messages: [{role: 'user', text: 'history'}], tools: [], maxTokens: 64, thinking: false};
  const turn = await native.respond(request, () => {}, new AbortController().signal);
  assert.equal(requests[0]?.max_tokens, 64);
  assert.deepEqual(requests[0]?.thinking, {type: 'disabled'});
  assert.deepEqual(turn.usage, {input: 70, output: 7, cacheRead: 40, cacheWrite: 20});
  const compatible = createProvider({kind: 'openai_compat', baseUrl: 'https://synthetic.invalid', model: 'fixture', key: '', temperature: 0.2, maxTokens: 1024, timeoutMs: 1000, thinkingControl: true}, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('data: ' + JSON.stringify({choices: [{delta: {content: '摘要'}, finish_reason: 'stop'}], usage: {prompt_tokens: 70, completion_tokens: 7, prompt_tokens_details: {cached_tokens: 40}}}) + '\n\n');
  });
  const result = await compatible.respond({...request, messages: [...request.messages, {role: 'assistant', text: '历史摘要'}]}, () => {}, new AbortController().signal);
  assert.equal(requests[1]?.max_tokens, 64);
  assert.equal((requests[1]?.messages as Array<Record<string, unknown>>)[2]?.reasoning_content, '', '压缩摘要也满足 DeepSeek 的助手字段要求');
  assert.deepEqual(requests[1]?.thinking, {type: 'disabled'});
  assert.deepEqual(result.usage, {input: 70, output: 7, cacheRead: 40});
});

test('手动扬弃运行期间阻止新输入和切换，取消/关闭解除汇总等待且不产生业务任务', async () => {
  for (const close of [false, true]) {
    const cwd = await mkdtemp(join(tmpdir(), 'logox-compact-cancel-'));
    let calls = 0;
    let begin!: () => void;
    const started = new Promise<void>(resolve => {begin = resolve;});
    const provider: Provider = {async respond(_request, _delta, signal) {
      calls++; begin();
      await new Promise<void>((_resolve, reject) => {signal.addEventListener('abort', () => reject(signal.reason), {once: true});});
      throw new Error('取消后不能到达这里');
    }};
    const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 4096}, context: {keep_recent_rounds: 0}}, {}, cwd, cwd);
    const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, provider, sessionId: 'manual', env: {}, authPath: join(cwd, 'auth.json')});
    try {
      await app.journal.append({version: 1, sessionId: 'manual', ownerId: 'logox', activityId: 'old', role: 'user', text: '过去要求'.repeat(2200)});
      await app.journal.append({version: 1, sessionId: 'manual', ownerId: 'logox', activityId: 'old', role: 'assistant', text: '【轮次摘要】\n标题：已处理\n报告：保留确认要求。'});
      await app.journal.finish('manual', 'logox', 'old', 'completed');
      const compaction = app.submit('/compact');
      await started;
      assert.equal(calls, 1);
      await assert.rejects(app.submit('新的任务'), /(?:正在整理|Context is compacting)/);
      await assert.rejects(app.submit('/model other'), /(?:正在整理|Context is compacting)/);
      const activity = app.store.activities.list().find(item => item.status === 'running');
      assert.ok(activity);
      if (close) await app.close(); else app.cancel(activity.activityId);
      await compaction;
      assert.equal(app.store.activities.get('manual', activity.activityId)?.status, 'cancelled');
      const entries = await app.journal.load('manual', 'logox');
      assert.equal(entries.length, 2);
      assert.equal(await app.journal.loadContext('manual', 'logox', entries), undefined);
    } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
  }
});

test('未知模型窗口在调用前说明配置方法，终态与重启后的失败记录一致', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-unknown-window-'));
  let calls = 0;
  const provider: Provider = {async respond() {calls++; throw new Error('未知窗口不能发送');}};
  const config = await loadConfig(cwd, {provider: {model: 'unknown-fixture'}}, {}, cwd, cwd);
  let app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, provider, sessionId: 'unknown', env: {}, authPath: join(cwd, 'auth.json')});
  try {
    const task = app.ensemble.dispatch('logox', '你好');
    await task.done;
    assert.equal(calls, 0);
    assert.equal(app.store.activities.get('unknown', task.activityId)?.status, 'failed');
    assert.match(app.store.activities.get('unknown', task.activityId)!.detail, /context_window/);
    await app.close();
    app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, provider, sessionId: 'unknown', env: {}, authPath: join(cwd, 'auth.json')});
    assert.equal(calls, 0);
    assert.equal(app.store.activities.get('unknown', task.activityId)?.status, 'failed');
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
