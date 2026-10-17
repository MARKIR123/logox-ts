import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {createProvider} from '../src/providers/http.js';
import {createHttpTransport} from '../src/providers/transport.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import {waitForSnapshot} from './runtime-fixture.js';

type Payload = {messages: Array<{role: string; content?: string; reasoning_content?: string}>; tools: unknown[]};
const send = (res: ServerResponse, delta: unknown, finish_reason: string | null = null) =>
  res.write('data: ' + JSON.stringify({choices: [{delta, finish_reason}]}) + '\n\n');

async function fixture(reply: (res: ServerResponse, count: number) => void) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-network-recovery-'));
  const requests: Payload[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); res.writeHead(200, {'content-type': 'text/event-stream'});
    reply(res, requests.length);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const transport = createHttpTransport({});
  const provider = createProvider({kind: 'openai_compat', baseUrl: `http://127.0.0.1:${address.port}`, model: 'test', key: '',
    maxTokens: 512, temperature: 0.2, timeoutMs: 3000}, transport.fetch);
  const config = await loadConfig(cwd, {provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const options = {cwd, config, provider, sessionId: 'network', resourceOptions: {home: cwd, boundary: cwd}};
  const app = await createApplication(options);
  return {app, cwd, requests, options, async close() {
    await app.close(); await transport.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, {recursive: true, force: true});
  }};
}

test('真实 SSE 断流两次后恢复，已执行写入一次，失败输出保存但不入后续上下文', {timeout: 15000}, async () => {
  const f = await fixture((res, count) => {
    if (count === 1) {
      send(res, {tool_calls: [{index: 0, id: 'write-ready', function: {name: 'write', arguments: JSON.stringify({path: 'ready.txt', content: 'one-write'})}}]}, 'tool_calls');
      res.end('data: [DONE]\n\n');
    } else if (count <= 3) {
      send(res, {content: 'discarded-partial-' + count});
      send(res, {tool_calls: [{index: 0, id: 'unfinished', function: {name: 'write', arguments: '{"path":"broken.txt"'}}]});
      setTimeout(() => res.destroy(), 20);
    } else {send(res, {content: '网络恢复完成'}, 'stop'); res.end('data: [DONE]\n\n');}
  });
  try {
    await f.app.submit('创建合成文件');
    await waitForSnapshot(f.app.store, s => s.interactions.some(i => i.status === 'pending'));
    const permission = f.app.store.interactions.list().find(i => i.status === 'pending'); assert.ok(permission);
    f.app.store.interactions.respond(answerEnvelope(permission, {kind: 'permission', decision: 'allow_once'}));
    await waitForSnapshot(f.app.store, s => s.activities.some(a => a.activityId === permission.activityId && ['completed', 'failed'].includes(a.status)), 10000);
    assert.equal(f.app.store.activities.get('network', permission.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 4);
    assert.equal(await readFile(join(f.cwd, 'ready.txt'), 'utf8'), 'one-write');
    await assert.rejects(readFile(join(f.cwd, 'broken.txt')));
    const history = await f.app.journal.load('network', 'logox');
    assert.equal(history.filter(e => e.role === 'tool').length, 1);
    assert.equal(history.filter(e => e.message?.role === 'assistant' && e.message.contextExcluded).length, 2);
    for (const request of f.requests.slice(2)) assert.ok(!JSON.stringify(request).includes('discarded-partial'));
    await f.app.ensemble.dispatch('logox', '下一轮').done;
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes('discarded-partial'));
    await f.app.close();
    assert.ok((await f.app.journal.systemEvents('network')).some(e => /Network.*Retrying|网络.*重试/i.test(e.text)));
    const restored = await createApplication(f.options);
    try {
      assert.ok(restored.store.getSnapshot().messages.some(m => m.text === 'discarded-partial-2'));
      await restored.ensemble.dispatch('logox', '重启后下一轮').done;
      assert.ok(!JSON.stringify(f.requests.at(-1)).includes('discarded-partial'));
    } finally {await restored.close();}
  } finally {await f.close();}
});

test('持续断流最多补救两次，预算耗尽保留真实错误，重启不自动重放', {timeout: 10000}, async () => {
  const f = await fixture(res => {send(res, {reasoning_content: 'network-partial'}); setTimeout(() => res.destroy(), 20);});
  try {
    const task = f.app.ensemble.dispatch('logox', '失败合成任务'); await task.done;
    assert.equal(f.requests.length, 3);
    assert.equal(f.app.store.activities.get('network', task.activityId)?.status, 'failed');
    assert.match(f.app.store.activities.get('network', task.activityId)?.detail ?? '', /UND_ERR_SOCKET|ECONNRESET/);
    await f.app.close();
    const restored = await createApplication(f.options);
    try {assert.equal(f.requests.length, 3); assert.equal(restored.store.activities.get('network', task.activityId)?.status, 'failed');}
    finally {await restored.close();}
  } finally {await f.close();}
});

test('退避等待时用户取消立即结束，不再发请求', {timeout: 5000}, async () => {
  const f = await fixture(res => {send(res, {content: 'cancel-partial'}); setTimeout(() => res.destroy(), 20);});
  try {
    const task = f.app.ensemble.dispatch('logox', '取消合成任务');
    await waitForSnapshot(f.app.store, s => s.activities.some(a => a.activityId === task.activityId && a.phase === 'retry'));
    task.cancel(); await task.done;
    assert.equal(f.requests.length, 1); assert.equal(f.app.store.activities.get('network', task.activityId)?.status, 'cancelled');
  } finally {await f.close();}
});

test('Actor 请求重试与 Director 接管共用预算，不叠加第三次自动续做', {timeout: 18000}, async () => {
  const f = await fixture((res, count) => {
    if (count <= 3) {send(res, {reasoning_content: 'actor-partial'}); setTimeout(() => res.destroy(), 20);}
    else {send(res, {content: '同一故障已补救两次，需要检查网络'}, 'stop'); res.end('data: [DONE]\n\n');}
  });
  try {
    await f.app.submit('@techne 合成角色任务');
    await waitForSnapshot(f.app.store, s => s.activities.some(a => a.ownerId === 'logox' && a.status === 'completed'), 15000);
    assert.equal(f.requests.length, 4, 'Actor 三次请求后只允许 Director 说明，不继续派工');
    assert.match(JSON.stringify(f.requests[3]), /同一故障.*两次/);
    assert.deepEqual(f.requests[3]?.tools, []);
  } finally {await f.close();}
});
