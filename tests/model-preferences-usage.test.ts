import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createApplication} from '../src/application.js';
import {loadConfig, modelSettings, type Config} from '../src/config/config.js';
import {preferenceSchema, StateFile} from '../src/config/model-preferences.js';
import {createProvider} from '../src/providers/http.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {AuthStorage} from '../src/providers/auth.js';
import {TokenMeter} from '../src/context/budget.js';
import {UsageLedger, usageLines} from '../src/context/usage.js';

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-preferences-'));
  await mkdir(join(cwd, '.logox'));
  await writeFile(join(cwd, '.logox', 'config.toml'), '[provider]\nname="local"\nmodel="first"\n[providers.local]\nbase_url="http://127.0.0.1:7777/v1"\n[models."local/first"]\ncontext_window=8192\nthinking_protocol="deepseek"\n[models."local/second"]\ncontext_window=8192\nthinking_protocol="deepseek"\n');
  const file = join(cwd, '.logox', 'state', 'model-preferences.json');
  const load = (overrides = {}, env = {}) => loadConfig(cwd, overrides, env, cwd, cwd);
  const app = async (config?: Config, sessionId = 'one') => createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config: config ?? await load(), sessionId, env: {}, authPath: join(cwd, 'auth.json')});
  return {cwd, file, load, app, cleanup: () => rm(cwd, {recursive: true, force: true})};
}
function configPage(app: Awaited<ReturnType<typeof createApplication>>) {
  const page = app.surfaces.getSnapshot(); assert.ok(page?.kind === 'page');
  return page.tabs.find(tab => tab.id === 'config')!.lines.join('\n');
}

test('重建应用与会话更换保留模型和档位；已解析 config 保留 env/CLI 优先级', async () => {
  const f = await fixture();
  const configFile = join(f.cwd, '.logox', 'config.toml');
  await writeFile(configFile, (await readFile(configFile, 'utf8')).replace('model="first"', 'model="first"\ncontext_window=4096\nmax_output_tokens=1024'));
  let app = await f.app();
  try {
    await app.submit('/model second'); await app.submit('/effort high'); await app.close();
    app = await f.app(await f.load(), 'other-session');
    const selectedConfig = await f.load();
    assert.equal(selectedConfig.provider.context_window, undefined, '上次模型不能继承配置中另一模型的窗口');
    assert.equal(selectedConfig.provider.max_output_tokens, undefined);
    await app.submit('/config'); assert.match(configPage(app), /(?:模型：|Model: )second/); assert.match(configPage(app), /(?:思考档位：|Thinking effort: )high/); app.surfaces.cancel();
    const env = await f.load({}, {LOGOX__PROVIDER__MODEL: 'first', LOGOX__PROVIDER__THINKING_EFFORT: 'off'});
    await app.close(); app = await f.app(env);
    await app.submit('/config'); assert.match(configPage(app), /(?:模型：|Model: )first/); assert.match(configPage(app), /(?:思考档位：|Thinking effort: )off/); app.surfaces.cancel();
    const cli = await f.load({provider: {model: 'second', thinking_effort: 'low'}}, {LOGOX__PROVIDER__MODEL: 'first'});
    assert.equal(cli.provider.model, 'second'); assert.equal(cli.provider.thinking_effort, 'low');
    const other = await mkdtemp(join(tmpdir(), 'logox-other-'));
    try {assert.equal((await loadConfig(other, {}, {}, other, other)).provider.model, '');} finally {await rm(other, {recursive: true, force: true});}
    assert.ok(!JSON.stringify(JSON.parse(await readFile(f.file, 'utf8'))).includes('key'));
  } finally {await app.close(); await f.cleanup();}
});

test('思考及提供商 picker 确认才写入；取消、无效档位、坏文件和保存失败保留选择', async () => {
  const f = await fixture(), app = await f.app();
  try {
    await app.submit('/effort'); await new Promise(resolve => setImmediate(resolve));
    let picker = app.surfaces.getSnapshot(); assert.ok(picker?.kind === 'picker'); assert.ok(picker.items.some(item => item.id === 'max')); assert.ok(!picker.items.some(item => item.id === 'medium'));
    app.surfaces.cancel(); await assert.rejects(readFile(f.file), {code: 'ENOENT'});
    await app.submit('/think low'); assert.equal(JSON.parse(await readFile(f.file, 'utf8')).effort, 'low');
    await assert.rejects(app.submit('/effort medium'), /未声明支持/);
    await app.submit('/provider'); await new Promise(resolve => setImmediate(resolve)); picker = app.surfaces.getSnapshot(); assert.ok(picker?.kind === 'picker');
    await app.surfaces.choose(picker.id, 'antigravity'); assert.equal(JSON.parse(await readFile(f.file, 'utf8')).provider, 'antigravity');
    await app.submit('/provider local first');
    await writeFile(f.file, '{broken'); await assert.rejects(app.submit('/model second'), /保存状态失败/);
    assert.equal(await readFile(f.file, 'utf8'), '{broken');
    await app.submit('/config'); assert.match(configPage(app), /(?:模型：|Model: )first/); app.surfaces.cancel();
    const diagnostics: string[] = [];
    assert.equal((await loadConfig(f.cwd, {}, {}, f.cwd, f.cwd, text => diagnostics.push(text))).provider.model, 'first'); assert.equal(diagnostics.length, 1);
    await rm(f.file); await mkdir(f.file); await assert.rejects(app.submit('/model second'), /保存状态失败/);
    await app.submit('/config'); assert.match(configPage(app), /(?:模型：|Model: )first/); app.surfaces.cancel();
  } finally {await app.close(); await f.cleanup();}
});

test('任务处理中拒绝思考与模型变更，取消后解除等待', async () => {
  const f = await fixture();
  const app = await createApplication({cwd: f.cwd, resourceOptions: {home: f.cwd, boundary: f.cwd}, config: await f.load(), authPath: join(f.cwd, 'auth.json'), env: {}, provider: {
    respond: async (_request, _delta, signal) => {await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true})); throw new Error('cancel');},
  }});
  try {
    await app.submit('synthetic'); await assert.rejects(app.submit('/effort high'), /任务处理中|Tasks are running/); await assert.rejects(app.submit('/model second'), /任务处理中|Tasks are running/);
    await assert.rejects(readFile(f.file), {code: 'ENOENT'});
  } finally {await app.close(); await f.cleanup();}
});

test('本地 HTTP 验证档位字段、摘要关闭优先、兼容接口无专有参数、Anthropic预算与缓存', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk; bodies.push(JSON.parse(text));
    response.setHeader('content-type', 'text/event-stream');
    if (request.url === '/messages') response.end([
      {type: 'message_start', message: {usage: {input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: '合成思考', signature: 'synthetic-signature'}},
      {type: 'content_block_start', index: 1, content_block: {type: 'text', text: 'ok'}},
      {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 4}},
    ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
    else response.end('data: ' + JSON.stringify({choices: [{delta: {content: 'ok'}, finish_reason: 'stop'}], usage: {prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60}}) + '\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const settings = {kind: 'openai_compat' as const, baseUrl: 'http://127.0.0.1:' + address.port, model: 'synthetic', key: '', temperature: 0.2, maxTokens: 16384, timeoutMs: 1000};
  const request = {system: 'synthetic', messages: [{role: 'user' as const, text: 'synthetic'}], tools: []};
  const signal = new AbortController().signal;
  try {
    const provider = createProvider({...settings, thinkingProtocol: 'deepseek', thinkingEffort: 'high', thinkingLevels: ['auto', 'off', 'low', 'high', 'max']});
    const turn = await provider.respond(request, () => {}, signal);
    assert.deepEqual(turn.usage, {input: 100, output: 10, cacheRead: 60}); assert.equal(bodies[0]!.reasoning_effort, 'high');
    await provider.respond({...request, thinking: false}, () => {}, signal); assert.deepEqual(bodies[1]!.thinking, {type: 'disabled'}); assert.ok(!Object.hasOwn(bodies[1]!, 'reasoning_effort'));
    await createProvider({...settings, thinkingEffort: 'high'}).respond({...request, thinking: false}, () => {}, signal);
    assert.ok(!Object.hasOwn(bodies[2]!, 'thinking')); assert.ok(!Object.hasOwn(bodies[2]!, 'reasoning_effort'));
    const native = createProvider({...settings, kind: 'anthropic', thinkingProtocol: 'anthropic-budget', thinkingEffort: 'high', thinkingLevels: ['auto', 'off', 'low', 'medium', 'high']});
    const nativeTurn = await native.respond({...request, maxTokens: 2048}, () => {}, signal);
    assert.deepEqual(nativeTurn.usage, {input: 35, output: 4, cacheRead: 20, cacheWrite: 5}); assert.equal(nativeTurn.message.signature, 'synthetic-signature');
    assert.deepEqual(bodies[3]!.thinking, {type: 'enabled', budget_tokens: 2047}); assert.ok(!Object.hasOwn(bodies[3]!, 'temperature'));
    await assert.rejects(native.respond({...request, maxTokens: 1024}, () => {}, signal), /1025/); assert.equal(bodies.length, 4);
    await native.respond({...request, thinking: false}, () => {}, signal); assert.deepEqual(bodies[4]!.thinking, {type: 'disabled'});
    await createProvider({...settings, thinkingProtocol: 'reasoning-effort', thinkingEffort: 'low', thinkingLevels: ['auto', 'off', 'low']}).respond(request, () => {}, signal);
    assert.equal(bodies[5]!.reasoning_effort, 'low'); assert.ok(!Object.hasOwn(bodies[5]!, 'thinking'));
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('唯一计量器按模型与任务/汇总保存，恢复不重算、会话角色隔离、缓存费用不重复', async () => {
  const f = await fixture();
  try {
    const config = await f.load({models: {'local/first': {prices: {input: 2, output: 4, cache_read: 0.5, cache_write: 3}}}});
    const messages: string[] = [], ledger = new UsageLedger(join(f.cwd, 'usage'), text => messages.push(text));
    const meter = new TokenMeter(), identity = JSON.stringify(['local', 'first', 'http://localhost', 'openai_compat', 8192]);
    meter.configureUsage(() => identity, record => ledger.record('session', 'logox', record));
    meter.observe({system: '', messages: [], tools: []}, {message: {role: 'assistant', text: 'ok'}, stop: 'complete', usage: {input: 100, output: 10, cacheRead: 60, cacheWrite: 10}}, {identity, window: 8192});
    meter.chargeUsage({input: 20, output: 2});
    meter.observe({system: '', messages: [], tools: []}, {message: {role: 'assistant', text: 'ok'}, stop: 'complete', usage: {input: 3, output: 1}}, {identity: JSON.stringify(['local', 'second']), window: 8192});
    assert.deepEqual(meter.spent, {input: 123, output: 13, cacheRead: 60, cacheWrite: 10});
    const lines = usageLines(meter.usageRecords(), config).join('\n');
    assert.match(lines, /0.000160 USD/); assert.match(lines, /汇总/); assert.match(lines, /未知/);
    await ledger.flush(); const restored = await ledger.read('session', 'logox'); assert.equal(restored.length, 3);
    const second = new TokenMeter(); second.configureUsage(() => identity, () => {}, restored); assert.deepEqual(second.spent, meter.spent);
    assert.deepEqual(await ledger.read('other', 'logox'), []); assert.deepEqual(await ledger.read('session', 'techne'), []); assert.deepEqual(messages, []);
    const before = second.spent.input; second.chargeUsage({input: 1, output: 1, cacheRead: Infinity}); assert.equal(second.spent.input, before);
    await ledger.record('session', 'logox', restored[0]!); await ledger.flush(); assert.equal((await ledger.read('session', 'logox')).length, 3);
    const registry = new ProviderRegistry(config, {}, fetch, new AuthStorage(join(f.cwd, 'auth.json')));
    assert.equal(modelSettings(config, {}).thinkingProtocol, 'deepseek'); assert.ok(registry.thinking().levels.includes('max'));
    const state = new StateFile(f.file, preferenceSchema); await state.save({version: 1, provider: 'unknown', model: 'synthetic', effort: 'auto'});
    const diagnostics: string[] = []; assert.equal((await loadConfig(f.cwd, {}, {}, f.cwd, f.cwd, message => diagnostics.push(message))).provider.name, 'local'); assert.equal(diagnostics.length, 1);
  } finally {await f.cleanup();}
});

test('正式应用真实HTTP用量重启保留，模型切换不改旧归属，新会话从零开始', async () => {
  const f = await fixture(); let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    requests++;
    response.setHeader('content-type', 'text/event-stream');
    response.end('data: ' + JSON.stringify({choices: [{delta: {content: 'synthetic complete'}, finish_reason: 'stop'}], usage: {prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: {cached_tokens: 4}}}) + '\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const load = () => f.load({providers: {local: {base_url: 'http://127.0.0.1:' + address.port}}});
  let app = await f.app(await load(), 'http-session');
  try {
    const task = app.ensemble.dispatch('logox', 'synthetic request'); await task.done;
    const activity = app.store.activities.get('http-session', task.activityId)!;
    assert.equal(activity.status, 'completed', activity.detail + '\n' + JSON.stringify(app.contexts.status({sessionId: 'http-session', ownerId: 'logox'})));
    assert.equal(requests, 1); assert.deepEqual(app.contexts.meter({sessionId: 'http-session', ownerId: 'logox'}).spent, {input: 12, output: 3, cacheRead: 4, cacheWrite: 0});
    await app.submit('/model second'); await app.close(); app = await f.app(await load(), 'http-session');
    await app.submit('/usage');
    const page = app.surfaces.getSnapshot(); assert.ok(page?.kind === 'page'); assert.equal(page.initialTab, 'usage');
    const lines = page.tabs.find(tab => tab.id === 'usage')!.lines.join('\n'); assert.match(lines, /local\/first/); assert.match(lines, /12 \/ 3/); assert.doesNotMatch(lines, /local\/second/); app.surfaces.cancel();
    assert.equal(requests, 1, '恢复未重放请求');
    await app.close(); app = await f.app(await load(), 'new-session'); assert.equal(app.contexts.meter({sessionId: 'new-session', ownerId: 'logox'}).spent.input, 0);
    await app.submit('/config'); assert.match(configPage(app), /(?:模型：|Model: )second/); app.surfaces.cancel();
  } finally {await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup();}
});

test('已知官方模型与显式能力控制可用档位，协议不匹配明确拒绝', async () => {
  const f = await fixture();
  try {
    const native = await f.load({provider: {name: 'anthropic', model: 'claude-opus-4-6'}});
    const settings = modelSettings(native, {}); assert.equal(settings.thinkingProtocol, 'anthropic-adaptive'); assert.ok(settings.thinkingLevels?.includes('max'));
    const bodies: Record<string, unknown>[] = [], fetcher: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: ' + JSON.stringify({type: 'message_delta', delta: {stop_reason: 'end_turn'}}) + '\n\n');
    };
    const request = {system: '', messages: [], tools: []}, signal = new AbortController().signal;
    const provider = createProvider({...settings, thinkingEffort: 'max'}, fetcher);
    await provider.respond(request, () => {}, signal); assert.deepEqual(bodies[0]!.thinking, {type: 'adaptive'}); assert.deepEqual(bodies[0]!.output_config, {effort: 'max'});
    await provider.respond({...request, thinking: false}, () => {}, signal); assert.deepEqual(bodies[1]!.thinking, {type: 'disabled'}); assert.ok(!Object.hasOwn(bodies[1]!, 'output_config'));
    const bad = await f.load({models: {'local/first': {thinking_protocol: 'anthropic-budget'}}}); assert.throws(() => modelSettings(bad, {}), /不匹配/);
    const deepseek = await f.load({provider: {name: 'deepseek', model: 'deepseek-flash'}}); assert.deepEqual(modelSettings(deepseek, {}).thinkingLevels, ['auto', 'off', 'low', 'high', 'max']);
    const plain = await f.load({models: {'local/first': {thinking_protocol: undefined}}}); assert.equal(modelSettings(plain, {}).thinkingProtocol, undefined);
  } finally {await f.cleanup();}
});
