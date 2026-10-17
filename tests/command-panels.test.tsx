import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {TerminalScreen} from './terminal-screen.js';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal.js';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from '../src/tui/app.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {loadConfig} from '../src/config/config.js';
import {createApplication} from '../src/application.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
class TerminalOutput extends TerminalScreen {}
function frame(output: TerminalOutput): string {return output.lines.join('\n');}
async function press(input: TerminalInput, instance: ReturnType<typeof render>, value: string): Promise<void> {
  await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();
}
test('实际 Ink picker：搜索、跳过禁用、翻页、取消；页签保留舞台草稿、阅读位置与审批焦点', {timeout: 8000}, async () => {
  const input = new TerminalInput(), output = new TerminalOutput(), store = new RuntimeStore(), chosen: string[] = [], submissions: string[] = [];
  const surfaces = new CommandSurfaces(result => {if (result.message) chosen.push(result.message);});
  const ticket = store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'a', ownerId: 'techne', title: '写入', tool: 'write', arguments: {}, reason: '确认'});
  for (let i = 0; i < 40; i++) store.message('s', 'logox', 'assistant', '历史位置 ' + i);
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<App stage sessionId="s" store={store} surfaces={surfaces}
    onSubmit={async text => {submissions.push(text);}} onCancel={() => {}} onClose={async () => {surfaces.close(); store.interactions.close();}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const key = async (value: string) => press(input, instance, value);
  try {
    await key('保留我的草稿'); await key('\x1b[5~');
    const before = frame(output), history = before.match(/历史位置 \d+/g); assert.ok(history?.length);
    await act(async () => {await surfaces.openPicker({title: '选择角色模型', description: '说明', current: '0'}, async () => ({items: Array.from({length: 16}, (_, i) => ({id: String(i), label: i === 15 ? '中文🙂模型' : 'model-' + i, disabled: i === 1}))}), id => ({message: id}));});
    await instance.waitUntilRenderFlush(); assert.match(frame(output), /❯ model-0/);
    await key('\x1b[B'); assert.match(frame(output), /❯ model-2/);
    await key('\x1b[6~'); assert.match(frame(output), /❯ model-8/);
    await key('\x1b[4~'); assert.match(frame(output), /❯ 中文🙂模型/);
    await key('不存在'); assert.match(frame(output), /(?:没有匹配的选项|No matching options)/);
    await key('\r'); assert.deepEqual(chosen, []);
    await key('\x15'); await key('中文🙂'); await key('\r'); assert.deepEqual(chosen, ['15']);
    assert.match(frame(output), /保留我的草稿/);
    assert.deepEqual(frame(output).match(/历史位置 \d+/g), history, '关闭 picker 恢复阅读位置');
    await key('\t');
    await act(async () => surfaces.openPage('LOGOX', [{id: 'status', title: '状态', lines: ['第一页面']}, {id: 'config', title: '配置', lines: Array.from({length: 40}, (_, i) => '配置行 ' + i)}], 'status'));
    await instance.waitUntilRenderFlush(); assert.match(frame(output), /第一页面/); assert.doesNotMatch(frame(output), /保留我的草稿/);
    await key('\x1b[C'); assert.match(frame(output), /配置行 0/);
    await key('\x1b[6~'); assert.doesNotMatch(frame(output), /配置行 0/);
    output.columns = 32; output.rows = 10;
    await act(async () => {output.emit('resize');}); await instance.waitUntilRenderFlush();
    assert.match(frame(output), /❯ 配置/);
    await key('\t'); assert.match(frame(output), /第一页面/);
    await key('\x03'); assert.ok(surfaces.getSnapshot(), 'Ctrl+C 不关闭命令界面');
    await key('\x1b'); assert.equal(surfaces.getSnapshot(), null); assert.equal(store.interactions.list()[0]!.status, 'pending');
    await key('\r'); assert.equal((await ticket.result).status, 'answered', '页签退出仍聚焦原审批');
    await key('\r'); assert.deepEqual(submissions, ['保留我的草稿']);
    let signal!: AbortSignal;
    let loading!: Promise<void>;
    await act(async () => {loading = surfaces.openPicker({title: '等待目录', description: '', current: ''}, async querySignal => {
      signal = querySignal; await new Promise<void>((_resolve, reject) => querySignal.addEventListener('abort', () => reject(querySignal.reason), {once: true}));
      return {items: []};
    }, () => ({}));});
    await key('\x04'); await loading; assert.equal(signal.aborted, true); assert.equal(surfaces.getSnapshot(), null);
    await instance.waitUntilExit();
  } finally {surfaces.close(); store.interactions.close(); await act(async () => instance.unmount()); await instance.waitUntilExit(); input.destroy(); output.destroy();}
});
test('正式 /model 实际 Ink 查询、筛选、跨提供商切换，取消和 /status 不调用模型', {timeout: 8000}, async () => {
  const server = createServer((request, response) => {response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({data: [{id: 'same'}, {id: request.url?.startsWith('/beta') ? 'beta-only' : 'alpha-only'}]}));});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const cwd = await mkdtemp(join(tmpdir(), 'logox-model-ui-')), input = new TerminalInput(), output = new TerminalOutput();
  const config = await loadConfig(cwd, {provider: {name: 'alpha', model: 'same'}, providers: {
    alpha: {base_url: 'http://127.0.0.1:' + address.port + '/alpha'}, beta: {base_url: 'http://127.0.0.1:' + address.port + '/beta'},
  }}, {}, cwd, cwd);
  let calls = 0;
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, env: {}, authPath: join(cwd, 'auth.json'), provider: {respond: async () => {calls++; throw new Error('不应调用模型');}}});
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<App stage sessionId={app.sessionId} store={app.store} surfaces={app.surfaces} authentication={app.authentication}
    getCommandContext={app.commandContext} onSubmit={app.submit} onCancel={app.cancel} onClose={app.close}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const key = async (value: string) => press(input, instance, value);
  const openModels = async () => {
    await key('/model');
    await act(async () => {
      input.write('\r');
      for (let i = 0; i < 100; i++) {const state = app.surfaces.getSnapshot(); if (state?.kind === 'picker' && state.status === 'ready') return; await delay(10);}
      throw new Error('模型目录未完成');
    });
    await instance.waitUntilRenderFlush();
  };
  const selected = async () => {
    await act(async () => {
      for (let i = 0; i < 100; i++) {if (!app.surfaces.getSnapshot()) return; await delay(10);}
      throw new Error('模型选择未完成');
    });
    await instance.waitUntilRenderFlush();
  };
  try {
    await openModels();
    assert.match(frame(output), /(?:选择模型|Select Model)/); assert.match(frame(output), /same · (?:当前|current)/);
    await key('beta'); assert.doesNotMatch(frame(output), /alpha-only/); await key('\r'); await selected();
    assert.equal(app.commandContext().models[0], 'beta-only');
    await openModels(); await key('alpha'); await key('\x1b');
    assert.equal(app.commandContext().models[0], 'beta-only');
    await key('/status'); await key('\r'); assert.match(frame(output), /(?:提供商：|Provider: )beta/);
    await key('\x1b[C'); assert.match(frame(output), /(?:最大输出 token|Max tokens)/);
    await key('\x1b'); assert.equal(app.surfaces.getSnapshot(), null); assert.equal(calls, 0);
    assert.deepEqual(await app.journal.load(app.sessionId, 'logox'), []);
  } finally {await act(async () => {await app.close(); instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, {recursive: true, force: true});}
});
