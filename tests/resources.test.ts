import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Resources} from '../src/resources/manager.js';
import {agentRequestBase} from '../src/kernel/agent.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {ProjectExtensions} from '../src/extensions/runtime.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';
import {commandSuggestions} from '../src/tui/completion.js';
import {waitForSnapshot} from './runtime-fixture.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logox-resources-'));
  const home = join(root, 'home'), project = join(root, 'project'), cwd = join(project, 'child');
  await mkdir(cwd, {recursive: true}); await mkdir(home);
  const put = async (path: string, content: string | Buffer) => {await mkdir(join(path, '..'), {recursive: true}); await writeFile(path, content);};
  return {root, home, project, cwd, put, cleanup: () => rm(root, {recursive: true, force: true})};
}
test('用户与祖先规范有序且按候选优先级加载，真实路径去重', async () => {
  const f = await fixture();
  try {
    await f.put(join(f.home, '.logox', 'AGENTS.md'), '用户规范');
    await f.put(join(f.project, '.logox', 'LOGOX.md'), '项目规范');
    await f.put(join(f.project, 'AGENTS.md'), '不选这个');
    await f.put(join(f.cwd, 'CLAUDE.md'), '子目录规范');
    const resources = new Resources(f.cwd, {home: f.home, boundary: f.root});
    const snapshot = await resources.reload();
    assert.deepEqual(snapshot.guidelines.map(item => item.text), ['用户规范', '项目规范', '子目录规范']);
    const request = await agentRequestBase(f.cwd, 'logox', [], resources);
    assert.ok(request.system.includes('Logox'));
    assert.ok(request.system.indexOf('用户规范') < request.system.indexOf('项目规范'));
    assert.ok(request.system.indexOf('项目规范') < request.system.indexOf('子目录规范'));
    await rm(join(f.cwd, 'CLAUDE.md'));
    await symlink(join(f.project, '.logox'), join(f.cwd, '.logox'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await resources.reload()).guidelines.filter(item => item.text === '项目规范').length, 1);
    assert.equal(Reflect.set(snapshot.guidelines, '0', {}), false);
  } finally {await f.cleanup();}
});
test('规范损坏、超大整份跳过；规范总量与 legacy 路径有界', async () => {
  const f = await fixture();
  try {
    const path = join(f.home, '.logox', 'AGENTS.md');
    const resources = new Resources(f.cwd, {home: f.home, boundary: f.root});
    for (const content of [Buffer.from([0xff]), Buffer.alloc(65537, 65)]) {
      await f.put(path, content);
      const snapshot = await resources.reload();
      assert.equal(snapshot.guidelines.length, 0);
      assert.equal(snapshot.issues[0]?.kind, 'guidelines');
    }
    await rm(path);
    for (const directory of [f.root, f.project, f.cwd]) await f.put(join(directory, 'AGENTS.md'), 'A'.repeat(65536));
    const state = await resources.reload(); assert.equal(state.guidelines.length, 2);
    assert.ok(state.issues.some(item => item.reason.includes('128 KiB')));
    const forbidden = join(f.root, 'legacy'); await f.put(join(forbidden, 'AGENTS.md'), '禁止标记');
    const legacy = new Resources(forbidden, {home: f.home, boundary: f.root});
    assert.ok(!(await legacy.reload()).guidelines.some(item => item.text === '禁止标记'));
  } finally {await f.cleanup();}
});
test('技能仅披露元数据、模板近者优先且占位符单次展开，内置名称保留', async () => {
  const f = await fixture();
  try {
    await f.put(join(f.home, '.logox', 'commands', 'review.md'), '全局 {{args}}');
    await f.put(join(f.cwd, '.logox', 'commands', 'review.md'), '---\ndescription: 检查代码\n---\n项目 {{ args }} / $ARGUMENTS / $args');
    await f.put(join(f.cwd, '.logox', 'commands', 'help.md'), '劫持');
    await f.put(join(f.cwd, '.logox', 'skills', 'audit', 'SKILL.md'), '---\nname: audit\ndescription: 审查\n---\n技能正文秘密标记');
    const resources = new Resources(f.cwd, {home: f.home, boundary: f.root});
    const state = await resources.reload();
    assert.equal(resources.expand('review', '$& {{args}}'), '项目 $& {{args}} / $& {{args}} / $& {{args}}');
    assert.equal(resources.expand('help', ''), undefined);
    assert.throws(() => resources.expand('review', 'x'.repeat(16385)), /16 KiB/);
    assert.ok(state.issues.some(item => item.reason.includes('内置')));
    const base = await agentRequestBase(f.cwd, 'logox', [], resources);
    assert.ok(base.system.includes('audit')); assert.ok(!base.system.includes('秘密标记'));
    assert.ok(!base.tools.some(item => item.name === 'audit'));
    const suggestions = commandSuggestions({text: '/rev', cursor: 4}, {providers: [], loginProviders: [], models: [], customCommands: state.commands});
    assert.equal(suggestions[0]?.label, '/review'); assert.equal(suggestions[0]?.execute, false);
  } finally {await f.cleanup();}
});
test('正式任务、compact 共用资源；reload 更新提示与命令但保留历史及构造配置', async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {requests.push(request); return {message: {role: 'assistant', text: '完成'}, stop: 'complete', usage: {input: 10, output: 2}};}};
  try {
    await f.put(join(f.cwd, 'AGENTS.md'), '规则第一版');
    await f.put(join(f.cwd, '.logox', 'commands', 'review.md'), '审查 {{args}}');
    const config = await loadConfig(f.cwd, {provider: {model: 'test', context_window: 131072}}, {}, f.home, f.root);
    const app = await createApplication({cwd: f.cwd, config, provider, resourceOptions: {home: f.home, boundary: f.root}, authPath: join(f.root, 'auth.json')});
    try {
      await app.submit('/review 当前变更'); await waitForSnapshot(app.store, state => state.activities.some(item => item.status === 'completed'));
      while (app.ensemble.isBusy()) await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(requests[0]?.system.includes('规则第一版'));
      assert.equal(requests[0]?.messages.at(-1)?.text, '审查 当前变更');
      const before = await app.journal.load(app.sessionId, 'logox');
      await f.put(join(f.cwd, 'AGENTS.md'), '规则第二版');
      await f.put(join(f.cwd, '.logox', 'config.toml'), '[broken');
      await app.submit('/reload');
      assert.deepEqual(await app.journal.load(app.sessionId, 'logox'), before);
      assert.equal(app.contexts.status({sessionId: app.sessionId, ownerId: 'logox'}), undefined);
      assert.ok(app.store.getSnapshot().messages.some(item => item.text.includes('配置：校验失败')));
      const base = await agentRequestBase(f.cwd, 'logox', [], app.resources);
      assert.ok(base.system.includes('规则第二版')); assert.ok(!base.system.includes('规则第一版'));
      await app.submit('继续'); await waitForSnapshot(app.store, state => state.activities.filter(item => item.status === 'completed').length === 2);
      while (app.ensemble.isBusy()) await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(requests[1]?.system.includes('规则第二版'));
      await app.submit('/compact');
      assert.ok(app.store.getSnapshot().activities.some(item => (item.title === '扬弃' || item.title === 'Compact') && item.status === 'completed'));
      await app.submit('/commands'); assert.ok(app.surfaces.getSnapshot());
    } finally {await app.close();}
  } finally {await f.cleanup();}
});
test('处理中拒绝 reload；项目扩展由外层拥有，可跨会话重用', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const provider: Provider = {async respond() {await new Promise<void>(resolve => {release = resolve;}); return {message: {role: 'assistant', text: '完成'}, stop: 'complete'};}};
    const config = await loadConfig(f.cwd, {provider: {model: 'test', context_window: 131072}}, {}, f.home, f.root);
    const extensions = new ProjectExtensions(f.cwd, config, {home: f.home, boundary: f.root}); await extensions.initialize();
    const app = await createApplication({cwd: f.cwd, config, provider, extensions, authPath: join(f.root, 'auth.json')});
    const handle = app.ensemble.dispatch('logox', '测试');
    await assert.rejects(app.submit('/reload'), /任务处理中/);
    while (!release) await new Promise<void>(resolve => setImmediate(resolve));
    release(); await handle.done; await app.close();
    assert.equal(app.extensions, extensions);
    const second = await createApplication({cwd: f.cwd, config, extensions, authPath: join(f.root, 'auth.json')});
    assert.equal(second.resources, app.resources); await second.close(); await extensions.close();
    assert.ok(await readFile(join(f.cwd, '.logox', 'state', 'last-session'), 'utf8'));
  } finally {await f.cleanup();}
});
