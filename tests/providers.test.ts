import test from 'node:test';
import assert from 'node:assert/strict';
import {createProvider, ProviderError} from '../src/providers/http.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {AuthStorage} from '../src/providers/auth.js';
import {loadConfig} from '../src/config/config.js';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('云端兼容流允许空用量，保留推理、正文和最终真实用量', async () => {
  const frames = [
    {choices: [{delta: {role: 'assistant', content: null, reasoning_content: ''}, finish_reason: null}], usage: null},
    {choices: [{delta: {content: null, reasoning_content: '核对'}}], usage: null},
    {choices: [{delta: {content: 'LOGOX_PROVIDER_READY'}, finish_reason: 'stop'}], usage: null},
    {choices: [], usage: {prompt_tokens: 8, completion_tokens: 5}},
  ];
  const fetcher: typeof fetch = async () => new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n');
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'https://example.com/v1', model: 'test', key: 'test',
    temperature: 0.2, maxTokens: 256, timeoutMs: 1000}, fetcher);
  const deltas: string[] = [];
  const turn = await provider.respond({system: 'test', messages: [{role: 'user', text: 'test'}], tools: []}, delta => deltas.push(delta.text), new AbortController().signal);
  assert.equal(turn.message.text, 'LOGOX_PROVIDER_READY');
  assert.equal(turn.message.reasoning, '核对');
  assert.equal(turn.stop, 'complete');
  assert.deepEqual(turn.usage, {input: 8, output: 5});
  assert.deepEqual(deltas, ['核对', 'LOGOX_PROVIDER_READY']);
});

async function registryFixture(env: NodeJS.ProcessEnv = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-provider-'));
  const file = join(cwd, 'auth.json');
  const config = await loadConfig(cwd, {
    provider: {name: 'cloud', model: 'fixture'},
    providers: {cloud: {base_url: 'https://example.com/v1', api_key_env: 'CLOUD_KEY', auth_file: file, auth_provider: 'deepseek', default_model: 'fixture'}},
  }, {}, cwd, cwd);
  const auth = new AuthStorage(join(cwd, 'logox-auth.json'));
  return {cwd, file, config, auth, registry: new ProviderRegistry(config, env, fetch, auth), async cleanup() {await rm(cwd, {recursive: true, force: true});}};
}

test('认证在每次请求时读取，环境优先，选择信息不包含密钥', async () => {
  const f = await registryFixture();
  try {
    await writeFile(f.file, JSON.stringify({deepseek: {type: 'api_key', key: 'first-secret'}}));
    assert.equal((await f.registry.settings()).key, 'first-secret');
    await writeFile(f.file, JSON.stringify({deepseek: {type: 'api_key', key: 'rotated-secret'}}));
    assert.equal((await f.registry.settings()).key, 'rotated-secret');
    assert.ok(!JSON.stringify(f.registry.selection()).includes('secret'));
    const registry = new ProviderRegistry(f.config, {CLOUD_KEY: 'env-secret'}, fetch, f.auth);
    await writeFile(f.file, 'broken');
    assert.equal((await registry.settings()).key, 'env-secret', '有效环境密钥不依赖后备文件');
  } finally {await f.cleanup();}
});

test('认证缺失、损坏、OAuth 和命令值明确失败，不泄漏文件内容', async () => {
  const f = await registryFixture();
  try {
    await assert.rejects(f.registry.settings(), /无法读取认证文件/);
    await writeFile(f.file, '{ private-secret');
    await assert.rejects(f.registry.settings(), error => error instanceof Error && /无法读取/.test(error.message) && !error.message.includes('private-secret'));
    await writeFile(f.file, '{}');
    assert.equal((await f.registry.settings(false)).key, '');
    await assert.rejects(f.registry.settings(), /未登录/);
    await writeFile(f.file, JSON.stringify({deepseek: {type: 'oauth', access: 'private-secret'}}));
    await assert.rejects(f.registry.settings(), /OAuth/);
    await writeFile(f.file, JSON.stringify({deepseek: {type: 'api_key', key: '!echo private-secret'}}));
    await assert.rejects(f.registry.settings(), /认证命令/);
    await writeFile(f.file, JSON.stringify({deepseek: {type: 'api_key', key: '${MODEL_KEY}'}}));
    assert.equal((await new ProviderRegistry(f.config, {MODEL_KEY: 'reference-secret'}, fetch, f.auth).settings()).key, 'reference-secret');
  } finally {await f.cleanup();}
});

test('切换提供商清除旧模型地址和认证，失败选择不影响当前提供商', async () => {
  const f = await registryFixture();
  try {
    f.registry.select('antigravity');
    assert.deepEqual(f.registry.selection(), {provider: 'antigravity', model: '', kind: 'openai_compat', baseUrl: 'http://127.0.0.1:8045/v1'});
    assert.equal((await f.registry.settings()).key, '');
    assert.throws(() => f.registry.select('unknown'), /未知/);
    assert.equal(f.registry.selection().provider, 'antigravity');
    f.registry.select('cloud');
    assert.equal(f.registry.selection().model, 'fixture');
    f.registry.select('cloud', 'another');
    assert.equal(f.registry.selection().model, 'another');
  } finally {await f.cleanup();}
});

test('模型查询与回复复用相同认证，缺认证和取消不发送请求', async () => {
  const f = await registryFixture({CLOUD_KEY: 'request-secret'});
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    requests.push(String(url));
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer request-secret');
    if (String(url).endsWith('/models')) return Response.json({data: [{id: 'b'}, {id: 'a'}, {id: 'b'}]});
    return new Response('data: ' + JSON.stringify({choices: [{delta: {content: 'LOGOX_PROVIDER_READY'}, finish_reason: 'stop'}], usage: null}) + '\n\ndata: [DONE]\n\n');
  };
  try {
    const registry = new ProviderRegistry(f.config, {CLOUD_KEY: 'request-secret'}, fetcher, f.auth);
    assert.deepEqual(await registry.models(), ['a', 'b']);
    assert.equal((await registry.check()).text, 'LOGOX_PROVIDER_READY');
    assert.equal(requests.length, 2);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(registry.provider().respond({system: '', messages: [], tools: []}, () => {}, controller.signal));
    assert.equal(requests.length, 2);
    await writeFile(f.file, '{}');
    await assert.rejects(new ProviderRegistry(f.config, {}, fetcher, f.auth).check(), /未登录/);
    assert.equal(requests.length, 2);
  } finally {await f.cleanup();}
});

import {createServer} from 'node:http';

test('真实模型流断连保留传输阶段和底层错误码，已收到增量不丢失', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    const timer = setTimeout(() => response.destroy(), 50);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'http://127.0.0.1:' + address.port,
    model: 'test', key: '', temperature: 0, maxTokens: 100, timeoutMs: 2000});
  try {
    let partial = '';
    await assert.rejects(provider.respond({system: '', messages: [], tools: []}, delta => {partial += delta.text;}, new AbortController().signal), error => {
      assert.ok(error instanceof ProviderError && error.retryable && error.category === 'temporary');
      const diagnostic = error.diagnostic;
      assert.equal(diagnostic?.code, 'UND_ERR_SOCKET'); assert.equal(diagnostic?.phase, 'stream'); assert.equal(diagnostic?.status, 200);
      assert.match(error.message, /UND_ERR_SOCKET/);
      assert.ok(diagnostic && 'elapsedMs' in diagnostic && typeof diagnostic.elapsedMs === 'number');
      assert.ok('progressIdleMs' in diagnostic && typeof diagnostic.progressIdleMs === 'number' && diagnostic.progressIdleMs <= diagnostic.elapsedMs);
      assert.ok('transportIdleMs' in diagnostic && typeof diagnostic.transportIdleMs === 'number' && diagnostic.transportIdleMs <= diagnostic.elapsedMs);
      assert.ok('receivedBytes' in diagnostic && diagnostic.receivedBytes === Buffer.byteLength('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      assert.match(error.message, /传输诊断：/);
      return true;
    });
    assert.equal(partial, 'partial');
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('建立连接失败保留公开原因，不输出未知异常回显；协议错误不误报网络问题', async () => {
  const settings = {kind: 'openai_compat' as const, baseUrl: 'https://example.com/v1', model: 'fixture', key: '',
    temperature: 0, maxTokens: 100, timeoutMs: 2000};
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'private-key']) {
    const fetcher: typeof fetch = async () => {
      throw new TypeError('private-request', {cause: Object.assign(new Error('private-address'), {code})});
    };
    const provider = createProvider(settings, fetcher);
    await assert.rejects(provider.respond({system: '', messages: [], tools: []}, () => {}, new AbortController().signal), error => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /模型连接失败/);
      assert.ok(!JSON.stringify(error).includes('private-'));
      assert.equal(error.diagnostic?.code, code === 'private-key' ? undefined : code);
      assert.equal(error.diagnostic?.phase, 'connection');
      assert.equal(error.diagnostic?.status, undefined, '尚未建立连接，不虚构 HTTP 状态');
      if (code !== 'private-key') assert.ok(error.message.includes(code));
      return true;
    });
  }
  const malformed = createProvider(settings, async () => new Response('data: {invalid}\n\n'));
  await assert.rejects(malformed.respond({system: '', messages: [], tools: []}, () => {}, new AbortController().signal),
    error => error instanceof ProviderError && error.category === 'protocol' && error.message === '模型流事件格式无效');
});

test('已收到 HTTP 流头后无进展超时明确报告，用户取消保留原原因', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({choices: [{delta: {content: 'partial'}}], usage: null}) + '\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'http://127.0.0.1:' + address.port, model: 'test', key: '', temperature: 0.2, maxTokens: 100, timeoutMs: 150});
  const request = {system: 'fixture', messages: [{role: 'user' as const, text: 'fixture'}], tools: []};
  try {
    let partial = '';
    await assert.rejects(provider.respond(request, delta => {partial += delta.text;}, new AbortController().signal), /模型请求超时/);
    assert.equal(partial, 'partial');
    const controller = new AbortController();
    const reason = new Error('fixture cancellation');
    await assert.rejects(provider.respond(request, () => controller.abort(reason), controller.signal), error => error === reason);
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('持续有效输出可以超过 timeout，总期限不会切断正文、思考和工具参数', {timeout: 8000}, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    let index = 0;
    const timer = setInterval(() => {
      const delta = index < 4 ? {reasoning_content: '想'} : index < 8 ? {content: '文'}
        : {tool_calls: [{index: 0, ...(index === 8 ? {id: 'call', function: {name: 'read', arguments: '{'}}
          : {function: {arguments: index === 11 ? '}' : ' '}})}]};
      response.write('data: ' + JSON.stringify({choices: [{delta, finish_reason: ++index === 12 ? 'tool_calls' : null}]}) + '\n\n');
      if (index === 12) {clearInterval(timer); response.end('data: [DONE]\n\n');}
    }, 80);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'http://127.0.0.1:' + address.port, model: 'test', key: '',
    temperature: 0.2, maxTokens: 100, timeoutMs: 400});
  try {
    const turn = await provider.respond({system: '', messages: [], tools: []}, () => {}, new AbortController().signal);
    assert.equal(turn.message.reasoning, '想'.repeat(4)); assert.equal(turn.message.text, '文'.repeat(4));
    assert.equal(turn.stop, 'tools'); assert.equal(turn.message.toolCalls?.[0]?.arguments, '{  }');
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('空事件和心跳不能无限延长无进展期限，首包停滞也会超时', {timeout: 8000}, async () => {
  for (const heartbeat of [false, true]) {
    const server = createServer((_request, response) => {
      if (!heartbeat) return;
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const timer = setInterval(() => response.write(': ping\n\ndata: {"choices":[]}\n\n'), 40);
      response.on('close', () => clearInterval(timer));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const provider = createProvider({kind: 'openai_compat', baseUrl: 'http://127.0.0.1:' + address.port, model: 'test', key: '',
      temperature: 0.2, maxTokens: 100, timeoutMs: 250});
    try {
      await assert.rejects(provider.respond({system: '', messages: [], tools: []}, () => {}, new AbortController().signal),
        error => error instanceof ProviderError && error.diagnostic?.code === 'idle_timeout');
    } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
  }
});

test('Anthropic 思考增量和协议进展也刷新无进展期限', {timeout: 8000}, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    let count = 0;
    response.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n');
    const timer = setInterval(() => {
      response.write('data: ' + JSON.stringify({type: 'content_block_delta', index: 0,
        delta: {type: 'thinking_delta', thinking: '想'}}) + '\n\n');
      if (++count === 12) {
        clearInterval(timer);
        response.end('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n');
      }
    }, 80);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const provider = createProvider({kind: 'anthropic', baseUrl: 'http://127.0.0.1:' + address.port, model: 'test', key: '',
    temperature: 0.2, maxTokens: 100, timeoutMs: 400});
  try {
    const turn = await provider.respond({system: '', messages: [], tools: []}, () => {}, new AbortController().signal);
    assert.equal(turn.message.reasoning, '想'.repeat(12)); assert.equal(turn.stop, 'complete');
    assert.deepEqual(turn.usage, {input: 1, output: 12});
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('内置 antigravity 预设走本地 8045 端口与 openai_compat 协议，无需 API Key，自动推导 100 万 Token 窗口与思考协议', async () => {
  const f = await registryFixture();
  try {
    f.registry.select('antigravity', 'gemini-3.8-flash');
    assert.deepEqual(f.registry.selection(), {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      kind: 'openai_compat',
      baseUrl: 'http://127.0.0.1:8045/v1',
    });
    // 无需密钥
    const settings = await f.registry.settings();
    assert.equal(settings.key, '');
    assert.equal(settings.thinkingProtocol, 'reasoning-effort');

    // 自动推导容量：Gemini 模型 1,000,000 上下文，64,000 最大输出
    const geminiCapacity = f.registry.capacity('antigravity', 'gemini-3.8-flash');
    assert.equal(geminiCapacity.window, 1_000_000);
    assert.equal(geminiCapacity.maxOutput, 64_000);

    // Claude 模型经 antigravity 走 openai_compat，推导 1,000,000 上下文，128,000 最大输出
    const claudeCapacity = f.registry.capacity('antigravity', 'claude-sonnet-4-6');
    assert.equal(claudeCapacity.window, 1_000_000);
    assert.equal(claudeCapacity.maxOutput, 128_000);
  } finally {
    await f.cleanup();
  }
});
