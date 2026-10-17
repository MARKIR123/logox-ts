import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActorRecovery} from '../src/actors/recovery.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import type {TaskOrigin} from '../src/actors/ensemble.js';
import {ExecutionRecoveryError, executionRecoveryInstruction, toolProgressFingerprint} from '../src/kernel/execution-recovery.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {ProviderError} from '../src/providers/http.js';
import {Resources} from '../src/resources/manager.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {createApplication} from '../src/application.js';
import type {ModelRequest, ModelTurn} from '../src/runtime/messages.js';

test('Actor一次纠偏、Director一次调整共用根预算，改派和重启不增加机会', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-budget-')), path = join(directory, 'coordination.json');
  try {
    const recovery = new ActorRecovery('s', path);
    assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'retry');
    assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'handoff');
    assert.equal(await recovery.execution('root', 'no_delivery', 'kalon'), 'handoff');
    assert.deepEqual(await recovery.directorClaim('root', 'no_delivery'), {key: 'execution:no_delivery', attempt: 2});
    const restored = new ActorRecovery('s', path); await restored.recover(new Set(['root']));
    assert.equal(await restored.execution('root', 'no_delivery', 'logox'), 'stop');
    assert.equal(await restored.execution('root', 'no_delivery', 'aletheia'), 'stop');
    assert.equal(await restored.directorClaim('root', 'no_delivery'), undefined);
    assert.equal(await restored.execution('other-root', 'no_delivery', 'logox'), 'retry');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('Logox两次调整后停止；重复工具、计划和派工不重置，新的成果可以开启下一段问题', async () => {
  const recovery = new ActorRecovery('s');
  const read = {id: 'read', name: 'read', arguments: '{"path":"scene.html","offset":1}'};
  const signature = toolProgressFingerprint(read, {text: '1: initial scene', isError: false})!;
  assert.equal(await recovery.progress('root', signature), true);
  assert.equal(await recovery.execution('root', 'no_delivery', 'logox'), 'retry');
  assert.equal(await recovery.execution('root', 'no_delivery', 'logox'), 'retry');
  assert.equal(await recovery.progress('root', signature), false);
  assert.equal(toolProgressFingerprint({...read, name: 'dispatch_role'}, {text: '已排队', isError: false}), undefined);
  assert.equal(toolProgressFingerprint({...read, name: 'update_task_progress'}, {text: '计划已更新', isError: false}), undefined);
  assert.equal(toolProgressFingerprint(read, {text: '未获许可', isError: true, disposition: 'denied'}), undefined);
  assert.equal(await recovery.execution('root', 'no_delivery', 'logox'), 'stop');
  const changed = toolProgressFingerprint(read, {text: '1: improved scene', isError: false})!;
  assert.equal(await recovery.progress('root', changed), true);
  assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'retry');
  const equivalent = {...read, arguments: '{ "offset": 1, "path": "scene.html" }'};
  assert.equal(toolProgressFingerprint(equivalent, {text: '1: improved scene', isError: false}), changed);
});

test('截断正文和工具共用两次接续，只有一次Director核对且不消耗网络预算', async () => {
  const recovery = new ActorRecovery('s');
  assert.equal(await recovery.execution('root', 'truncated_text', 'techne'), 'retry');
  assert.equal(await recovery.execution('root', 'truncated_tools', 'techne'), 'retry');
  assert.equal(await recovery.execution('root', 'truncated_tools', 'techne'), 'handoff');
  assert.deepEqual(await recovery.directorClaim('root', 'truncated_text'), {key: 'execution:truncated', attempt: 2});
  assert.equal(await recovery.directorClaim('root', 'truncated_tools'), undefined);
  assert.equal(await recovery.execution('root', 'truncated_text', 'logox'), 'stop');
  assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'retry');
  assert.equal((await recovery.next('root', new ProviderError('网络断开', true, 'temporary'))).attempt, 1);
});

test('明确继续授予新组并保留累计记录和工具指纹，回退删除无效根预算', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-grant-')), path = join(directory, 'coordination.json');
  try {
    const recovery = new ActorRecovery('s', path);
    await recovery.progress('root', 'stage:build:骨架已落盘');
    await recovery.execution('root', 'no_delivery', 'logox'); await recovery.execution('root', 'no_delivery', 'logox');
    await recovery.execution('root', 'truncated_text', 'techne'); await recovery.execution('root', 'truncated_tools', 'techne');
    await recovery.directorClaim('root', 'truncated_tools');
    await recovery.grantExecution('root');
    assert.equal(await recovery.progress('root', 'stage:build:骨架已落盘'), false);
    assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'retry');
    assert.equal(await recovery.execution('root', 'truncated_tools', 'techne'), 'retry');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.execution.root.noDelivery.total, 3);
    assert.equal(saved.execution.root.truncation.total, 3);
    assert.ok(saved.execution.root.history.some((event: {event: string}) => event.event === 'grant'));
    const rewind = new ActorRecovery('s', path); await rewind.recover(new Set());
    assert.equal(await rewind.execution('root', 'no_delivery', 'logox'), 'retry');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('旧协调文件无execution字段仍可恢复，不因打开空会话保存文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-old-')), path = join(directory, 'coordination.json');
  try {
    const empty = new ActorRecovery('s', path); await empty.recover(); await empty.flush();
    await assert.rejects(readFile(path), {code: 'ENOENT'});
    await writeFile(path, JSON.stringify({version: 1, sessionId: 's', stopped: false, roots: {}, pending: []}));
    const restored = new ActorRecovery('s', path); await restored.recover();
    assert.equal(await restored.execution('root', 'no_delivery', 'kalon'), 'retry');
  } finally {await rm(directory, {recursive: true, force: true});}
});

async function servicesFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-handoff-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const queued: {owner: string; prompt: string; source: string; origin: TaskOrigin}[] = [];
  const registry = new ProviderRegistry(config, {});
  const services = new ActorServices({sessionId: 's', catalog, config, registry, journal: new Journal(join(directory, 'journal')),
    resources: new Resources(directory, {home: directory, boundary: directory}), requireIdle() {}, approve: async () => false,
    enqueue(owner, prompt, source, origin = {}) {
      queued.push({owner, prompt, source, origin});
      return {activityId: 'director-' + queued.length, done: Promise.resolve(), cancel() {}};
    }, coordinationPath: join(directory, 'coordination.json')});
  return {services, queued, async close() {await services.flush(); await registry.close(); await rm(directory, {recursive: true, force: true});}};
}
const summary = {title: '当前步骤尚未交付', report: '保留已完成读取；下一步需要落盘骨架。', source: 'local' as const};

test('无交付异常专门交接Actor身份与原断点，Director耗尽后不追加解释请求', async () => {
  const f = await servicesFixture();
  try {
    await f.services.recovery.execution('root', 'no_delivery', 'techne');
    await f.services.handoff({ownerId: 'techne', activityId: 'failed-actor', rootActivityId: 'root', source: 'logox', status: 'failed',
      summary, error: new ExecutionRecoveryError('no_delivery', 'handoff')});
    assert.equal(f.queued.length, 1); assert.equal(f.queued[0]!.source, 'techne');
    assert.equal(f.queued[0]!.origin.inputKind, 'actor');
    assert.deepEqual(f.queued[0]!.origin.recovery, {key: 'execution:no_delivery', attempt: 2});
    assert.match(f.queued[0]!.prompt, /resumeTask.*failed-actor/);
    assert.doesNotMatch(f.queued[0]!.prompt, /模型请求超时|工具全部|1\/2/);
    await f.services.handoff({ownerId: 'logox', activityId: 'director-1', rootActivityId: 'root', source: 'techne',
      recovery: f.queued[0]!.origin.recovery!, status: 'failed', summary, error: new ExecutionRecoveryError('no_delivery', 'stop')});
    assert.equal(f.queued.length, 1); assert.match(f.services.resumeDirector(), /当前步骤尚未交付/);
  } finally {await f.close();}
});

test('用户停止与主循环暂停优先，均不自动消费Director纠偏机会', async () => {
  const f = await servicesFixture();
  try {
    await f.services.recovery.execution('user-root', 'no_delivery', 'kalon');
    await f.services.handoff({ownerId: 'kalon', activityId: 'user-stop', rootActivityId: 'user-root', source: 'direct', status: 'cancelled',
      stopReason: 'user', summary, error: new ExecutionRecoveryError('no_delivery', 'handoff')});
    assert.equal(f.queued.length, 0);
    assert.equal(await f.services.recovery.execution('user-root', 'no_delivery', 'logox'), 'retry');
    f.services.stopDirector('main');
    await f.services.recovery.execution('paused-root', 'no_delivery', 'techne');
    await f.services.handoff({ownerId: 'techne', activityId: 'late-actor', rootActivityId: 'paused-root', source: 'logox', status: 'failed',
      summary, error: new ExecutionRecoveryError('no_delivery', 'handoff')});
    assert.equal(f.queued.length, 0);
    assert.equal(await f.services.recovery.execution('paused-root', 'no_delivery', 'logox'), 'retry');
  } finally {await f.close();}
});

test('恢复指令具体缩小步骤，不携带长思考或修改模型额度', () => {
  assert.match(executionRecoveryInstruction('no_delivery', 'techne'), /minimum deliverable step/i);
  assert.match(executionRecoveryInstruction('no_delivery', 'logox', true), /Pivot action plan/i);
  assert.match(executionRecoveryInstruction('truncated_tools', 'techne'), /batch was not executed/i);
  assert.match(executionRecoveryInstruction('truncated_text', 'logox'), /from the break point/i);
});

test('正式应用无交付收束、用户继续沿用Actor阶段与原根，不重放工具或伪造新用户回传', {timeout: 10000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-application-'));
  const config = await loadConfig(directory, {provider: {model: 'fixture', context_window: 131072},
    kernel: {max_retries: 0}, permissions: {mode: 'creative'}}, {}, directory, directory);
  const requests: ModelRequest[] = [];
  let allowedContinue = false;
  const app = await createApplication({cwd: directory, config, sessionId: 's', resourceOptions: {home: directory, boundary: directory},
    env: {}, authPath: join(directory, 'auth.json'), provider: {async respond(request, delta): Promise<ModelTurn> {
      requests.push(request);
      if (requests.length === 1) return {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [{id: 'plan',
        name: 'update_task_progress', arguments: JSON.stringify({stages: [{id: 'skeleton', title: '理顺可运行骨架',
          purpose: '先形成可运行的最小页面', activeForm: '正在搭建可运行骨架'}], update: {id: 'skeleton', status: 'in_progress'}})}]}};
      if (allowedContinue) {
        assert.match(request.system, /当前阶段：理顺可运行骨架/);
        assert.ok(request.messages.every(message => message.role !== 'assistant' || !!message.text || !!message.toolCalls?.length));
        return {stop: 'complete', message: {role: 'assistant', text: '已有阶段和工具结果已核对，当前步骤可以继续。'}};
      }
      delta({kind: 'reasoning', text: '只在思考，没有交付'});
      return {stop: 'length', message: {role: 'assistant', text: '', reasoning: '只在思考，没有交付'}};
    }}});
  const idle = async () => {
    const end = Date.now() + 4000;
    while (app.ensemble.isBusy()) {if (Date.now() > end) throw new Error('执行恢复没有收敛'); await new Promise(resolve => setTimeout(resolve, 5));}
  };
  try {
    await app.submit('@techne 建立可运行页面'); await idle();
    assert.equal(requests.length, 4, '登记计划、Actor两次无交付、Director一次调整后收束');
    const tasks = app.store.getSnapshot().activities;
    const actor = tasks.find(task => task.ownerId === 'techne')!;
    assert.equal(actor.status, 'failed'); assert.equal(actor.progress?.activeStageId, 'skeleton');
    assert.equal(tasks.filter(task => task.ownerId === 'logox').length, 1, '不再增加只为解释失败的模型请求');
    allowedContinue = true;
    await app.submit('@techne 继续'); await idle();
    const continued = app.store.getSnapshot().activities.filter(task => task.ownerId === 'techne').at(-1)!;
    assert.equal(continued.rootActivityId, actor.rootActivityId ?? actor.activityId);
    assert.equal(continued.status, 'completed'); assert.equal(continued.progress?.activeStageId, 'skeleton');
    const records = await app.journal.load('s', 'techne');
    assert.equal(records.filter(entry => entry.message?.role === 'tool' && entry.message.name === 'update_task_progress').length, 1);
    assert.ok(app.store.getSnapshot().messages.every(message => message.ownerId !== 'logox' ||
      message.role !== 'user' || message.inputKind !== 'actor'));
  } finally {await app.close(); await rm(directory, {recursive: true, force: true});}
});
