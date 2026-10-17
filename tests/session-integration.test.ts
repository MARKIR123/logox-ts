import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {UsageLedger} from '../src/context/usage.js';
import {acquireFileLock} from '../src/store/file-lock.js';
import {waitForSnapshot} from './runtime-fixture.js';
import type {Provider, ModelRequest} from '../src/runtime/messages.js';

type Application = Awaited<ReturnType<typeof createApplication>>;
async function fixture(provider?: Provider) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-session-integration-')));
  await mkdir(join(cwd, '.logox'), {recursive: true});
  await writeFile(join(cwd, 'AGENTS.md'), '规则第一版'); await writeFile(join(cwd, 'sample.txt'), '合成内容');
  const log = join(cwd, 'mcp.jsonl'), requests: ModelRequest[] = [];
  const config = await loadConfig(cwd, {provider: {name: 'local', model: 'first'}, providers: {local: {base_url: 'http://127.0.0.1:7777/v1'}},
    models: {'local/first': {context_window: 131072, thinking_protocol: 'deepseek'}, 'local/second': {context_window: 131072, thinking_protocol: 'deepseek'}},
    mcp: {servers: {fixture: {command: process.execPath, args: [resolve('tests/fixtures/mcp-server.mjs'), log], timeout: 2}}},
    hooks: {enabled: true, entries: [{event: 'session_start', command: process.execPath, args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d))']},
      {event: 'post_tool_use', command: process.execPath, args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d))']}]},
  }, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 'first', config, env: {}, authPath: join(cwd, 'auth.json'),
    resourceOptions: {home: cwd, boundary: cwd}, approveExtension: async () => true,
    provider: provider ?? {async respond(request) {
      requests.push(request);
      const prompt = [...request.messages].reverse().find(message => message.role === 'user')?.text;
      if (request.messages.at(-1)?.role !== 'tool' && (prompt === 'mcp任务' || prompt === '读取任务')) return {stop: 'tools', usage: {input: 13, output: 4},
        message: {role: 'assistant', text: '', toolCalls: [{id: 'call-' + requests.length, name: prompt === 'mcp任务' ? 'mcp' : 'read',
          arguments: JSON.stringify(prompt === 'mcp任务' ? {server: 'fixture', action: 'call', tool: 'echo', arguments: {value: 2}} : {path: 'sample.txt'})}]}};
      return {message: {role: 'assistant', text: '完成'}, stop: 'complete', usage: {input: 20, output: 5}};
    }},
  });
  return {app, cwd, requests, log, cleanup: async () => {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}
async function submit(app: Application, text: string) {
  const previous = app.store.getSnapshot().activities.length;
  await app.submit(text); await waitForSnapshot(app.store, state => state.activities.length > previous && state.activities.at(-1)?.status === 'completed');
  while (app.ensemble.isBusy()) await new Promise<void>(resolve => setImmediate(resolve));
}
async function page(app: Application, command: string) {await app.submit(command); const state = app.surfaces.getSnapshot(); assert.ok(state?.kind === 'page'); const text = state.tabs.find(tab => tab.id === command.slice(1))!.lines.join('\n'); app.surfaces.cancel(); return text;}
async function rewind(app: Application) {await app.submit('/rewind'); const picker = app.surfaces.getSnapshot(); assert.ok(picker?.kind === 'picker'); await app.surfaces.choose(picker.id, picker.items[0]!.id);}

test('实际应用切换保持模型档位；每会话/角色用量独立恢复，同ID重建先flush，回退不重复或删消费', async () => {
  const f = await fixture();
  try {
    await f.app.submit('/model second'); await f.app.submit('/effort high');
    await submit(f.app, '第一轮'); await submit(f.app, '@techne 第二角色');
    const identities = (ownerId: string) => ({sessionId: f.app.sessionId, ownerId});
    const first = f.app.contexts.meter(identities('logox')).usageRecords(), actor = f.app.contexts.meter(identities('techne')).usageRecords();
    assert.equal(first.length, 1); assert.equal(actor.length, 1);
    // 直接充入尚在共享队列中的合法消费，马上同 ID 重建，覆盖读写交接时序。
    f.app.contexts.meter(identities('logox')).chargeUsage({input: 7, output: 1}, 'local/second', 'summary');
    const expected = f.app.contexts.meter(identities('logox')).usageRecords();
    await f.app.submit('/resume first');
    assert.deepEqual(f.app.contexts.meter(identities('logox')).usageRecords(), expected);
    assert.deepEqual(f.app.contexts.meter(identities('techne')).usageRecords(), actor);
    await f.app.submit('/new');
    assert.deepEqual(f.app.contexts.meter(identities('logox')).usageRecords(), []);
    const selected = await page(f.app, '/config'); assert.match(selected, /(?:模型：|Model: )second/); assert.match(selected, /(?:思考档位：|Thinking effort: )high/);
    await f.app.submit('/resume first'); await rewind(f.app);
    assert.deepEqual(f.app.contexts.meter(identities('logox')).usageRecords(), expected);
    assert.deepEqual(f.app.contexts.meter(identities('techne')).usageRecords(), actor);
    const ledger = new UsageLedger(join(f.cwd, '.logox', 'state', 'usage'), text => {throw new Error(text);});
    assert.deepEqual(await ledger.read('first', 'logox'), expected);
    assert.equal(f.requests.length, 2, '切换和回退不请求模型、不重算历史');
  } finally {await f.cleanup();}
});

test('候选失败保留规则；成功切换和回退清会话许可，项目规则/模式保留；权限或模型保存期间拒绝切换', async () => {
  const f = await fixture();
  try {
    await f.app.submit('/permissions add project deny write protected.txt'); await f.app.submit('/permissions mode creative');
    await f.app.submit('/permissions add session allow write *.txt');
    await submit(f.app, '权限会话正式任务');
    const rules = f.app.permissions.snapshot(), oldStore = f.app.store;
    await assert.rejects(f.app.submit('/resume missing'), /没有此项目/);
    assert.equal(f.app.store, oldStore); assert.deepEqual(f.app.permissions.snapshot(), rules);
    await f.app.submit('/new'); assert.equal(f.app.permissions.snapshot().length, 1); assert.equal(f.app.permissions.mode, 'creative');
    await f.app.submit('/resume first'); assert.equal(f.app.permissions.snapshot().length, 1);
    await f.app.submit('/permissions add session allow read sample.txt'); await submit(f.app, '空轮'); await rewind(f.app);
    assert.equal(f.app.permissions.snapshot().length, 1);
    for (const [path, command] of [[join(f.cwd, '.logox', 'permissions.json'), '/permissions add project deny edit *.txt'],
      [join(f.cwd, '.logox', 'state', 'model-preferences.json'), '/model second']] as const) {
      const release = await acquireFileLock(path), saving = f.app.submit(command);
      try {await assert.rejects(f.app.submit('/new'), /保存|saving/i); await assert.rejects(f.app.submit('/resume first'), /保存|saving/i);}
      finally {await release(); await saving;}
    }
  } finally {await f.cleanup();}
});

test('MCP长驻进程跨new/resume/rewind复用，Tools观察不重复；reload后的Agent和compact使用同一资源，最终关闭回收', async () => {
  const f = await fixture(); const {app} = f;
  try {
    const tools = app.tools, extensions = app.extensions, resources = app.resources;
    await submit(app, 'mcp任务'); await submit(app, '读取任务');
    await app.submit('/new'); await submit(app, 'mcp任务'); await submit(app, '读取任务');
    await app.submit('/resume first'); await rewind(app); await submit(app, '读取任务');
    assert.equal(app.tools, tools); assert.equal(app.extensions, extensions); assert.equal(app.resources, resources);
    const events = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {pid?: number});
    assert.equal(events.filter(event => event.pid).length, 1);
    await app.extensions.hooks.drain();
    const observed = app.extensions.hooks.history().filter(item => item.event === 'post_tool_use').map(item => JSON.parse(item.output) as {tool: string});
    assert.equal(observed.filter(item => item.tool === 'read').length, 3);
    assert.equal(observed.filter(item => item.tool === 'mcp').length, 2);
    assert.equal(app.extensions.hooks.history().filter(item => item.event === 'session_start').length, 4);
    await writeFile(join(f.cwd, 'AGENTS.md'), '规则第二版'); await app.submit('/reload'); await submit(app, '新规则任务');
    assert.match(f.requests.at(-1)!.system, /规则第二版/); assert.ok(!f.requests.at(-1)!.system.includes('规则第一版'));
    const prepare = app.contexts.prepare.bind(app.contexts); let compactSystem = '';
    app.contexts.prepare = async (identity, base, signal, force) => {compactSystem = base.system; return prepare(identity, base, signal, force);};
    await app.submit('/compact');
    const agentSystem = f.requests.at(-1)!.system;
    const environmentStart = agentSystem.indexOf('当前执行环境（以本次请求为准）：');
    const contractStart = agentSystem.indexOf('角色摘要保留重点：', environmentStart);
    assert.ok(environmentStart >= 0 && contractStart > environmentStart);
    assert.equal(compactSystem, agentSystem.slice(0, environmentStart) + agentSystem.slice(contractStart),
      '资源规范和摘要契约一致；请求时的执行环境由普通任务单独补充');
    assert.match(compactSystem, /规则第二版/); assert.ok(!compactSystem.includes('规则第一版'));
    // 资源重载尚未完成时，禁止构造带旧前缀的候选会话。
    const reload = resources.reload.bind(resources); let finish: (() => void) | undefined, enter!: () => void;
    const started = new Promise<void>(resolve => {enter = resolve;});
    resources.reload = async () => {
      const blocked = new Promise<void>(resolve => {finish = resolve;}); enter(); await blocked; return reload();
    };
    const loading = app.submit('/reload');
    try {
      await Promise.race([started, loading.then(() => {throw new Error('没有进入受控资源重载');})]);
      await assert.rejects(app.submit('/new'), /重载|reloading/i);
    } finally {finish?.(); await loading;}
    await app.close(); assert.equal(extensions.mcp.status()[0]?.state, 'closed');
    assert.throws(() => process.kill(events.find(event => event.pid)!.pid!, 0));
  } finally {await f.cleanup();}
});
