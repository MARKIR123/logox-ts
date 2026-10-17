import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {act} from 'react';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/stage.js';
import {App} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {cast} from '../src/actors/ensemble.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

function task() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor',
    title: '原始任务', status: 'running', stage: '处理中', detail: ''});
  store.message('s', 'techne', 'user', '检查原始任务', {activityId: 'a'});
  store.message('s', 'techne', 'assistant', '工作流程原文', {activityId: 'a'});
  return store;
}

test('Actor 完成卡片复用运行时摘要，收起显示标题、展开保留报告和原始流程', () => {
  const store = task();
  const summary = {title: '已修复会话切换', report: '模型和用量恢复正确，回归通过。', source: 'model' as const};
  store.activities.update('s', 'a', {status: 'completed', stage: '已完成', summary});
  const closed = buildStageRows(store.getSnapshot(), 's', 'logox', 90, {a: false}, null).map(row => row.text).join('\n');
  assert.ok(closed.includes(summary.title));
  assert.ok(!closed.includes('检查原始任务'));
  assert.ok(!closed.includes(summary.report));
  const opened = buildStageRows(store.getSnapshot(), 's', 'logox', 90, {a: true}, null).map(row => row.text).join('\n');
  assert.ok(opened.includes(summary.report));
  assert.ok(opened.includes('工作流程原文'));
  assert.ok(opened.indexOf(summary.report) < opened.indexOf('工作流程原文'));
  const techneView = buildStageRows(store.getSnapshot(), 's', 'techne', 90, {a: false}, null).map(row => row.text).join('\n');
  assert.ok(!techneView.includes(summary.title), 'Actor 独立视口不渲染自引用的完成状态卡片');
  assert.ok(techneView.includes('检查原始任务'), 'Actor 独立视口直接展示派工原任务');
  assert.ok(techneView.includes('工作流程原文'), 'Actor 独立视口直接展示工作流正文');
  assert.throws(() => store.activities.update('s', 'a', {summary: {...summary, title: '不能改终态'}}), /已结束/);
});

test('Actor 失败卡片在两个窗口直接显示原因，完整报告仍折叠在原任务内', () => {
  const store = task();
  const reason = '模型流连接中断：连接被关闭（UND_ERR_SOCKET）';
  store.activities.update('s', 'a', {status: 'failed', stage: '执行失败', detail: '失败原因：' + reason + '\n完整故障详情',
    summary: {title: '执行失败，需继续处理', report: '已经完成的工作报告', source: 'local'}});
  for (const view of ['logox', 'techne']) {
    const rows = buildStageRows(store.getSnapshot(), 's', view, 100, {a: false}, null);
    assert.ok(rows.some(row => row.text.includes(reason)));
    assert.ok(!rows.some(row => /完整故障详情|已经完成的工作报告/.test(row.text)));
    const opened = buildStageRows(store.getSnapshot(), 's', view, 100, {a: true}, null).map(row => row.text).join('\n');
    assert.match(opened, /完整故障详情/);
    assert.match(opened, /已经完成的工作报告/);
  }
});

test('动态角色真实 Ink：自定义身份与卡片、独立草稿、切换和发送来源', async () => {
  const store = new RuntimeStore(), input = new TerminalInput(), output = new TerminalScreen();
  output.rows = 40;
  const roles = [...Object.entries(cast).map(([id, role]) => ({id, ...role})),
    {id: 'scout', name: '侦察助手', title: '调查', symbol: '◇', color: '#a8f0d4'}];
  const submissions: Array<{text: string; source: string | undefined}> = [];
  store.activities.create({sessionId: 's', activityId: 'custom', ownerId: 'scout', kind: 'actor', title: '调查', status: 'completed',
    stage: '完成', detail: '', summary: {title: '已查清调用链', report: '证据位于 src/a.ts:2', source: 'model'}});
  store.message('s', 'scout', 'user', '查调用链', {activityId: 'custom'});
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {instance = renderTerminal(<App store={store} sessionId="s" stage getActors={() => roles}
    onSubmit={async (text, source) => {submissions.push({text, source});}} onCancel={() => {}} onClose={async () => {}}/>,
  {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
  const key = async (text: string) => {await act(async () => {input.write(text); if (text === '\x1b') await delay(45);}); await instance.waitUntilRenderFlush();};
  try {
    assert.match(output.lines.join('\n'), /侦察助手/);
    assert.match(output.lines.join('\n'), /已查清调用链/);
    for (let i = 0; i < 4; i++) await key('\x07');
    await key('独立草稿');
    assert.match(output.lines.join('\n'), /侦察助手 · 独立对话/);
    await key('\x1b');
    assert.doesNotMatch(output.lines.join('\n'), /独立草稿/);
    for (let i = 0; i < 4; i++) await key('\x07');
    assert.match(output.lines.join('\n'), /独立草稿/);
    await key('\r');
    assert.deepEqual(submissions, [{text: '独立草稿', source: 'scout'}]);
  } finally {await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();}
});

class TerminalInput extends PassThrough {
  isTTY = true;
  setRawMode(): this {return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}

test('真实 Ink：新请求重新展开已折叠 Actor 卡片，同一请求刷新尊重手工折叠', {timeout: 8000}, async () => {
  const store = task(), input = new TerminalInput(), output = new TerminalScreen();
  output.rows = 40;
  const ask = (body: string) => store.interactions.open({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'question',
    title: '确认转用', questions: [{id: 'model', header: '模型', question: body,
      options: [{id: 'yes', label: '转用', description: '仅本次任务'}, {id: 'no', label: '不转用', description: '保留当前结果'}]}]});
  const first = ask('第一个模型候选');
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {instance = renderTerminal(<App store={store} sessionId="s" stage onSubmit={async () => {}}
    onCancel={() => {}} onClose={async () => {store.interactions.close();}}/>, {
      stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
      patchConsole: false, exitOnCtrlC: false, maxFps: 60,
    });});
  const key = async (text: string) => {
    await act(async () => {input.write(text); if (text === '\x1b') await delay(45);});
    await instance.waitUntilRenderFlush();
  };
  const screen = () => output.lines.join('\n');
  try {
    assert.ok(screen().includes('第一个模型候选'));
    await key('\t'); await key('\x1b');
    assert.ok(!screen().includes('第一个模型候选'));
    await act(async () => {store.message('s', 'logox', 'notice', '无关快照刷新');});
    await instance.waitUntilRenderFlush();
    assert.ok(!screen().includes('第一个模型候选'));
    await act(async () => {store.interactions.cancel(first.requestId); ask('第二个模型候选');});
    await instance.waitUntilRenderFlush();
    assert.ok(screen().includes('第二个模型候选'));
    await key('\t'); await key('\x1b');
    await act(async () => {store.activities.update('s', 'a', {detail: '仍在等待本次确认'});});
    await instance.waitUntilRenderFlush();
    assert.ok(!screen().includes('第二个模型候选'));
    assert.equal(store.interactions.list().filter(item => item.status === 'pending').length, 1);
  } finally {await act(async () => {store.interactions.close(); instance.unmount();});}
});
