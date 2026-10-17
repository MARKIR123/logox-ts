import test from 'node:test';
import assert from 'node:assert/strict';
import {commandSuggestions, applyCommandSuggestion} from '../src/tui/completion.js';
import {commandCatalog} from '../src/commands.js';
import {graphemes, type Draft} from '../src/tui/editor.js';
const context = {providers: ['deepseek', 'antigravity'], loginProviders: ['deepseek'], models: ['模型🙂', 'fixture']};
const draft = (text: string): Draft => ({text, cursor: graphemes(text).length});

test('命令目录补全现有命令、参数及中文模型，保留光标后的原文', () => {
  assert.deepEqual(commandSuggestions(draft('/'), context).map(item => item.label), commandCatalog.map(item => '/' + item.name));
  const login = commandSuggestions(draft('/l'), context)[0]!;
  assert.deepEqual(applyCommandSuggestion(draft('/l'), login), draft('/login'));
  assert.equal(login.execute, true);
  const model = commandSuggestions(draft('/model'), context)[0]!;
  assert.equal(model.execute, true);
  assert.deepEqual(applyCommandSuggestion(draft('/model'), model), draft('/model '));
  assert.deepEqual(commandSuggestions(draft('/login '), context).map(item => item.label), ['deepseek']);
  assert.deepEqual(commandSuggestions(draft('/provider a'), context).map(item => item.label), ['antigravity']);
  assert.deepEqual(commandSuggestions(draft('/model 模'), context), []);
  assert.deepEqual(commandSuggestions(draft('/model '), context).map(item => item.label), ['logox', 'techne', 'kalon', 'aletheia']);
  const actorCompletion = commandSuggestions(draft('/model a'), context).find(item => item.label === 'aletheia')!;
  assert.equal(actorCompletion.label, 'aletheia');
  assert.equal(actorCompletion.execute, true);
  assert.deepEqual(applyCommandSuggestion(draft('/model a'), actorCompletion), draft('/model aletheia'));
  const middle = {text: '/proviDER antigravity', cursor: 4};
  const provider = commandSuggestions(middle, context).find(item => item.label === '/provider')!;
  assert.deepEqual(applyCommandSuggestion(middle, provider), {text: '/provider antigravity', cursor: 9});
  for (const text of ['你好 /lo', '/unknown', '/login\n', '/cast 工作', '/provider antigravity 模型']) {
    assert.deepEqual(commandSuggestions(draft(text), context), []);
  }
});

import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';

test('应用提供公开候选：模型查询缓存按提供商隔离，切换后立即更新', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({data: [{id: 'queried-one'}, {id: 'queried-two'}]}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const cwd = await mkdtemp(join(tmpdir(), 'logox-completion-'));
  const base_url = 'http://127.0.0.1:' + address.port + '/v1';
  const config = await loadConfig(cwd, {provider: {name: 'alpha'}, providers: {
    alpha: {kind: 'openai_compat', base_url, default_model: 'alpha-default'},
    beta: {kind: 'openai_compat', base_url, default_model: 'beta-default'},
  }}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, authPath: join(cwd, 'auth.json')});
  try {
    assert.ok(app.commandContext().providers.includes('alpha'));
    assert.ok(!app.commandContext().loginProviders.includes('alpha'), '无认证本地接口不加入登录菜单');
    assert.deepEqual(app.commandContext().models, ['alpha-default']);
    await app.submit('/models');
    assert.deepEqual(app.commandContext().models, ['alpha-default', 'queried-one', 'queried-two', 'alpha/queried-one', 'alpha/queried-two']);
    await app.submit('/provider beta');
    assert.deepEqual(app.commandContext().models, ['beta-default', 'alpha/queried-one', 'alpha/queried-two']);
    await app.submit('/provider alpha');
    assert.deepEqual(app.commandContext().models, ['alpha-default', 'queried-one', 'queried-two', 'alpha/queried-one', 'alpha/queried-two']);
    await app.submit('/help');
    const page = app.surfaces.getSnapshot();
    assert.ok(page?.kind === 'page');
    assert.ok(page.tabs.find(tab => tab.id === 'commands')!.lines.some(line => line.includes('/login [provider]') || line.includes('/login [提供商]')));
  } finally {
    await app.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, {recursive: true, force: true});
  }
});
