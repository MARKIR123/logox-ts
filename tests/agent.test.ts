import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {createProvider, ProviderError} from '../src/providers/http.js';
import {waitForSnapshot} from './runtime-fixture.js';
import {runProcess} from '../src/tools/process.js';
import {buildStageRows} from '../src/tui/stage.js';

function assistant(text = '完成', stop: ModelTurn['stop'] = 'complete'): ModelTurn {
  return {message: {role: 'assistant', text}, stop};
}
function call(name: string, args: unknown, id = 'c'): ModelTurn {
  return {message: {role: 'assistant', text: '', toolCalls: [{id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args)}]}, stop: 'tools'};
}
async function fixture(provider: Provider, iterations = 50) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-agent-'));
  const config = await loadConfig(cwd, {provider: {model: 'test', context_window: 131072}, kernel: {max_iterations: iterations}, models: {'deepseek/cloud-fixture': {context_window: 131072}, 'antigravity/local-fixture': {context_window: 131072}}}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'test', config, provider});
  return {cwd, config, app, async cleanup() {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}
function scripted(turns: Array<ModelTurn | ((request: ModelRequest) => ModelTurn)>): Provider {
  return {async respond(request, onDelta) {
    const next = turns.shift();
    assert.ok(next, '没有额外模型请求');
    const turn = typeof next === 'function' ? next(request) : next;
    if (turn.message.text) onDelta({kind: 'text', text: turn.message.text});
    return turn;
  }};
}
function approve(app: Awaited<ReturnType<typeof createApplication>>, decision: 'allow_once' | 'deny') {
  const request = app.store.interactions.list().find(item => item.status === 'pending')!;
  assert.equal(request.kind, 'permission');
  app.store.interactions.respond(answerEnvelope(request, {kind: 'permission', decision}));
}

test('真实 HTTP 流 → 写入审批 → 文件 → 工具结果 → 回复 → 恢复 → 撤销', {timeout: 10000}, async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, {'content-type': 'text/event-stream'});
    const send = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\r\n\r\n');
    if (requests.length === 1) {
      send({choices: [{delta: {reasoning_content: '核对文件'}}]});
      send({choices: [{delta: {tool_calls: [{index: 0, id: 'write-1', function: {name: 'write', arguments: '{"path":"hello.ts",'}}]}}]});
      send({choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"content":"export const 你好 = 1;\\n"}'}}]}, finish_reason: 'tool_calls'}]});
    } else {
      send({choices: [{delta: {content: '文件已写入。'}, finish_reason: 'stop'}]});
      send({choices: [], usage: {prompt_tokens: 80, completion_tokens: 12}});
    }
    response.end('data: [DONE]\r\n\r\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
    model: 'test', key: '', temperature: 0.2, maxTokens: 1000, timeoutMs: 5000});
  const f = await fixture(provider);
  try {
    const handle = f.app.ensemble.dispatch('techne', '创建文件');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    await assert.rejects(readFile(join(f.cwd, 'hello.ts')));
    approve(f.app, 'allow_once');
    await handle.done;
    assert.equal(f.app.store.activities.get('test', handle.activityId)?.status, 'completed');
    assert.equal(await readFile(join(f.cwd, 'hello.ts'), 'utf8'), 'export const 你好 = 1;\n');
    const second = requests[1] as {messages: Array<{role: string; content: string}>};
    assert.equal(second.messages.at(-1)?.role, 'tool');
    assert.match(second.messages.at(-1)!.content, /已修改/);
    const entries = await f.app.journal.load('test', 'techne');
    assert.deepEqual(entries.map(entry => entry.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(entries[1]?.message?.role, 'assistant');
    await f.app.close();
    const restored = await createApplication({cwd: f.cwd, resourceOptions: {home: f.cwd, boundary: f.cwd}, sessionId: 'test', config: f.config, provider});
    try {
      assert.ok(restored.store.getSnapshot().messages.some(message => message.text === '文件已写入。'));
      await restored.submit('/undo');
      await assert.rejects(readFile(join(f.cwd, 'hello.ts')));
      assert.equal(requests.length, 2, '恢复不会重放模型或工具');
    } finally {await restored.close();}
  } finally {await f.cleanup(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('拒绝审批不写文件；模型收到真实拒绝结果', async () => {
  const f = await fixture(scripted([call('write', {path: 'denied.txt', content: 'bad'}), request => {
    assert.match(request.messages.at(-1)!.text, /拒绝/);
    return assistant('保留建议。');
  }]));
  try {
    const handle = f.app.ensemble.dispatch('logox', '写');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    approve(f.app, 'deny');
    await handle.done;
    await assert.rejects(readFile(join(f.cwd, 'denied.txt')));
  } finally {await f.cleanup();}
});

test('取消多工具批次补齐全部结果，下一轮能继续，恢复不重放副作用', async () => {
  const turn = call('write', {path: 'cancelled.txt', content: 'bad'});
  turn.message.toolCalls!.push({id: 'second', name: 'read', arguments: '{"path":"cancelled.txt"}'});
  let nextSeen = false;
  const f = await fixture(scripted([turn, request => {
    const results = request.messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 2);
    assert.ok(results.every(message => message.role === 'tool' && message.isError));
    nextSeen = true;
    return assistant('继续成功');
  }]));
  try {
    const first = f.app.ensemble.dispatch('logox', '先写');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    first.cancel();
    await first.done;
    assert.equal(f.app.store.activities.get('test', first.activityId)?.status, 'cancelled');
    const entries = await f.app.journal.load('test', 'logox');
    assert.equal(entries.filter(entry => entry.role === 'tool').length, 2);
    await f.app.ensemble.dispatch('logox', '继续').done;
    assert.equal(nextSeen, true);
    await assert.rejects(readFile(join(f.cwd, 'cancelled.txt')));
  } finally {await f.cleanup();}
});

test('响应截断或任一参数不完整时整批工具都不执行', async () => {
  for (const truncated of [true, false]) {
    const turn = call('write', {path: 'never.txt', content: 'bad'});
    if (truncated) turn.stop = 'length';
    else turn.message.toolCalls!.push({id: 'invalid', name: 'read', arguments: '{'});
    const f = await fixture(scripted([turn, request => {
      assert.ok(request.messages.filter(message => message.role === 'tool').every(message => message.role === 'tool' && message.isError));
      return assistant('已恢复');
    }]));
    try {
      await f.app.ensemble.dispatch('logox', '截断').done;
      assert.equal(f.app.store.interactions.list().length, 0);
      await assert.rejects(readFile(join(f.cwd, 'never.txt')));
    } finally {await f.cleanup();}
  }
});

test('读取工作目录之外和敏感路径需要审批；普通文件直接读', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'logox-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'outside');
  const f = await fixture(scripted([call('read', {path: 'normal.txt'}), call('read', {path: '.env'}),
    call('read', {path: join(outside, 'secret.txt')}), assistant()]));
  try {
    await writeFile(join(f.cwd, 'normal.txt'), 'normal');
    await writeFile(join(f.cwd, '.env'), 'secret');
    const handle = f.app.ensemble.dispatch('aletheia', '读取');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.filter(item => item.status === 'pending').length === 1);
    const sensitiveRequest = f.app.store.interactions.list()[0]!;
    assert.equal(sensitiveRequest.kind, 'permission');
    if (sensitiveRequest.kind === 'permission') assert.equal(sensitiveRequest.arguments.path, '.env');
    approve(f.app, 'deny');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.filter(item => item.status === 'pending').length === 1 &&
      snapshot.interactions.some(item => item.status === 'answered'));
    approve(f.app, 'deny');
    await handle.done;
    assert.equal(f.app.store.interactions.list().length, 2);
  } finally {await f.cleanup(); await rm(outside, {recursive: true, force: true});}
});

test('精确编辑保留 UTF-8 BOM、CRLF 和字面替换符；撤销不覆盖用户后续修改', async () => {
  const f = await fixture(scripted([call('edit', {path: 'file.txt', old_text: 'old\nline', new_text: '$&\n新行'}), assistant()]));
  try {
    await writeFile(join(f.cwd, 'file.txt'), '\uFEFFold\r\nline\r\n');
    const handle = f.app.ensemble.dispatch('techne', '编辑');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    approve(f.app, 'allow_once'); await handle.done;
    assert.equal(await readFile(join(f.cwd, 'file.txt'), 'utf8'), '\uFEFF$&\r\n新行\r\n');
    await writeFile(join(f.cwd, 'file.txt'), '用户修改');
    await assert.rejects(f.app.submit('/undo'), /后续修改/);
    assert.equal(await readFile(join(f.cwd, 'file.txt'), 'utf8'), '用户修改');
  } finally {await f.cleanup();}
});

test('达到循环额度由用户续做或停止，不自动假装完成', async () => {
  const f = await fixture(scripted([assistant('', 'length'), assistant('最终回复')]), 1);
  try {
    const handle = f.app.ensemble.dispatch('logox', '继续');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.kind === 'question'));
    const request = f.app.store.interactions.list()[0]!;
    f.app.store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: {continue: {type: 'option', optionId: 'yes'}}}));
    await handle.done;
    assert.equal(f.app.store.activities.get('test', handle.activityId)?.status, 'completed');
  } finally {await f.cleanup();}
});

test('未识别的暂时故障只在可见增量之前重试，已显示的中断回复保存到历史', async () => {
  let count = 0;
  const f = await fixture({async respond(_request, onDelta) {
    count++;
    if (count === 1) throw new ProviderError('busy', true);
    onDelta({kind: 'text', text: '半段回复'});
    throw new ProviderError('dropped', true);
  }});
  try {
    const handle = f.app.ensemble.dispatch('logox', '连接');
    await handle.done;
    assert.equal(count, 2);
    assert.equal(f.app.store.activities.get('test', handle.activityId)?.status, 'failed');
    assert.equal((await f.app.journal.load('test', 'logox')).at(-1)?.text, '半段回复');
  } finally {await f.cleanup();}
});

test('Windows 进程树终止失败时仍及时回收直属子进程', {timeout: 5000}, async () => {
  const start = Date.now();
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>process.exit(),2500)'],
    process.cwd(), new AbortController().signal, 100), /超时/);
  assert.ok(Date.now() - start < 1500, '超时后必须回收子进程，不能等待它自行结束');
});

test('真实 Shell 成功、非零退出、取消和超时均回收进程', {timeout: 10000}, async () => {
  const node = process.execPath;
  const signal = new AbortController().signal;
  const okay = await runProcess(node, ['-e', 'process.stdout.write("你好"); process.stderr.write("提示")'], process.cwd(), signal);
  assert.deepEqual(okay, {code: 0, stdout: '你好', stderr: '提示'});
  assert.equal((await runProcess(node, ['-e', 'process.exit(3)'], process.cwd(), signal)).code, 3);
  const controller = new AbortController();
  const pending = runProcess(node, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), controller.signal);
  await delay(80); controller.abort();
  await assert.rejects(pending, /取消/);
  await assert.rejects(runProcess(node, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), signal, 100), /超时/);
});

test('Director 派发后角色串行执行，结果自动返回且上下文隔离', {timeout: 5000}, async () => {
  let round = 0;
  const f = await fixture({async respond(request, onDelta) {
    round++;
    if (round === 1) return call('dispatch_role', {tasks: [{ownerId: 'aletheia', prompt: '查资料'}, {ownerId: 'techne', prompt: '构建'}]});
    if (round === 2) return assistant('角色已安排');
    if (request.system.includes('You are Aletheia') || request.system.includes('你是 Aletheia')) {assert.equal(request.messages.length, 1); return assistant('侦察结果');}
    if (request.system.includes('You are Techne') || request.system.includes('你是 Techne')) {assert.equal(request.messages.length, 1); return assistant('构建结果');}
    assert.match(request.messages.at(-1)!.text, /侦察结果/);
    assert.match(request.messages.at(-1)!.text, /构建结果/);
    onDelta({kind: 'text', text: '汇总完成'});
    return assistant('汇总完成');
  }});
  try {
    await f.app.submit('处理任务');
    await waitForSnapshot(f.app.store, snapshot => snapshot.activities.length === 4 && snapshot.activities.every(a => a.status === 'completed'));
    assert.equal(round, 5);
    assert.deepEqual((await f.app.journal.load('test', 'aletheia')).map(entry => entry.role), ['user', 'assistant']);
    const rows = buildStageRows(f.app.store.getSnapshot(), 'test', 'logox', 80, {}, null);
    assert.ok(rows.some(row => row.text.includes('侦察结果')), '完成卡片复用成果摘要标题');
    assert.ok(!rows.some(row => row.text.includes('保留项目内容')), '真实场景不含 portfolio 演示正文');
  } finally {await f.cleanup();}
});

test('Anthropic 原生流保留思考签名与工具身份，下一次请求正确配对', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = createProvider({kind: 'anthropic', baseUrl: 'http://localhost/v1', model: 'test', key: '',
    temperature: 0.2, maxTokens: 1000, timeoutMs: 5000}, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const chunks = [
      {type: 'message_start', message: {usage: {input_tokens: 42}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: '', signature: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: '思考'}},
      {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'signed'}},
      {type: 'content_block_start', index: 1, content_block: {type: 'tool_use', id: 'c', name: 'read', input: {}}},
      {type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{"path":"x"}'}},
      {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 8}},
      {type: 'message_stop'},
    ];
    return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join(''), {headers: {'content-type': 'text/event-stream'}});
  });
  const turn = await provider.respond({system: 'rules', messages: [{role: 'user', text: '读取'}], tools: []}, () => {}, new AbortController().signal);
  assert.equal(turn.message.signature, 'signed');
  assert.deepEqual(turn.usage, {input: 42, output: 8});
  await provider.respond({system: 'rules', tools: [], messages: [turn.message, {role: 'tool', callId: 'c', name: 'read', text: '内容', isError: false}]}, () => {}, new AbortController().signal);
  const second = bodies[1] as {messages: Array<{content: Array<Record<string, unknown>>}>};
  assert.equal(second.messages[0]?.content[0]?.signature, 'signed');
  assert.equal(second.messages[1]?.content[0]?.tool_use_id, 'c');
});
test('文件搜索使用实际 rg，忽略敏感文件，达到全局上限后停止', async () => {
  let observed = false;
  const f = await fixture(scripted([call('glob', {pattern: '**/*.txt'}), call('grep', {pattern: 'needle', limit: 2}), request => {
    const tools = request.messages.filter(message => message.role === 'tool');
    assert.equal(tools.length, 2);
    assert.match(tools[0]!.text, /public.txt/);
    assert.ok(!tools[0]!.text.includes('secret.txt'));
    assert.match(tools[1]!.text, /needle/);
    assert.ok(!tools[1]!.text.includes('private'));
    assert.equal(tools[1]!.text.split('\n').filter(line => line.includes('needle')).length, 2);
    observed = true; return assistant();
  }]));
  try {
    await mkdir(join(f.cwd, '.aws'));
    await writeFile(join(f.cwd, '.aws', 'secret.txt'), 'needle private');
    await writeFile(join(f.cwd, '.env'), 'needle private');
    await writeFile(join(f.cwd, 'public.txt'), 'needle one\nneedle two\nneedle three\n');
    await f.app.ensemble.dispatch('aletheia', '搜索').done;
    assert.equal(observed, true);
    assert.equal(f.app.store.interactions.list().length, 0);
  } finally {await f.cleanup();}
});
test('同一轮同一文件多次修改按倒序撤销；新建文件撤销后消失', async () => {
  const f = await fixture(scripted([call('write', {path: 'repeated.txt', content: 'one'}, 'c1'),
    call('write', {path: 'repeated.txt', content: 'two'}, 'c2'), assistant()]));
  try {
    const handle = f.app.ensemble.dispatch('techne', '多次写');
    for (let index = 0; index < 2; index++) {
      await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending') && snapshot.interactions.length === index + 1);
      approve(f.app, 'allow_once');
    }
    await handle.done;
    assert.equal(await readFile(join(f.cwd, 'repeated.txt'), 'utf8'), 'two');
    await f.app.submit('/undo');
    await assert.rejects(readFile(join(f.cwd, 'repeated.txt')));
  } finally {await f.cleanup();}
});
test('进程退出前留下的未配对调用恢复为失败结果，下一轮不会自动写文件', async () => {
  const provider = scripted([request => {
    const messages = request.messages;
    assert.equal(messages.at(-2)?.role, 'tool');
    assert.match(messages.at(-2)!.text, /中断/);
    return assistant('恢复成功');
  }]);
  const f = await fixture(provider);
  try {
    await f.app.journal.append({version: 1, sessionId: 'test', ownerId: 'techne', role: 'assistant', text: '',
      message: {role: 'assistant', text: '', toolCalls: [{id: 'orphan', name: 'write', arguments: '{"path":"orphan.txt","content":"bad"}'}]}});
    await f.app.ensemble.dispatch('techne', '继续').done;
    const entries = await f.app.journal.load('test', 'techne');
    assert.deepEqual(entries.map(entry => entry.role), ['assistant', 'tool', 'user', 'assistant']);
    await assert.rejects(readFile(join(f.cwd, 'orphan.txt')));
  } finally {await f.cleanup();}
});
test('审批等待期间文件被用户修改或创建时，写工具保留新内容', async () => {
  const f = await fixture(scripted([call('write', {path: 'waiting.txt', content: 'model'}), request => {
    const result = request.messages.at(-1)!;
    assert.equal(result.role, 'tool');
    assert.match(result.text, /等待审批期间发生变化/);
    return assistant('保留用户改动');
  }]));
  try {
    const task = f.app.ensemble.dispatch('techne', '写入');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    await writeFile(join(f.cwd, 'waiting.txt'), '用户最新内容');
    approve(f.app, 'allow_once');
    await task.done;
    assert.equal(await readFile(join(f.cwd, 'waiting.txt'), 'utf8'), '用户最新内容');
    assert.deepEqual(await f.app.tools.snapshots.undo(), []);
  } finally {await f.cleanup();}
});
test('SSE 可跨 UTF-8 字节和 CRLF 边界，错误状态不回显服务正文', async () => {
  const payload = Buffer.from('data: ' + JSON.stringify({choices: [{delta: {content: '中文🙂'}, finish_reason: 'stop'}]}) + '\r\n\r\ndata: [DONE]\r\n\r\n');
  const settings = {kind: 'openai_compat' as const, baseUrl: 'http://localhost/v1', model: 'test', key: '',
    temperature: 0.2, maxTokens: 100, timeoutMs: 1000};
  const provider = createProvider(settings, async () => new Response(new ReadableStream({
    start(controller) {for (const byte of payload) controller.enqueue(Uint8Array.of(byte)); controller.close();},
  })));
  const chunks: string[] = [];
  const turn = await provider.respond({system: '', messages: [], tools: []}, delta => chunks.push(delta.text), new AbortController().signal);
  assert.equal(turn.message.text, '中文🙂');
  assert.equal(chunks.join(''), '中文🙂');
  const bad = createProvider(settings, async () => new Response('PRIVATE_SECRET', {status: 401}));
  await assert.rejects(bad.respond({system: '', messages: [], tools: []}, () => {}, new AbortController().signal), error => {
    assert.ok(error instanceof ProviderError);
    assert.ok(!error.message.includes('PRIVATE_SECRET'));
    assert.equal(error.retryable, false); return true;
  });
});
test('Shell 工具经过真实许可再执行平台命令，并将退出码和输出返回模型', async () => {
  let seen = false;
  const f = await fixture(scripted([call('shell', {command: process.platform === 'win32'
    ? 'Write-Output LOGOX_SHELL_READY' : 'printf LOGOX_SHELL_READY', timeout: 10}), request => {
    const result = request.messages.at(-1)!;
    assert.equal(result.role, 'tool');
    assert.match(result.text, /退出码：0/);
    assert.match(result.text, /LOGOX_SHELL_READY/);
    seen = true; return assistant('命令执行完成');
  }]));
  try {
    const task = f.app.ensemble.dispatch('techne', '执行验收命令');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    assert.equal(seen, false);
    approve(f.app, 'allow_once'); await task.done;
    assert.equal(seen, true);
  } finally {await f.cleanup();}
});

test('正式应用提供商命令统一选择，运行中拒绝切换', async () => {
  let finish: (() => void) | undefined;
  const f = await fixture({async respond(_request, _delta, signal) {
    await new Promise<void>((resolve, reject) => {finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), {once: true});});
    return assistant();
  }});
  try {
    await f.app.submit('/providers');
    const providers = f.app.surfaces.getSnapshot();
    assert.ok(providers?.kind === 'picker');
    await Promise.resolve();
    f.app.surfaces.cancel();
    await f.app.submit('/provider deepseek cloud-fixture');
    await f.app.submit('/status');
    const status = f.app.surfaces.getSnapshot();
    assert.ok(status?.kind === 'page');
    assert.match(status.tabs[0]!.lines.join('\n'), /deepseek[\s\S]*cloud-fixture/);
    f.app.surfaces.cancel();
    await f.app.submit('/provider'); await Promise.resolve();
    const task = f.app.ensemble.dispatch('aletheia', 'wait');
    await waitForSnapshot(f.app.store, snapshot => snapshot.activities.some(a => a.stage === '模型处理中'));
    await f.app.surfaces.choose(f.app.surfaces.getSnapshot()!.id, 'antigravity');
    const blocked = f.app.surfaces.getSnapshot(); assert.ok(blocked?.kind === 'picker');
    assert.match(blocked.error, /(?:任务处理中|Tasks are running)/); f.app.surfaces.cancel();
    await assert.rejects(f.app.submit('/model'), /(?:任务处理中|Tasks are running)/);
    await assert.rejects(f.app.submit('/provider'), /(?:任务处理中|Tasks are running)/);
    await assert.rejects(f.app.submit('/model different'), /(?:任务处理中|Tasks are running)/);
    await assert.rejects(f.app.submit('/provider antigravity'), /(?:任务处理中|Tasks are running)/);
    finish!(); await task.done;
    await f.app.submit('/provider antigravity');
    await f.app.submit('/model local-fixture');
    await f.app.submit('/status');
    const localStatus = f.app.surfaces.getSnapshot(); assert.ok(localStatus?.kind === 'page');
    assert.match(localStatus.tabs[0]!.lines.join('\n'), /antigravity[\s\S]*local-fixture/);
  } finally {await f.cleanup();}
});
