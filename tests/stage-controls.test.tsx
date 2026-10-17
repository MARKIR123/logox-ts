import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal} from '../src/tui/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {App} from '../src/tui/app.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {StatusbarPreferences, defaultStatusbar} from '../src/config/statusbar-preferences.js';
import {statusbarText} from '../src/tui/statusbar.js';
import {buildStageRows} from '../src/tui/stage.js';
import {palette} from '../src/tui/cards.js';

class Input extends PassThrough {
  isTTY = true;
  setRawMode(): this {return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}
function task(store: RuntimeStore, id: string, ownerId = 'techne') {
  store.activities.create({sessionId: 's', activityId: id, ownerId, kind: ownerId === 'logox' ? 'director' : 'actor',
    title: '完成 ' + id, stage: '执行', detail: '', status: 'running'});
  store.message('s', ownerId, 'user', '任务 ' + id, {activityId: id});
}
function mount(store: RuntimeStore, extra: Partial<React.ComponentProps<typeof App>> = {}) {
  const input = new Input(), output = new TerminalScreen(), stopped: string[] = [];
  let closed = 0;
  const instance = renderTerminal(<App stage store={store} sessionId="s" onSubmit={async () => {}}
    onCancel={id => stopped.push(id)} onClose={async () => {closed++;}} {...extra}/>, {
    stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true,
    patchConsole: false, exitOnCtrlC: false, maxFps: 100,
  });
  const key = async (text: string) => {input.write(text); await delay(text === '\x1b' ? 65 : 40); await instance.waitUntilRenderFlush();};
  const cleanup = async () => {instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();};
  return {input, output, instance, key, cleanup, stopped, closed: () => closed};
}

test('用户状态栏偏好原子保存、重读与坏文件保护，模块顺序决定窄屏收起', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-statusbar-'));
  try {
    const path = join(dir, 'statusbar.json'), prefs = new StatusbarPreferences(path);
    await prefs.load(); assert.deepEqual(prefs.getSnapshot().modules, defaultStatusbar);
    const reversed = [...defaultStatusbar].reverse();
    await prefs.save(reversed);
    const reloaded = new StatusbarPreferences(path); await reloaded.load(); assert.deepEqual(reloaded.getSnapshot().modules, reversed);
    await assert.rejects(prefs.save([{id: 'role', enabled: true}])); assert.deepEqual(prefs.getSnapshot().modules, reversed);
    await writeFile(path, '{invalid');
    await assert.rejects(prefs.load()); await assert.rejects(prefs.save(defaultStatusbar)); assert.equal(await readFile(path, 'utf8'), '{invalid');
    const status = {ownerId: 'logox', name: 'Logox', model: {provider: 'demo', model: 'flash'}, effort: 'high', permission: '工作区',
      context: {tokens: 20, window: 100}, state: '执行中'};
    assert.equal(statusbarText(status, 5), 'Logox');
    assert.equal(statusbarText(status, 25), 'Logox · demo/flash');
    assert.match(statusbarText(status, 120), /(?:Thinking|思考) high.*(?:Permission|权限) 工作区.*(?:Context|上下文) 20%.*执行中/);
    assert.match(statusbarText({...status, cost: 1.25, costCurrency: 'CNY'}, 50, [{id: 'cost', enabled: true}]), /(?:Cost|费用) CNY 1.2500/);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('失败原位置折叠、系统灰色轨道、终态卡片不在新消息后重复追加', () => {
  const store = new RuntimeStore(); task(store, 'old', 'logox');
  store.message('s', 'logox', 'assistant', '部分回复', {activityId: 'old'});
  store.activities.update('s', 'old', {status: 'failed', detail: 'HTTP 400\n完整故障流程'});
  store.message('s', 'logox', 'system', 'HTTP 400', {activityId: 'old'});
  store.message('s', 'logox', 'system', '模型切换成功');
  store.message('s', 'logox', 'user', '下一任务');
  const collapsed = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {}, null);
  assert.equal(collapsed.filter(row => row.action?.foldId === 'old').length, 1);
  assert.ok(collapsed.findIndex(row => row.action?.foldId === 'old') < collapsed.findIndex(row => row.text === '下一任务'));
  assert.ok(!collapsed.some(row => row.text.includes('完整故障流程')));
  const system = collapsed.find(row => row.text === '模型切换成功'); assert.equal(system?.color, palette.muted); assert.equal(system?.railColor, palette.muted);
  const expanded = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {old: true}, null);
  assert.equal(expanded.filter(row => row.text.includes('完整故障流程')).length, 1);
  for (const width of [20, 40, 79]) {
    const long = new RuntimeStore(); task(long, 'long-title', 'logox');
    long.activities.update('s', 'long-title', {status: 'failed', title: '这是很长的任务标题'.repeat(20), detail: '失败原因'});
    assert.equal(buildStageRows(long.getSnapshot(), 's', 'logox', width, {}, null).filter(row => row.action?.foldId === 'long-title').length, 1, '长故障标题仍收为一行');
  }
  task(store, 'actor'); store.activities.update('s', 'actor', {status: 'failed', detail: 'Actor模型故障'});
  store.message('s', 'techne', 'system', 'Actor模型故障', {activityId: 'actor'});
  assert.equal(buildStageRows(store.getSnapshot(), 's', 'logox', 79, {actor: true}, null).filter(row => row.text === 'Actor模型故障').length, 1, 'Actor错误只显示一次');
});

test('Ctrl+C 复制不计入退出，其它输入解除提示，原生中断与双击共用退出动作', {timeout: 7000}, async () => {
  const store = new RuntimeStore(); store.message('s', 'logox', 'assistant', '可复制的正文'); task(store, 'actor');
  let interrupt = () => {};
  const ui = mount(store, {registerInterrupt: handler => {interrupt = handler; return () => {interrupt = () => {};};}});
  try {
    await delay(80);
    const rows = buildStageRows(store.getSnapshot(), 's', 'logox', ui.output.columns - 1, {}, null);
    const at = rows.findIndex(row => row.text === '可复制的正文');
    await ui.key(`\x1b[<0;3;${at + 1}M\x1b[<32;18;${at + 1}M\x1b[<0;18;${at + 1}m`);
    const before = (ui.output.text.match(/\x1b\]52;c;/g) ?? []).length;
    await ui.key('\x03'); interrupt(); await delay(40);
    assert.ok((ui.output.text.match(/\x1b\]52;c;/g) ?? []).length >= before + 2);
    assert.equal(ui.closed(), 0); assert.deepEqual(ui.stopped, []);
    await ui.key('\x1b'); // Clear selection, not the running Actor.
    await ui.key('\x03'); await ui.key('x'); await ui.key('\x03'); assert.equal(ui.closed(), 0);
    interrupt(); await delay(40); assert.equal(ui.closed(), 1); assert.deepEqual(ui.stopped, []);
  } finally {await ui.cleanup();}
});

test('Actor Esc 始终返回，主窗口 Esc 只停止 Logox，卡片独立鼠标与键盘停止', {timeout: 7000}, async () => {
  const store = new RuntimeStore(); task(store, 'main', 'logox'); task(store, 'actor');
  const ui = mount(store);
  try {
    await delay(80);
    await ui.key('\x07'); await ui.key('\x07'); // Ctrl+G -> running Techne.
    await ui.key('\x1b'); assert.deepEqual(ui.stopped, []);
    await ui.key('\x1b'); assert.deepEqual(ui.stopped, ['main']);
    const rows = buildStageRows(store.getSnapshot(), 's', 'logox', ui.output.columns - 1, {}, null);
    const at = rows.findIndex(row => row.controls?.[0]?.action.foldId === 'actor'), control = rows[at]!.controls![0]!;
    await ui.key(`\x1b[<0;${control.startCol + 1};${at + 1}M\x1b[<0;${control.startCol + 1};${at + 1}m`.repeat(2));
    assert.deepEqual(ui.stopped, ['main', 'actor']);
    await ui.key(`\x1b[<0;${control.startCol + 1};${at + 1}M`); assert.deepEqual(ui.stopped, ['main', 'actor'], '停止中不可重复点击');
    assert.ok(ui.output.lines.join('\n').includes('停止中…'));
    store.activities.update('s', 'actor', {status: 'cancelled'}); task(store, 'second'); await delay(80);
    await ui.key('\t'); await ui.key('\r'); assert.deepEqual(ui.stopped, ['main', 'actor', 'second']);
    const terminal = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {}, null);
    assert.ok(!terminal.some(row => row.controls?.some(control => control.action.foldId === 'actor')));
  } finally {await ui.cleanup();}
});

test('页签保存失败保留草案与原配置，保存期间不能取消或重复提交', async () => {
  const surfaces = new CommandSurfaces(() => {});
  let calls = 0, release = () => {};
  surfaces.openPage('设置', [{id: 'statusbar', title: '状态栏', lines: [], toggles: defaultStatusbar}], 'statusbar', {
    onSaveToggles: async () => {calls++; if (calls === 1) throw new Error('磁盘忙'); await new Promise<void>(resolve => {release = resolve;}); return {message: '已保存'};},
  });
  const id = surfaces.getSnapshot()!.id;
  await surfaces.saveToggles(id, 'statusbar', defaultStatusbar);
  const failed = surfaces.getSnapshot(); assert.ok(failed?.kind === 'page'); assert.equal(failed.error, '磁盘忙');
  assert.deepEqual(failed.tabs[0]?.toggles, defaultStatusbar);
  const saving = surfaces.saveToggles(id, 'statusbar', defaultStatusbar);
  surfaces.cancel(); await surfaces.saveToggles(id, 'statusbar', defaultStatusbar); assert.equal(calls, 2); assert.ok(surfaces.getSnapshot());
  release(); await saving; assert.equal(surfaces.getSnapshot(), null);
});

test('正式状态栏保持单行，布局变化立即生效，角色窗口展示各自状态', {timeout: 7000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-statusbar-ui-')), prefs = new StatusbarPreferences(join(dir, 'statusbar.json'));
  const store = new RuntimeStore();
  const ui = mount(store, {statusbar: prefs, getStatus: ownerId => ({ownerId, name: ownerId, model: {provider: 'demo', model: ownerId + '-model'},
    effort: 'high', permission: '工作区', context: {tokens: 25, window: 100}, state: '就绪'})});
  try {
    await delay(80);
    assert.ok(ui.output.lines.at(-1)?.includes('logox · demo/logox-model'));
    await ui.key('\x07'); assert.ok(ui.output.lines.at(-1)?.includes('aletheia · demo/aletheia-model'));
    await prefs.save(defaultStatusbar.map(item => ({...item, enabled: item.id === 'context'}))); await delay(80); await ui.instance.waitUntilRenderFlush();
    assert.match(ui.output.lines.at(-1)?.trim() ?? '', /(?:上下文|Context) 25%/);
    ui.output.resize(16, 12); await delay(80); await ui.instance.waitUntilRenderFlush();
    assert.match(ui.output.lines.at(-1)?.trim() ?? '', /(?:上下文|Context) 25%/);
    assert.ok(!ui.output.lines.at(-2)?.match(/(?:上下文|Context) 25%/), '状态不换成第二行');
  } finally {await ui.cleanup(); await rm(dir, {recursive: true, force: true});}
});

test('/status toggle Space 开关、左右排序、鼠标与取消保存互相隔离', {timeout: 7000}, async () => {
  const store = new RuntimeStore(), surfaces = new CommandSurfaces(() => {}), saved: string[][] = [];
  const tabs = [{id: 'status', title: '状态', lines: ['正常']}, {id: 'statusbar', title: '状态栏', lines: [], toggles: defaultStatusbar}];
  const open = () => surfaces.openPage('设置', tabs, 'statusbar', {onSaveToggles: (_id, items) => {saved.push(items.filter(item => item.enabled).map(item => item.id)); return {};}});
  open(); const ui = mount(store, {surfaces});
  try {
    await delay(80);
    assert.ok(ui.output.lines.join('\n').includes('[■]')); assert.ok(ui.output.lines.join('\n').includes('[ ]'));
    await ui.key(' '); await ui.key('\x1b[C'); await ui.key('\x1b'); assert.equal(saved.length, 0);
    open(); await delay(80); await ui.key(' '); await ui.key('\x1b[C'); await ui.key('\r');
    assert.deepEqual(saved[0], ['model', 'effort', 'permission', 'context', 'state']);
    open(); await delay(80);
    await ui.key('\x1b[<0;5;5M'); await ui.key('\r'); assert.ok(!saved[1]!.includes('role'), '鼠标点击toggle开关');
    assert.equal(store.getSnapshot().messages.length, 0, '设置界面不产生任务历史');
    store.message('s', 'logox', 'assistant', '设置返回后仍能复制'); await delay(80);
    await ui.key('\x1b[<0;3;3M\x1b[<32;30;3M\x1b[<0;30;3m');
    assert.ok(ui.output.text.includes('\x1b]52;c;'), '设置页关闭不会移除主界面鼠标监听');
  } finally {await ui.cleanup();}
});
