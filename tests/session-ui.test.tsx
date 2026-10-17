import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {ApplicationStage} from '../src/tui/application.js';
import {renderTerminal} from '../src/tui/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {waitForSnapshot} from './runtime-fixture.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this {this.isRaw = value; return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}
test('实际 Ink 和独立画布切换会话：picker 取消保留草稿，切换清理窗口草稿/旧画布/阅读锚点，退出释放锁', {timeout: 10000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-session-ui-'));
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072},
    models: {'openai-compatible/retained': {context_window: 131072, thinking_protocol: 'deepseek'}}}, {}, cwd, cwd);
  let calls = 0;
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, "auth.json"), sessionId: 'first', config, provider: {async respond() {
    calls++; return {message: {role: 'assistant', text: Array.from({length: 40}, (_, index) => '旧会话正文 ' + index).join('\n')}, stop: 'complete', usage: {input: 10, output: 2}};
  }}});
  const input = new Input(), output = new TerminalScreen(); output.columns = 80; output.rows = 24;
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {instance = renderTerminal(<ApplicationStage application={app}/>, {stdout: output, stdin: input, stderr: output,
    interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false, maxFps: 60});});
  const key = async (text: string) => {await act(async () => {input.write(text); await delay(text === '\x1b' ? 45 : 15);}); await instance.waitUntilRenderFlush();};
  try {
    await act(async () => {
      await app.submit('/model retained'); await app.submit('/effort high');
      await app.submit('/permissions add project deny write protected.txt');
      await app.submit('/permissions add session allow read sample.txt');
    });
    const tools = app.tools, resources = app.resources, extensions = app.extensions;
    await act(async () => {await app.submit('旧会话任务'); await waitForSnapshot(app.store, snapshot => snapshot.activities[0]?.status === 'completed');});
    await key('\x1b[5~');
    assert.ok(output.lines.some(line => line.includes('旧会话正文')));
    await key('主草稿'); await key('\x07'); await key('角色草稿');
    await act(async () => {await app.submit('/resume');});
    await key('\x1b');
    assert.ok(output.lines.some(line => line.includes('角色草稿')));
    await key('\x1b');
    assert.ok(output.lines.some(line => line.includes('主草稿')));
    const oldStore = app.store;
    await act(async () => {await app.submit('/new');}); await delay(25); await instance.waitUntilRenderFlush();
    assert.notEqual(app.store, oldStore);
    assert.ok(!output.lines.some(line => /旧会话正文|主草稿|角色草稿/.test(line)), '新画布与输入中没有旧会话内容');
    await key('\r'); await key('\x07'); await key('\r');
    assert.equal(calls, 1, '新会话的主窗口与角色窗口都没有残留草稿');
    await key('\x1b');
    assert.equal(app.tools, tools); assert.equal(app.resources, resources); assert.equal(app.extensions, extensions);
    await key('/config'); await key('\r');
    assert.ok(output.lines.some(line => /(?:模型：|Model: )retained/.test(line)));
    assert.ok(output.lines.some(line => /(?:思考档位：|Thinking effort: )high/.test(line)));
    await key('\x1b');
    await act(async () => {output.columns = 120; output.emit('resize');});
    await key('/permissions'); await key('\r'); await key('\r');
    assert.ok(output.lines.some(line => line.includes('protected.txt')), output.lines.join('\n'));
    assert.ok(!output.lines.some(line => line.includes('sample.txt')));
    await key('\x1b'); await key('/usage'); await key('\r');
    assert.ok(output.lines.some(line => line.includes('合计输入 / 输出：0 / 0')));
    await key('\x1b');
    await act(async () => {await app.submit('/resume first');}); await delay(25); await instance.waitUntilRenderFlush();
    assert.ok(output.lines.some(line => line.includes('旧会话正文 39')), '恢复会话从底部跟随，没有继承旧阅读锚点');
    await key('/usage'); await key('\r');
    assert.ok(output.lines.some(line => line.includes('合计输入 / 输出：10 / 2')));
    await key('\x1b');
    await act(async () => {input.write('\x04'); await instance.waitUntilExit();});
    assert.equal(input.isRaw, false);
    const lease = await app.sessions.acquire('first'); await lease.release();
  } finally {
    await app.close(); await act(async () => {instance.unmount();}); await instance.waitUntilExit();
    input.destroy(); output.destroy(); await rm(cwd, {recursive: true, force: true});
  }
});
