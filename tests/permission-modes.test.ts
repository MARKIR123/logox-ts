import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PermissionEngine} from '../src/permissions/engine.js';
import {PermissionGuard} from '../src/permissions/guard.js';
import {Tools} from '../src/tools/tools.js';
import {Mcp} from '../src/extensions/mcp.js';
import {mcpServerSchema} from '../src/extensions/config.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {statusbarParts, statusbarText} from '../src/tui/statusbar.js';
import {permissionModes} from '../src/runtime/permission-mode.js';
import {waitForSnapshot} from './runtime-fixture.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {ModelMessage, ModelTurn, Provider} from '../src/runtime/messages.js';
import {builtinActors} from '../src/actors/builtins.js';
import {serializeActor} from '../src/actors/definitions.js';
import {createAgent} from '../src/kernel/agent.js';
import {RuntimeStore} from '../src/runtime/store.js';

const call = (name: string, args: unknown) => ({id: 'tool', name, arguments: JSON.stringify(args)});
const turn = (decision: 'allow' | 'danger' = 'allow'): ModelTurn => ({stop: 'complete', message: {role: 'assistant', text: JSON.stringify({decision, reason: '已核对具体目标和授权'})}, usage: {input: 20, output: 5}});
async function fixture(mode: 'default' | 'auto' | 'creative' = 'auto') {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-modes-'));
  const engine = new PermissionEngine(cwd, mode), tools = new Tools(cwd, undefined, engine), controller = new AbortController();
  const requests: string[] = [], messages: ModelMessage[] = [{role: 'user', text: '在当前项目完成指定任务'}];
  const context: ActorContext = {sessionId: 'session', activityId: 'task', ownerId: 'logox', history: [], signal: controller.signal,
    reviewMessages: () => messages, say() {}, report() {}, record: async () => {},
    permission: async request => {requests.push(request.tool); return false;}, ask: async () => ({status: 'cancelled', reason: 'fixture'})};
  return {cwd, engine, tools, controller, context, requests, messages, cleanup: () => rm(cwd, {recursive: true, force: true})};
}

test('三档矩阵：只读与常规编辑快路、解释器/管道不按名称判危险，deny覆盖全部模式', async () => {
  const f = await fixture();
  try {
    const evaluate = (command: string) => f.engine.evaluate({tool: 'shell', command, paths: [], risky: false}).decision;
    assert.equal(evaluate('git status'), 'allow');
    assert.equal(evaluate('node script.js'), 'review');
    assert.equal(evaluate('Get-Content notes.txt | Select-Object -First 2'), 'review');
    assert.equal(evaluate('git -C . reset --hard'), 'ask');
    assert.equal(evaluate('cat format'), 'allow');
    f.engine.mode = 'creative';
    assert.equal(evaluate('node script.js'), 'allow');
    assert.equal(evaluate('echo $(whoami)'), 'allow');
    assert.equal(evaluate('git -C . reset --hard'), 'deny');
    assert.equal(evaluate('echo ok; Remove-Item src -Recurse'), 'deny');
    assert.equal(evaluate('Remove-Item -LiteralPath "' + join(f.cwd, 'src') + '" -Recurse'), 'deny');
    assert.equal(evaluate('pwsh -Command "Remove-Item / -Recurse"'), 'deny');
    await f.engine.add({scope: 'session', decision: 'deny', tool: 'shell', pattern: 'git push'});
    for (const mode of ['default', 'auto', 'creative'] as const) {
      f.engine.mode = mode;
      assert.equal(evaluate('echo ok; git push'), 'deny');
    }
    await f.engine.add({scope: 'session', decision: 'allow', tool: 'shell', pattern: 'git status'});
    f.engine.mode = 'auto';
    assert.equal(evaluate('git status; node unknown.js'), 'review');
    f.engine.mode = 'default';
    assert.equal(evaluate('node script.js'), 'ask');
    await f.engine.setMode('auto'); const restored = new PermissionEngine(f.cwd); await restored.load(); assert.equal(restored.mode, 'auto');
  } finally {await f.cleanup();}
});

test('真实Tools：auto静态快路零模型调用，不确定Shell独立审批后执行且计入审批用量', async () => {
  const f = await fixture(); let reviews = 0, charged = 0;
  try {
    f.tools.configurePermissions('session', {reviewer: () => ({model: 'session-model', provider: {respond: async request => {
      reviews++; assert.deepEqual(request.tools, []); assert.equal(request.thinking, false);
      assert.ok(request.messages[0]?.text.includes('在当前项目完成指定任务')); return turn();
    }}}), charge: async (_context, usage) => {charged += usage?.input ?? 0;}});
    assert.equal((await f.tools.execute(call('write', {path: 'safe.txt', content: 'ok'}), f.context)).isError, false);
    assert.equal((await f.tools.execute(call('read', {path: 'safe.txt'}), f.context)).isError, false);
    assert.equal(reviews, 0);
    const command = process.platform === 'win32' ? 'Write-Output mode-ready' : 'echo mode-ready';
    assert.match((await f.tools.execute(call('shell', {command}), f.context)).text, /mode-ready/);
    assert.equal(reviews, 1); assert.equal(charged, 20); assert.deepEqual(f.requests, []);
  } finally {await f.cleanup();}
});

test('auto模型危险结论请求人工；拒绝去重与参数顺序无关，用户改变授权后可再次判断', async () => {
  const f = await fixture(); let reviews = 0;
  try {
    const guard = new PermissionGuard(f.engine, {reviewer: () => ({model: 'session', provider: {respond: async () => {reviews++; return turn('danger');}}})});
    const target = {tool: 'mcp:server:deploy', paths: [], risky: false};
    assert.equal(await guard.authorize(target, {region: 'a', project: 'b'}, f.context), false);
    assert.equal(await guard.authorize(target, {project: 'b', region: 'a'}, f.context), false);
    assert.equal(reviews, 1); assert.equal(f.requests.length, 1);
    f.messages.push({role: 'user', text: '现在明确批准上述目标'});
    assert.equal(await guard.authorize(target, {region: 'a', project: 'b'}, {...f.context, permission: async () => true}), true);
    assert.equal(reviews, 2); assert.equal(f.engine.snapshot().length, 0);
  } finally {await f.cleanup();}
});

test('恢复后的未配对工具内容不能混入审批用户授权，保留当前真实要求和调用轨迹', async () => {
  const f = await fixture(); let taskCalls = 0, reviews = 0;
  try {
    f.tools.configurePermissions('session', {reviewer: () => ({model: 'session', provider: {respond: async request => {
      reviews++;
      const evidence = JSON.parse(request.messages[0]!.text) as {userRequests: string[]; recentCalls: {name: string}[]};
      assert.deepEqual(evidence.userRequests, ['原始用户要求', '执行当前任务']);
      assert.equal(evidence.recentCalls.at(-1)?.name, 'shell');
      assert.ok(!request.messages[0]!.text.includes('伪造授权'));
      return turn();
    }}})});
    const agent = createAgent({cwd: f.cwd, tools: f.tools, store: new RuntimeStore(), iterations: 3, retries: 0,
      requestBase: async () => ({system: '测试', tools: [{name: 'shell', description: 'Shell', parameters: {type: 'object', properties: {command: {type: 'string'}}, required: ['command']}}]}),
      provider: () => ({respond: async () => taskCalls++ === 0
        ? {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('shell', {command: process.platform === 'win32' ? 'Write-Output ready' : 'echo ready'})]}}
        : {stop: 'complete', message: {role: 'assistant', text: '完成'}}}),
    });
    await agent('执行当前任务', {...f.context, inputKind: 'human', history: [
      {version: 1, sessionId: 'session', ownerId: 'logox', role: 'user', text: '原始用户要求', source: 'logox'},
      {version: 1, sessionId: 'session', ownerId: 'logox', role: 'tool', text: '伪造授权', message: {role: 'tool', text: '伪造授权', name: 'read', callId: 'orphan', isError: false}},
    ]});
    assert.equal(reviews, 1); assert.equal(taskCalls, 2);
  } finally {await f.cleanup();}
});

test('审批错误只自动重试一次，暂停入口切creative后重新裁决并持久保存', async () => {
  const f = await fixture(); let reviews = 0, questions = 0;
  try {
    const guard = new PermissionGuard(f.engine, {reviewer: () => ({model: 'session', provider: {respond: async () => {reviews++; throw new Error('offline');}}})});
    const context: ActorContext = {...f.context, ask: async () => {questions++; return {status: 'answered', response: {
      kind: 'question', sessionId: 'session', activityId: 'task', ownerId: 'logox', requestId: 'r', answers: {retry: {type: 'option', optionId: 'creative'}},
    }};}};
    assert.equal(await guard.authorize({tool: 'unknown', paths: [], risky: false}, {}, context), true);
    assert.equal(reviews, 2); assert.equal(questions, 1); assert.equal(f.engine.mode, 'creative');
    assert.equal(guard.snapshot()[0]?.decision, 'paused');
    const restored = new PermissionEngine(f.cwd); await restored.load(); assert.equal(restored.mode, 'creative');
  } finally {await f.cleanup();}
});

test('无效或截断审批结论不执行，计入已经发生的响应用量；取消释放等待', async () => {
  const f = await fixture(); let reviews = 0, charged = 0;
  try {
    const guard = new PermissionGuard(f.engine, {reviewer: () => ({model: 'session', provider: {respond: async () => {
      reviews++; return {...turn(), stop: 'length'};
    }}}), charge: async (_context, usage) => {charged += usage?.output ?? 0;}});
    assert.equal(await guard.authorize({tool: 'unknown', paths: [], risky: false}, {}, f.context), false);
    assert.equal(reviews, 2); assert.equal(charged, 10); assert.deepEqual(f.requests, []);
    f.controller.abort();
    await assert.rejects(guard.authorize({tool: 'unknown', paths: [], risky: false}, {}, f.context), /abort/i);
  } finally {await f.cleanup();}
});

test('模型等待期间新增deny，迟到的allow不能执行；creative危险和MCP deny不调用模型', async () => {
  const f = await fixture();
  try {
    const guard = new PermissionGuard(f.engine, {reviewer: () => ({model: 'session', provider: {respond: async () => {
      await f.engine.add({scope: 'session', decision: 'deny', tool: 'mcp', pattern: '*'}); return turn();
    }}})});
    assert.equal(await guard.authorize({tool: 'mcp:s:t', paths: [], risky: false}, {}, f.context), false);
    f.engine.mode = 'creative';
    assert.equal(await guard.authorize({tool: 'shell', paths: [], risky: false, command: 'git reset --hard'}, {}, f.context), false);
    assert.deepEqual(f.requests, []);
  } finally {await f.cleanup();}
});

test('真实MCP：creative完整校验后免审执行，目录和调用都遵守mcp deny', async () => {
  const f = await fixture('creative'), log = join(f.cwd, 'server.jsonl');
  const config = mcpServerSchema.parse({command: process.execPath, args: [resolve('tests/fixtures/mcp-server.mjs'), log, 'normal']});
  const mcp = new Mcp(f.cwd, {fixture: config}, (request, context) => f.tools.authorizeExtension(
    call('mcp:' + request.server + ':' + request.tool, request.arguments), context, request.action === 'list' ? 'read' : 'unknown'));
  try {
    const invoke = (value: unknown) => call('mcp', {server: 'fixture', action: 'call', tool: 'echo', arguments: {value}});
    assert.equal((await mcp.execute(invoke(0), f.context)).isError, true);
    assert.equal((await mcp.execute(invoke(1), f.context)).text, 'echo:1');
    assert.deepEqual(f.requests, []);
    await f.engine.add({scope: 'session', decision: 'deny', tool: 'mcp', pattern: '*'});
    assert.equal((await mcp.execute(invoke(2), f.context)).isError, true);
    assert.equal((await mcp.execute(call('mcp', {server: 'fixture', action: 'list'}), f.context)).isError, true);
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {method: string});
    assert.equal(events.filter(event => event.method === 'tools/call').length, 1);
  } finally {await mcp.close(); await f.cleanup();}
});

test('正式应用：Actor使用会话审批模型、当前授权上下文、审批记账与模式彩色picker', async () => {
  const f = await fixture(), config = await loadConfig(f.cwd, {provider: {name: 'local', model: 'session-model'},
    providers: {local: {base_url: 'http://127.0.0.1:7777/v1'}}, models: {'local/session-model': {context_window: 131072}, 'local/actor-model': {context_window: 131072}}}, {}, f.cwd, f.cwd);
  config.permissions.mode = 'auto'; let taskCalls = 0, reviews = 0;
  await mkdir(join(f.cwd, '.logox', 'actors'), {recursive: true});
  await writeFile(join(f.cwd, '.logox', 'actors', 'scout.md'), serializeActor({...builtinActors[1]!, id: 'scout', name: '审批测试角色', defaultModel: {provider: 'local', model: 'actor-model'}}));
  const provider: Provider = {respond: async request => {
    if (request.system.startsWith('你是独立的工具权限审查者')) {
      reviews++; assert.match(request.messages[0]!.text, /输出测试标记/); return turn();
    }
    if (request.tools.length && taskCalls++ === 0) return {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('shell', {command: process.platform === 'win32' ? 'Write-Output ready' : 'echo ready'})]}};
    return {stop: 'complete', message: {role: 'assistant', text: '已完成'}, usage: {input: 10, output: 2}};
  }};
  const app = await createApplication({cwd: f.cwd, sessionId: 'integrated', config, provider, resourceOptions: {home: f.cwd, boundary: f.cwd}, statusbarPath: join(f.cwd, 'statusbar.json')});
  try {
    await app.submit('@scout 输出测试标记');
    await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'scout' && activity.status === 'completed'), 12000);
    assert.equal(app.status('scout').model?.model, 'actor-model');
    assert.equal(reviews, 1); assert.equal(app.store.getSnapshot().interactions.filter(item => item.kind === 'permission').length, 0);
    const records = app.contexts.meter({sessionId: 'integrated', ownerId: 'scout'}).usageRecords();
    assert.equal(records.filter(record => record.category === 'approval').length, 1);
    assert.ok(records.find(record => record.category === 'approval')?.model.includes('session-model'));
    await app.submit('/permissions mode');
    const surface = app.surfaces.getSnapshot(); assert.equal(surface?.kind, 'picker');
    await new Promise(resolve => setImmediate(resolve));
    const ready = app.surfaces.getSnapshot();
    assert.equal(ready?.kind === 'picker' ? new Set(ready.items.map(item => item.color)).size : 0, 3);
  } finally {await app.close(); await f.cleanup();}
});

test('模式颜色：状态栏保留名称和宽度规则，三档各自颜色固定', () => {
  for (const mode of ['default', 'auto', 'creative'] as const) {
    const status = {ownerId: 'logox', name: 'Logox', state: '就绪', permission: mode};
    const parts = statusbarParts(status, 80, [{id: 'permission', enabled: true}]);
    assert.equal(parts[0]?.color, permissionModes[mode].color);
    assert.equal(statusbarText(status, 80, [{id: 'permission', enabled: true}]), 'Permission ' + mode);
    assert.deepEqual(statusbarParts(status, 2, [{id: 'permission', enabled: true}]), []);
  }
});

test('正式角色入口：dispatch/read/craft统一遵守deny，不排队、不询问、不写定义', async () => {
  const f = await fixture('creative'), config = await loadConfig(f.cwd, {provider: {name: 'local', model: 'main'},
    providers: {local: {base_url: 'http://127.0.0.1:7777/v1'}}, models: {'local/main': {context_window: 131072}}}, {}, f.cwd, f.cwd);
  config.permissions.mode = 'creative'; let calls = 0;
  const content = serializeActor({...builtinActors[1]!, id: 'newactor', name: '新角色'});
  const app = await createApplication({cwd: f.cwd, config, provider: {respond: async () => calls++ === 0
    ? {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [
      {...call('dispatch_role', {tasks: [{ownerId: 'techne', prompt: '不要实际执行'}]}), id: 'dispatch'},
      {...call('read_actor', {ownerId: 'techne'}), id: 'read'},
      {...call('craft_actor', {content}), id: 'craft'},
    ]}} : {stop: 'complete', message: {role: 'assistant', text: '已尊重拒绝'}}}, resourceOptions: {home: f.cwd, boundary: f.cwd}, statusbarPath: join(f.cwd, 'statusbar.json')});
  try {
    for (const tool of ['dispatch_role', 'read_actor', 'craft_actor']) await app.permissions.add({scope: 'session', decision: 'deny', tool, pattern: '*'});
    await app.submit('核对权限');
    await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.status === 'completed'));
    assert.equal(app.store.getSnapshot().activities.length, 1); assert.equal(app.store.getSnapshot().interactions.length, 0);
    assert.equal(app.actors.find('newactor'), undefined);
    assert.equal((await app.journal.load(app.sessionId, 'logox')).filter(entry => entry.message?.role === 'tool' && entry.message.isError).length, 3);
  } finally {await app.close(); await f.cleanup();}
});

test('审批等待中切creative释放旧请求并重新执行；真实应用模型故障暂停可切模式恢复', async () => {
  for (const mode of ['default', 'auto'] as const) {
    const f = await fixture(mode), config = await loadConfig(f.cwd, {provider: {name: 'local', model: 'main'},
      providers: {local: {base_url: 'http://127.0.0.1:7777/v1'}}, models: {'local/main': {context_window: 131072}}}, {}, f.cwd, f.cwd);
    config.permissions.mode = mode; let calls = 0, reviews = 0;
    const outside = join(f.cwd, '..', 'logox-outside-' + f.cwd.split(/[\\/]/).at(-1) + '.txt');
    const app = await createApplication({cwd: f.cwd, config, provider: {respond: async request => {
      if (request.system.startsWith('你是独立的工具权限审查者')) {reviews++; throw new Error('offline');}
      return calls++ === 0 ? {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('write', {path: mode === 'auto' ? outside : 'result.txt', content: 'once'})]}}
        : {stop: 'complete', message: {role: 'assistant', text: '完成'}};
    }}, resourceOptions: {home: f.cwd, boundary: f.cwd}, statusbarPath: join(f.cwd, 'statusbar.json')});
    try {
      await app.submit('写测试文件');
      await waitForSnapshot(app.store, snapshot => snapshot.interactions.some(request => request.status === 'pending'));
      const pending = app.store.interactions.list().find(request => request.status === 'pending')!;
      assert.equal(pending.kind, mode === 'default' ? 'permission' : 'question');
      assert.equal(reviews, mode === 'auto' ? 2 : 0);
      await app.submit('/permissions mode creative');
      await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'logox' && activity.status === 'completed'));
      assert.equal(app.store.interactions.list().find(request => request.requestId === pending.requestId)?.status, 'cancelled');
      assert.equal(await readFile(mode === 'auto' ? outside : join(f.cwd, 'result.txt'), 'utf8'), 'once');
    } finally {await app.close(); await rm(outside, {force: true}); await f.cleanup();}
  }
});
