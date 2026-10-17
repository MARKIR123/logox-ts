import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, Ensemble, type ActorContext} from '../src/actors/ensemble.js';
import {Collaboration} from '../src/actors/collaboration.js';
import {Journal} from '../src/store/journal.js';
import {RuntimeStore} from '../src/runtime/store.js';

async function fixture() {const directory = await mkdtemp(join(tmpdir(), 'logox-collaboration-')); return {directory, journal: new Journal(directory)};}
const call = (name: string, args: unknown) => ({id: 'tool-' + name, name, arguments: JSON.stringify(args)});

test('真实串行队列完成申请、批准、三轮消息，工具不等待后续任务', async () => {
  const f = await fixture();
  try {
    let bridge!: Collaboration;
    let channel = '', running = 0, peak = 0;
    const results: string[] = [];
    const ensemble = new DynamicEnsemble('s', new RuntimeStore(), f.journal, async (prompt, context) => {
      peak = Math.max(peak, ++running);
      try {
        if (prompt === '开始') {
          const receipt = await bridge.execute(call('request_assist', {target: 'custom', reason: '核对'}), context);
          assert.equal(receipt.isError, false);
          channel = (await f.journal.collaborations('s'))[0]!.id;
          assert.equal((await bridge.execute(call('send_message', {channel, text: '未批准'}), context)).isError, true);
          assert.equal((await bridge.execute(call('approve_assist', {channel, approve: true}), context)).isError, true);
        } else if (context.ownerId === 'logox') {
          assert.equal((await bridge.execute(call('approve_assist', {channel, approve: true}), context)).isError, false);
        } else {
          const count = (await f.journal.collaborations('s'))[0]!.messages.length;
          if (count < 6) {
            assert.equal((await bridge.execute(call('send_message', {channel, text: '消息 ' + count}), context)).isError, false);
            assert.equal((await bridge.execute(call('send_message', {channel, text: '重复发送'}), context)).isError, true);
          } else assert.equal((await bridge.execute(call('send_message', {channel, text: '超限'}), context)).isError, true);
        }
        results.push(context.ownerId);
        context.say('【轮次摘要】\n标题：已核对\n报告：验证完成');
      } finally {running--;}
    }, {member: owner => ['logox', 'techne', 'custom'].includes(owner) ? {name: owner, title: '角色'} : undefined,
      settled: (activity, status) => bridge.settle(activity, status)});
    bridge = new Collaboration({sessionId: 's', journal: f.journal, member: owner => ['logox', 'techne', 'custom'].includes(owner), enqueue: (owner, prompt, source) => ensemble.dispatch(owner, prompt, source)});
    await ensemble.dispatch('techne', '开始').done;
    // 队列在执行中继续增长，等待最后一轮完成的外部屏障。
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {if (!ensemble.isBusy()) resolve(); else if (Date.now() > deadline) reject(new Error('队列死锁')); else setTimeout(check, 5);}; check();
    });
    assert.equal(peak, 1);
    const record = (await f.journal.collaborations('s'))[0]!;
    assert.equal(record.messages.length, 6); assert.equal(record.status, 'closed');
    assert.equal(results.length, 9);
    await ensemble.close();
    await f.journal.fork('s', ['logox', 'techne', 'custom'], [record.activityId]);
    assert.deepEqual(await f.journal.collaborations('s'), []);
    assert.deepEqual(await new Journal(f.directory).collaborations('s'), []);
  } finally {await rm(f.directory, {recursive: true, force: true});}
});

test('收尾复用保存摘要，整理失败保持完成，直接对话仅回传锚点', async () => {
  const f = await fixture();
  try {
    const store = new RuntimeStore(); let summary: unknown, handed = 0, anchored = 0;
    const ensemble = new Ensemble('s', store, f.journal, async (_prompt, context) => context.say('【轮次摘要】\n标题：修改完成\n报告：测试通过'), {
      taskEnd: async (_context, value) => {summary = value; throw new Error('整理失败');},
      handoff: async result => {handed++; assert.deepEqual(result.summary, summary);},
      directAnchor: async result => {anchored++; assert.equal('summary' in result, false);},
    });
    const task = ensemble.dispatch('techne', '修改'); await task.done;
    const activity = store.activities.get('s', task.activityId)!;
    assert.equal(activity.status, 'completed'); assert.deepEqual(activity.summary, summary);
    const entries = await f.journal.load('s', 'techne');
    assert.deepEqual((await f.journal.rounds('s', 'techne', entries))[0]!.summary, summary);
    await ensemble.dispatch('techne', '私聊', 'direct').done;
    assert.equal(handed, 1); assert.equal(anchored, 1);
    await ensemble.close();
  } finally {await rm(f.directory, {recursive: true, force: true});}
});

test('协作身份、长度、拒绝、恢复及取消均阻止消息重放', async () => {
  const f = await fixture();
  try {
    let bridge!: Collaboration; let channel = '';
    const ensemble = new DynamicEnsemble('s', new RuntimeStore(), f.journal, async (_prompt, context) => {
      if (context.ownerId !== 'techne') return;
      assert.equal((await bridge.execute(call('request_assist', {target: 'kalon', reason: 'x'.repeat(2001)}), context)).isError, true);
      assert.equal((await bridge.execute(call('request_assist', {target: 'kalon', reason: '核对'}), {...context, sessionId: 'other'})).isError, true);
      await bridge.execute(call('request_assist', {target: 'kalon', reason: '核对'}), context);
      channel = (await f.journal.collaborations('s'))[0]!.id;
      await bridge.recover();
      assert.equal((await bridge.execute(call('send_message', {channel, text: '禁止'}), context)).isError, true);
      await bridge.execute(call('request_assist', {target: 'kalon', reason: '第二次'}), context);
      await bridge.settle(context.activityId, 'cancelled');
      assert.equal((await f.journal.collaborations('s'))[1]!.status, 'closed');
    }, {member: owner => ({name: owner, title: '角色'})});
    bridge = new Collaboration({sessionId: 's', journal: f.journal, member: owner => ['logox', 'techne', 'kalon'].includes(owner), enqueue: (owner, prompt, source) => ensemble.dispatch(owner, prompt, source)});
    await ensemble.dispatch('techne', '验证').done; await ensemble.close();
    assert.equal((await new Journal(f.directory).collaborations('s'))[0]!.status, 'interrupted');
    assert.throws(() => ensemble.dispatch('../unsafe', '任务'));
  } finally {await rm(f.directory, {recursive: true, force: true});}
});
test('Director 拒绝申请后无法传消息，取消已批准渠道会回收排队交付', async () => {
  const f = await fixture();
  try {
    let bridge!: Collaboration; let actor!: ActorContext<string>;
    const ensemble = new DynamicEnsemble('s', new RuntimeStore(), f.journal, async (prompt, context) => {
      if (prompt !== '开始') return;
      actor = context;
      await bridge.execute(call('request_assist', {target: 'kalon', reason: '申请'}), context);
      const channel = (await f.journal.collaborations('s'))[0]!.id;
      const director = {...context, ownerId: 'logox'};
      assert.equal((await bridge.execute(call('approve_assist', {channel, approve: false}), director)).isError, false);
      assert.equal((await bridge.execute(call('send_message', {channel, text: '拒绝后'}), context)).isError, true);
      assert.equal((await bridge.execute(call('approve_assist', {channel, approve: true}), director)).isError, true);
      await bridge.execute(call('request_assist', {target: 'kalon', reason: '新申请'}), context);
      const next = (await f.journal.collaborations('s'))[1]!.id;
      await bridge.execute(call('approve_assist', {channel: next, approve: true}), director);
      await bridge.settle(context.activityId, 'cancelled');
      assert.equal((await bridge.execute(call('send_message', {channel: next, text: '取消后'}), context)).isError, true);
    }, {member: owner => ({name: owner, title: '角色'})});
    bridge = new Collaboration({sessionId: 's', journal: f.journal, member: owner => ['logox', 'techne', 'kalon'].includes(owner), enqueue: (owner, prompt, source) => ensemble.dispatch(owner, prompt, source)});
    await ensemble.dispatch('techne', '开始').done;
    await ensemble.close();
    assert.equal((await f.journal.collaborations('s'))[0]!.status, 'rejected');
    assert.equal((await f.journal.collaborations('s'))[1]!.status, 'closed');
    assert.equal(actor.ownerId, 'techne');
  } finally {await rm(f.directory, {recursive: true, force: true});}
});
