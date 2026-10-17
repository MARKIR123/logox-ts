import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, readFile, writeFile, mkdir, rm, readdir, cp, symlink} from 'node:fs/promises';
import {join, basename, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {SessionManager} from '../src/store/sessions.js';
import {SessionTrash} from '../src/store/session-trash.js';
import {Journal} from '../src/store/journal.js';
import {UsageLedger} from '../src/context/usage.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {ApplicationStage} from '../src/tui/application.js';
import {renderTerminal} from '../src/tui/terminal.js';
import {TerminalScreen} from './terminal-screen.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
const key = (id: string) => createHash('sha256').update(id).digest('hex');
type Application = Awaited<ReturnType<typeof createApplication>>;
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-delete-'))), manager = await SessionManager.open(cwd);
  const journal = new Journal(join(manager.directory, 'sessions'));
  const seed = async (id: string, owner = 'logox') => {
    const activityId = id + '-' + owner;
    await journal.append({version: 1, sessionId: id, ownerId: owner, activityId, role: 'user', text: id + '正文', time: 1});
    await journal.append({version: 1, sessionId: id, ownerId: owner, activityId, role: 'assistant', text: '完成', time: 2});
    await journal.checkpoint(id, {activityId, ownerId: owner, prompt: id + '正文', source: 'logox', status: 'completed', time: 1});
    await journal.finish(id, owner, activityId, 'completed'); await manager.touch(id, id + '正文');
  };
  return {cwd, manager, journal, seed, cleanup: () => rm(cwd, {recursive: true, force: true})};
}
function picker(app: Application) {const state = app.surfaces.getSnapshot(); assert.ok(state?.kind === 'picker'); return state;}
async function openDelete(app: Application, id: string) {
  const list = picker(app), item = list.items.find(item => JSON.parse(item.id)[0] === id);
  assert.ok(item); await app.surfaces.deleteItem(list.id, item.id); return picker(app);
}

test('删除备份动态角色、所有分支/归档/用量/系统和协作状态；最近恢复跳过删除记录，手动恢复可重新打开', async () => {
  const f = await fixture();
  try {
    await f.seed('victim'); await f.seed('victim', 'retired_actor'); await f.seed('other');
    const raw = await readFile(f.journal.path('victim', 'retired_actor'), 'utf8');
    await f.journal.fork('victim', ['logox', 'retired_actor'], ['victim-retired_actor']);
    const tools = f.journal.path('victim', 'retired_actor') + '.tools'; await mkdir(tools); await writeFile(join(tools, 'result.txt'), '归档内容');
    const stateHash = createHash('sha256').update(JSON.stringify(['victim', '$system'])).digest('hex');
    await writeFile(join(f.manager.directory, 'sessions', stateHash + '.jsonl.events.json'), '系统记录');
    await mkdir(join(f.manager.directory, 'task-models')); await writeFile(join(f.manager.directory, 'task-models', key('victim') + '.task-models.jsonl'), '任务模型');
    await mkdir(join(f.manager.directory, 'actor-coordination')); await writeFile(join(f.manager.directory, 'actor-coordination', key('victim') + '.json'), '协作记录');
    const usage = new UsageLedger(join(f.manager.directory, 'usage'), text => {throw new Error(text);});
    usage.record('victim', 'retired_actor', {id: 'actual', model: 'synthetic', category: 'task', input: 10, output: 1, cacheRead: 0, cacheWrite: 0}); await usage.flush();
    await writeFile(join(f.cwd, 'changed.txt'), '已经执行的项目修改'); await f.manager.remember('victim');
    const other = await readFile(f.journal.path('other', 'logox'), 'utf8');
    const result = await f.manager.remove('victim'); assert.deepEqual(result.remaining, []);
    const manifest = JSON.parse(await readFile(join(result.archive, 'manifest.json'), 'utf8')) as {id: string; files: Array<{path: string; hash: string}>};
    assert.equal(manifest.id, 'victim'); assert.ok(manifest.files.some(file => file.path.includes('branch.json')));
    assert.ok(manifest.files.some(file => file.path.startsWith('task-models'))); assert.ok(manifest.files.some(file => file.path.startsWith('usage')));
    assert.equal(await readFile(join(result.archive, 'files', 'sessions', basename(f.journal.path('victim', 'retired_actor'))), 'utf8'), raw);
    assert.equal(await readFile(join(result.archive, 'files', 'sessions', basename(tools), 'result.txt'), 'utf8'), '归档内容');
    assert.equal(await readFile(join(f.cwd, 'changed.txt'), 'utf8'), '已经执行的项目修改');
    assert.equal(await readFile(f.journal.path('other', 'logox'), 'utf8'), other);
    assert.deepEqual((await f.manager.list()).sessions.map(item => item.id), ['other']);
    assert.equal(await f.manager.recent(), 'other'); assert.equal(await f.manager.hasContent('victim'), false);
    await assert.rejects(f.manager.acquire('victim'), /已删除/); await assert.rejects(f.manager.info('victim'), /已删除/);
    // 用户退出应用后的手动恢复步骤：按清单原相对路径放回，最后去掉删除标记。
    await cp(join(result.archive, 'files'), f.manager.directory, {recursive: true});
    await rm(join(f.manager.directory, 'deleted', key('victim') + '.json'));
    assert.ok((await f.manager.list()).sessions.some(item => item.id === 'victim'));
    const lease = await f.manager.acquire('victim'); await lease.release();
  } finally {await f.cleanup();}
});

test('活跃租约拒绝删除；坏尾行完整备份；拷贝或标记失败保留原文和列表；清理时新增变化保留且不复活', async () => {
  const f = await fixture();
  try {
    await f.seed('victim'); const path = f.journal.path('victim', 'logox');
    await writeFile(path, (await readFile(path, 'utf8')) + '{bad-tail'); const original = await readFile(path, 'utf8');
    const live = await f.manager.acquire('victim');
    await assert.rejects(f.manager.remove('victim'), /占用/); assert.equal(await readFile(path, 'utf8'), original); await live.release();
    const relativePath = relative(f.manager.directory, path);
    class FailingTrash extends SessionTrash {protected override async publishRemoval(): Promise<void> {throw new Error('磁盘保存失败');}}
    await assert.rejects(new FailingTrash(f.manager.directory, f.cwd).remove('victim', [relativePath]), /磁盘保存失败/);
    assert.equal(await readFile(path, 'utf8'), original); assert.ok((await f.manager.list()).sessions.some(item => item.id === 'victim'));
    await assert.rejects(new SessionTrash(f.manager.directory, f.cwd).remove('victim', ['../changed.txt']), /超出/);
    class ChangingTrash extends SessionTrash {
      protected override async publishRemoval(id: string, archive: string): Promise<void> {await super.publishRemoval(id, archive); await writeFile(path, original + '\n外部变化');}
    }
    const result = await new ChangingTrash(f.manager.directory, f.cwd).remove('victim', [relativePath]);
    assert.deepEqual(result.remaining, [relativePath]); assert.equal(await readFile(path, 'utf8'), original + '\n外部变化');
    assert.equal(await readFile(join(result.archive, 'files', relativePath), 'utf8'), original);
    assert.ok(!(await f.manager.list()).sessions.some(item => item.id === 'victim'));
  } finally {await f.cleanup();}
});

test('回收路径不跟随目录链接，备份失败不提交删除', async () => {
  const f = await fixture();
  try {
    await f.seed('victim'); const outside = join(f.cwd, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), '保留');
    const directory = f.journal.path('victim', 'logox') + '.tools';
    await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.manager.remove('victim'), /链接/);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), '保留'); assert.ok(await f.manager.info('victim'));
    assert.equal(await new SessionTrash(f.manager.directory, f.cwd).isDeleted('victim'), false);
  } finally {await f.cleanup();}
});

test('/resume 删除默认取消、确认刷新、当前/新建项保护、活租约失败可重试、显式已删ID拒绝', async () => {
  const f = await fixture(); let app: Application | undefined;
  try {
    await f.seed('victim'); await f.seed('current');
    const config = await loadConfig(f.cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, f.cwd, f.cwd);
    app = await createApplication({cwd: f.cwd, sessionId: 'current', config, env: {}, authPath: join(f.cwd, 'auth.json'),
      resourceOptions: {home: f.cwd, boundary: f.cwd}});
    await app.submit('/resume'); const list = picker(app);
    assert.equal(list.items.find(item => JSON.parse(item.id)[0] === 'current')?.deletable, false);
    const newItem = list.items.find(item => JSON.parse(item.id)[1] === 'new')!;
    await app.surfaces.deleteItem(list.id, newItem.id); assert.equal(picker(app).id, list.id);
    let confirm = await openDelete(app, 'victim'); assert.equal(confirm.current, 'cancel');
    await app.surfaces.choose(confirm.id, 'cancel'); assert.ok(await f.manager.info('victim')); assert.equal(app.sessionId, 'current');
    confirm = await openDelete(app, 'victim'); const live = await f.manager.acquire('victim');
    await app.surfaces.choose(confirm.id, 'delete'); assert.match(picker(app).error, /占用/); await live.release();
    await Promise.all([app.surfaces.choose(confirm.id, 'delete'), app.surfaces.choose(confirm.id, 'delete')]);
    assert.equal(picker(app).title, '恢复会话'); assert.ok(!picker(app).items.some(item => JSON.parse(item.id)[0] === 'victim'));
    assert.equal((await readdir(join(f.manager.directory, 'trash'))).filter(file => !file.endsWith('.preparing')).length, 1);
    assert.equal(app.sessionId, 'current'); app.surfaces.cancel();
    await assert.rejects(app.submit('/resume victim'), /已删除/); assert.equal(app.sessionId, 'current');
  } finally {await app?.close(); await f.cleanup();}
});

class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
test('实际Ink：恢复列表Ctrl+X进入确认，默认取消；明确确认后刷新列表并保留原草稿', {timeout: 15000}, async () => {
  const f = await fixture(); let app: Application | undefined, instance: ReturnType<typeof renderTerminal> | undefined;
  const input = new Input(), output = new TerminalScreen(); output.columns = 100; output.rows = 24;
  try {
    await f.seed('victim');
    const config = await loadConfig(f.cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, f.cwd, f.cwd);
    app = await createApplication({cwd: f.cwd, sessionId: 'current', config, env: {}, authPath: join(f.cwd, 'auth.json'), resourceOptions: {home: f.cwd, boundary: f.cwd}});
    await act(async () => {instance = renderTerminal(<ApplicationStage application={app!}/>, {stdout: output, stdin: input, stderr: output,
      interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false, maxFps: 60});});
    assert.ok(instance);
    const press = async (text: string) => {await act(async () => {input.write(text); await delay(text === '\x1b' ? 45 : 15);}); await instance!.waitUntilRenderFlush();};
    await press('保留的草稿'); await act(async () => {await app!.submit('/resume');}); await instance!.waitUntilRenderFlush();
    assert.ok(output.lines.some(line => line.includes('Ctrl+X 删除会话')));
    await press('\x18'); await act(async () => {for (let index = 0; index < 100 && picker(app!).title !== '删除会话'; index++) await delay(10);}); assert.equal(picker(app).title, '删除会话'); assert.equal(picker(app).current, 'cancel');
    await press('\r'); await act(async () => {for (let index = 0; index < 100 && picker(app!).title !== '恢复会话'; index++) await delay(10);}); assert.equal(picker(app).title, '恢复会话'); assert.ok(await f.manager.info('victim'));
    await press('\x18'); await act(async () => {for (let index = 0; index < 100 && picker(app!).title !== '删除会话'; index++) await delay(10);}); await press('\x1b'); assert.ok(output.lines.some(line => line.includes('保留的草稿')));
    await act(async () => {await app!.submit('/resume');}); await press('\x18'); await act(async () => {for (let index = 0; index < 100 && picker(app!).status !== 'ready'; index++) await delay(10);}); await press('\x1b[B'); await press('\r');
    for (let index = 0; index < 100 && picker(app).title !== '恢复会话'; index++) await act(async () => {await delay(10);});
    assert.equal(picker(app).title, '恢复会话'); assert.ok(!picker(app).items.some(item => JSON.parse(item.id)[0] === 'victim'));
    await press('\x1b'); assert.ok(output.lines.some(line => line.includes('保留的草稿')));
    assert.equal(app.sessionId, 'current');
  } finally {
    await act(async () => {await app?.close();}); if (instance) {await act(async () => {instance!.unmount();}); await instance.waitUntilExit();}
    input.destroy(); output.destroy(); await f.cleanup();
  }
});
