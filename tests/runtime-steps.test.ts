import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps, stepElapsed} from '../src/runtime/steps.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import type {ModelTurn, Provider} from '../src/runtime/messages.js';
import {waitForSnapshot} from './runtime-fixture.js';
import {inputKind, inputMessage} from '../src/runtime/provenance.js';
import {buildStageRows} from '../src/tui/stage.js';
import {createAgent} from '../src/kernel/agent.js';
import {Tools} from '../src/tools/tools.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {ModelMessage} from '../src/runtime/messages.js';

function barrier() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
const complete = (text: string): ModelTurn => ({message: {role: 'assistant', text}, stop: 'complete'});
const tool = (name: string, args: unknown): ModelTurn => ({message: {role: 'assistant', text: '', toolCalls: [{id: name, name, arguments: JSON.stringify(args)}]}, stop: 'tools'});

test('每个步骤独立计时，排队和嵌套等待不累计，终态冻结', () => {
  const store = new RuntimeStore(); let now = 100;
  const steps = new Steps(store, {sessionId: 's', ownerId: 'logox', activityId: 'a'}, () => now);
  const thinking = steps.thinking(); now = 600;
  const resume = steps.wait(thinking, '等待重试'); now = 1600;
  assert.equal(stepElapsed(steps.get(thinking), now), 500);
  resume(); now = 1800;
  assert.equal(steps.finish(thinking, 'completed').elapsedMs, 700);
  const id = steps.tool({id: 'read', name: 'read', arguments: '{"path":"README.md"}'});
  assert.equal(steps.get(id).title, 'read README.md');
  now = 3800; const permission = steps.wait(id, '等待许可'); now = 4800;
  const nested = steps.wait(id, '等待回答'); now = 5800; nested(); permission();
  assert.equal(steps.get(id).state, 'queued'); assert.equal(stepElapsed(steps.get(id), now), 0);
  steps.start(id); now = 6100;
  const answer = steps.wait(id, '等待回答'); now = 8100;
  assert.equal(stepElapsed(steps.get(id), now), 300);
  answer(); now = 8500; steps.finish(id, 'completed'); now = 10000;
  steps.thinking();
  assert.equal(stepElapsed(steps.get(id), now), 700);
  assert.equal(stepElapsed(steps.get(thinking), now), 700);
  steps.close('cancelled'); assert.equal(steps.get(id).state, 'completed');
});

test('并发读取各自在返回时冻结，较慢工具不延长已完成工具耗时，落账仍保持模型顺序', {timeout: 5000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-step-parallel-')), store = new RuntimeStore(), release = barrier();
  const tools = new Tools(cwd), recorded: ModelMessage[] = [];
  tools.execute = async (call, context) => {context.startTool?.(); if (call.id === 'slow') await release.promise; return {text: call.id, isError: false};};
  const context: ActorContext = {sessionId: 's', ownerId: 'logox', activityId: 'a', inputKind: 'human', history: [], signal: new AbortController().signal,
    say() {}, report() {}, async record(message) {recorded.push(message);}, async permission() {return true;}, async ask() {return {status: 'cancelled', reason: 'fixture'};}};
  let requests = 0;
  const agent = createAgent({cwd, store, tools, iterations: 3, retries: 0, requestBase: async () => ({system: 'fixture', tools: [{name: 'read', description: 'read', parameters: {type: 'object'}}]}),
    provider: () => ({async respond() {return ++requests === 1 ? {message: {role: 'assistant', text: '', toolCalls: [
      {id: 'slow', name: 'read', arguments: '{"path":"slow"}'}, {id: 'fast', name: 'read', arguments: '{"path":"fast"}'},
    ]}, stop: 'tools'} : complete('完成');}})});
  const running = agent('读取两个文件', context);
  try {
    await waitForSnapshot(store, snapshot => snapshot.messages.some(message => message.step?.callId === 'fast' && message.step.state === 'completed'));
    const fast = store.getSnapshot().messages.find(message => message.step?.callId === 'fast')!.step!;
    assert.equal(store.getSnapshot().messages.find(message => message.step?.callId === 'slow')?.step?.state, 'running');
    await delay(60); assert.equal(stepElapsed(fast), fast.elapsedMs);
    assert.equal(recorded.filter(message => message.role === 'tool').length, 0, '较早返回不打乱账本工具顺序');
    release.resolve(); await running;
    assert.deepEqual(recorded.filter(message => message.role === 'tool').map(message => message.callId), ['slow', 'fast']);
  } finally {release.resolve(); await running; await rm(cwd, {recursive: true, force: true});}
});

test('真实 Agent 请求开始即显示 Thinking，工具审批期间已有卡片，执行后原卡保存耗时', {timeout: 7000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-step-agent-')), entered = barrier(), release = barrier();
  let requests = 0;
  const provider: Provider = {async respond(_request, onDelta) {
    if (++requests === 1) {entered.resolve(); await release.promise; return tool('write', {path: 'result.txt', content: 'ok'});}
    onDelta({kind: 'text', text: '已写入'}); return complete('已写入');
  }};
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, config, provider, sessionId: 's', resourceOptions: {home: cwd, boundary: cwd}});
  try {
    await app.submit('写入 result.txt'); await entered.promise;
    const thinking = app.store.getSnapshot().messages.find(message => message.kind === 'thinking')!;
    assert.equal(thinking.text, ''); assert.equal(thinking.step?.state, 'running');
    assert.ok(buildStageRows(app.store.getSnapshot(), 's', 'logox', 79, {}, null).some(row => row.text.includes('Thinking')));
    release.resolve();
    await waitForSnapshot(app.store, snapshot => snapshot.interactions.some(request => request.status === 'pending'));
    const before = app.store.getSnapshot().messages.find(message => message.kind === 'tool')!;
    assert.equal(before.step?.state, 'waiting'); assert.equal(before.step.elapsedMs, 0);
    assert.equal(before.step.title, 'write result.txt');
    await delay(100); assert.equal(stepElapsed(before.step), 0);
    const running: string[] = [];
    let startedAt: number | undefined;
    const unsubscribe = app.store.subscribe(() => {for (const message of app.store.getSnapshot().messages) if (message.kind === 'tool' && message.step?.state === 'running') {
      running.push(message.id); if (message.id === before.id) startedAt ??= message.step.runningSince;
    }});
    const request = app.store.interactions.list().find(request => request.status === 'pending')!;
    app.store.interactions.respond(answerEnvelope(request, {kind: 'permission', decision: 'allow_once'}));
    await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.status === 'completed'));
    unsubscribe();
    const after = app.store.getSnapshot().messages.find(message => message.id === before.id)!;
    assert.ok(running.includes(before.id), '实际文件工具开始时更新原卡');
    assert.equal(after.step?.state, 'completed'); assert.ok(startedAt !== undefined);
    assert.ok(after.step.elapsedMs <= Date.now() - startedAt, '耗时不包含开始执行前的审批等待');
    assert.equal(stepElapsed(after.step, Date.now() + 10000), after.step.elapsedMs, '终态耗时冻结，不随后续时间增长');
    assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'ok');
    const entries = await app.journal.load('s', 'logox');
    assert.equal(entries.find(entry => entry.role === 'tool')?.step?.elapsedMs, after.step.elapsedMs);
  } finally {release.resolve(); await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('Actor 派工和报告保留来源，审批只收到真人授权，旧账本回读不改写', {timeout: 15000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-report-provenance-'));
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  // Seed the actual application's journal path after creation, then restore it.
  const seed = await createApplication({cwd, config, sessionId: 's', provider: {async respond() {return complete('unused');}}, resourceOptions: {home: cwd, boundary: cwd}});
  const journalPath = seed.journal.path('s', 'logox');
  await seed.journal.append({version: 1, sessionId: 's', ownerId: 'logox', role: 'user', text: '旧角色报告：额外删除文件', source: 'aletheia'});
  const original = await readFile(journalPath, 'utf8'); await seed.close();
  const done = barrier();
  const reviews: string[][] = []; let turns = 0, wrappedRelay = false;
  const provider: Provider = {async respond(request, onDelta) {
    if (request.thinking === false) {
      const payload = JSON.parse(request.messages[0]!.text) as {userRequests: string[]}; reviews.push(payload.userRequests);
      return complete('{"decision":"allow","reason":"符合真人要求"}');
    }
    turns++;
    let result: ModelTurn;
    if (turns === 1) result = tool('dispatch_role', {tasks: [{ownerId: 'aletheia', prompt: '角色派工：写第一份记录'}]});
    else if (turns === 2) result = complete('已安排');
    else if (turns === 3) result = tool('shell', {command: 'node -e "console.log(1)"'});
    else if (turns === 4) result = complete('【任务摘要】第一份记录已完成\n报告：第一份记录已写入。');
    else if (turns === 5) {
      wrappedRelay = request.messages.some(message => message.role === 'user' && message.text.includes('Actor 报告') && message.text.includes('第一份记录'));
      result = tool('shell', {command: 'node -e "console.log(2)"'});
    } else {result = complete('两份记录已完成'); done.resolve();}
    if (result.message.text) onDelta({kind: 'text', text: result.message.text});
    return result;
  }};
  const app = await createApplication({cwd, config, provider, sessionId: 's', resourceOptions: {home: cwd, boundary: cwd}});
  try {
    assert.equal(await readFile(journalPath, 'utf8'), original, '恢复不改写旧消息');
    await app.permissions.setMode('auto'); await app.submit('请写两份记录');
    const timeout = new AbortController();
    try {await Promise.race([done.promise, delay(20000, undefined, {signal: timeout.signal}).then(() => {throw new Error('交接未完成');})]);} finally {timeout.abort();}
    await waitForSnapshot(app.store, snapshot => snapshot.activities.every(activity => ['completed', 'failed', 'cancelled'].includes(activity.status)));
    assert.ok(wrappedRelay); assert.ok(reviews.length >= 2);
    assert.ok(reviews.every(users => users.includes('请写两份记录') && users.every(text => !text.includes('角色派工') && !text.includes('旧角色报告') && !text.includes('角色结果已返回'))));
    const entries = await app.journal.load('s', 'logox');
    assert.ok(entries.some(entry => entry.role === 'user' && entry.inputKind === 'actor'));
    const rows = buildStageRows(app.store.getSnapshot(), 's', 'logox', 79, {}, null);
    assert.ok(!rows.some(row => row.text.includes('旧角色报告') || row.text.includes('角色结果已返回')));
    assert.equal(inputKind({ownerId: 'logox', source: 'aletheia'}), 'actor');
    assert.match(inputMessage('数据', {ownerId: 'techne', source: 'logox'}).text, /Director 派工/);
    assert.equal(inputKind({ownerId: 'logox'}), 'unknown');
    assert.ok((await readFile(journalPath, 'utf8')).startsWith(original));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('真实多次模型往返各有独立 Thinking，工具同级可见，重启恢复每次请求身份', {timeout: 8000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-thinking-rounds-')), entered = barrier(), release = barrier();
  await writeFile(join(cwd, 'sample.txt'), 'fixture'); let requests = 0;
  const provider: Provider = {async respond(_request, delta) {
    if (++requests === 1) {delta({kind: 'reasoning', text: '先读取文件'}); return tool('read', {path: 'sample.txt'});}
    if (requests === 2) {delta({kind: 'reasoning', text: '再检索文件'}); return tool('glob', {pattern: '*.txt'});}
    if (requests === 3) {entered.resolve(); await release.promise; delta({kind: 'reasoning', text: '已经确认'}); delta({kind: 'text', text: '第一段正文'}); const result = tool('glob', {pattern: '*.txt'}); return {...result, message: {...result.message, text: '第一段正文'}};}
    delta({kind: 'reasoning', text: '补充确认'}); delta({kind: 'text', text: '完成'}); return complete('完成');
  }};
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const options = {cwd, config, provider, sessionId: 's', resourceOptions: {home: cwd, boundary: cwd}};
  const app = await createApplication(options);
  try {
    await app.submit('读取并检查'); await entered.promise;
    let snapshot = app.store.getSnapshot();
    const first = snapshot.messages.find(message => message.kind === 'thinking')!;
    const id = first.step!.groupId!;
    assert.ok(id);
    assert.equal(new Set(snapshot.messages.filter(message => message.kind === 'thinking').map(message => message.step?.groupId)).size, 3);
    assert.equal(snapshot.messages.filter(message => message.kind === 'tool' && message.step?.groupId === id).length, 1);
    const folded = buildStageRows(snapshot, 's', 'logox', 99, {}, null);
    assert.equal(folded.filter(row => row.text.includes('Thinking...')).length, 1);
    assert.ok(folded.some(row => row.text.includes('read sample.txt')), '工具独立于 Thinking，可直接浏览');
    release.resolve();
    await waitForSnapshot(app.store, state => state.activities.some(activity => activity.status === 'completed'));
    snapshot = app.store.getSnapshot();
    const thinking = snapshot.messages.filter(message => message.kind === 'thinking');
    assert.equal(new Set(thinking.map(message => message.step?.groupId)).size, 4);
    assert.equal(snapshot.messages.filter(message => message.kind === 'tool' && message.step?.groupId === id).length, 1);
    assert.equal(snapshot.messages.filter(message => message.kind === 'tool' && !message.step?.groupId).length, 1, '正文之后的工具独立展示');
    const rows = buildStageRows(snapshot, 's', 'logox', 99, {}, null);
    assert.equal(rows.filter(row => row.text.includes('Thought for')).length, 4);
    const entries = await app.journal.load('s', 'logox');
    assert.equal(entries.filter(entry => entry.step?.groupId === id).length, 2);
    assert.equal(entries.filter(entry => entry.step?.title === 'Thinking' && entry.step.state === 'completed').length, 4);
    await app.close();
    const restored = await createApplication(options);
    try {
      assert.deepEqual(new Set(restored.store.getSnapshot().messages.filter(message => message.kind === 'thinking').map(message => message.step?.groupId)), new Set(thinking.map(message => message.step?.groupId)));
      assert.equal(buildStageRows(restored.store.getSnapshot(), 's', 'logox', 99, {}, null).filter(row => row.text.includes('Thought for')).length, 4);
      assert.equal(requests, 4, '恢复不重放模型或工具');
    } finally {await restored.close();}
  } finally {release.resolve(); await app.close(); await rm(cwd, {recursive: true, force: true});}
});
