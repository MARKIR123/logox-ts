import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {SystemHistory} from '../src/store/system-history.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {waitForSnapshot} from './runtime-fixture.js';
import type {ModelRequest} from '../src/runtime/messages.js';

test('系统历史缓冲空白、首次正式任务保存；事件重启去重且不进入模型账本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-system-history-'));
  try {
    const journal = new Journal(directory), store = new RuntimeStore();
    let persistent = false;
    const history = new SystemHistory('s', store, journal, () => persistent);
    history.emit('当前模型：fixture', 'command_result');
    history.emit('合成命令错误', 'command_error');
    await history.flush();
    assert.deepEqual(await journal.systemEvents('s'), []);
    assert.ok(store.getSnapshot().messages.every(message => message.role === 'system'));
    persistent = true; await history.flush();
    const events = await journal.systemEvents('s');
    assert.equal(events.length, 2);
    assert.deepEqual(await journal.load('s', 'logox'), []);
    const restored = new RuntimeStore();
    await new SystemHistory('s', restored, journal, () => true).restore();
    await new SystemHistory('s', restored, journal, () => true).restore();
    assert.deepEqual(restored.getSnapshot().messages.map(message => message.id), events.map(event => event.id));
    await journal.appendSystem(events[0]!);
    assert.equal((await journal.systemEvents('s')).length, 2);
    history.emit('任务失败', 'model_error', 'logox', 'removed');
    await history.flush();
    await journal.fork('s', ['logox'], ['removed']);
    assert.equal((await journal.systemEvents('s')).length, 2);
    assert.match(await readFile(journal.path('s', '$system') + '.events.json', 'utf8'), /任务失败/, '回退保留原始系统记录');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('命令和模型错误保存为系统历史，环境变化合并为下一次请求的真实状态', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-environment-history-'));
  const seen: ModelRequest[] = [];
  const config = await loadConfig(cwd, {provider: {model: 'first'},
    models: Object.fromEntries(['first', 'second', 'final', 'next', 'latest'].map(model => ['openai-compatible/' + model, {context_window: 131072}]))}, {}, cwd, cwd);
  const options = {cwd, config, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, 'auth.json'),
    provider: {async respond(request: ModelRequest) {
      seen.push(request);
      if (request.messages.at(-1)?.text === '合成失败') throw new Error('合成请求错误');
      return {message: {role: 'assistant' as const, text: '已确认'}, stop: 'complete' as const};
    }}};
  let app = await createApplication(options);
  try {
    await assert.rejects(app.submit('/unknown'), /未知命令|Unknown command/);
    await app.submit('/model second'); await app.submit('/model final');
    assert.equal(seen.length, 0, '操作不会额外启动模型');
    assert.equal(app.isSessionPersistent(), false);
    await app.submit('第一轮');
    await waitForSnapshot(app.store, snapshot => ['completed', 'failed', 'waiting_input'].includes(snapshot.activities.at(-1)?.status ?? ''));
    assert.equal(app.store.getSnapshot().activities.at(-1)?.status, 'completed', JSON.stringify(app.store.getSnapshot().activities));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(seen[0]!.system, /实际任务模型：.+\/final/);
    assert.ok(seen[0]!.messages.every(message => !/未知命令|当前模型：|Unknown command|Current model:/.test(message.text)));
    await app.submit('/model next'); await app.submit('/model latest');
    await app.submit('/permissions mode creative');
    await app.submit('/permissions add session deny write private.txt');
    await app.submit('合成失败');
    await waitForSnapshot(app.store, snapshot => snapshot.activities.at(-1)?.status === 'failed');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(seen[1]!.system, /实际任务模型：.+\/latest/);
    assert.match(seen[1]!.system, /权限与行动边界：creative/);
    assert.match(seen[1]!.system, /deny write private.txt/);
    const changes = (await app.journal.systemEvents(app.sessionId)).filter(event => event.kind === 'environment_change');
    assert.equal(changes.length, 1);
    assert.match(changes[0]!.text, /latest/); assert.ok(!changes[0]!.text.includes('/next'));
    const id = app.sessionId, before = await app.journal.systemEvents(id);
    assert.ok(before.some(event => event.kind === 'model_error' && event.text.includes('合成请求错误')));
    assert.ok(before.some(event => event.kind === 'command_error'));
    await app.close(); app = await createApplication(options);
    assert.equal(app.sessionId, id);
    const history = await app.journal.systemEvents(id);
    assert.deepEqual(history.map(event => event.id), before.map(event => event.id), '重启不追加旧错误');
    await app.submit('继续');
    await waitForSnapshot(app.store, snapshot => snapshot.activities.at(-1)?.status === 'completed');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(seen.at(-1)!.messages.every(message => !/合成请求错误|未知命令/.test(message.text)));
    assert.equal(app.store.getSnapshot().messages.filter(message => message.role === 'system' && message.text.includes('合成请求错误')).length, 1);
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
