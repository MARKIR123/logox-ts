import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {TerminalScreen} from './terminal-screen.js';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal.js';
import chalk from 'chalk';
import {buildDemoSceneRows, initialDemoSceneState} from '../src/tui/scene.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {createDemo} from '../src/demo.js';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from '../src/tui/app.js';
import {waitForSnapshot} from './runtime-fixture.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

class TerminalInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}
class TerminalOutput extends TerminalScreen {}
async function flushRender(instance: ReturnType<typeof render>): Promise<void> {
  // Renderer flushing yields to async runtime work, which also belongs to this test action.
  await act(async () => {await instance.waitUntilRenderFlush();});
}
function captureActWarnings(): {restore(): void; assertClean(): void} {
  const original = console.error, warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('not wrapped in act')) warnings.push(args.map(String).join(' '));
    else original(...args);
  };
  return {restore: () => {console.error = original;}, assertClean: () => assert.equal(warnings.length, 0, warnings.join('\n'))};
}
test('全屏真实 Ink 接线：主草稿在提问期间可编辑，稍后回答不取消，回答后恢复主输入', {timeout: 8000}, async () => {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  const store = new RuntimeStore();
  const submissions: string[] = [];
  const ticket = store.interactions.open({
    kind: 'question', sessionId: 's', activityId: 'a', ownerId: 'kalon', title: '方向',
    questions: [{id: 'q', header: '方向', question: '你的要求？'}],
  });
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App store={store} sessionId="s"
      onSubmit={async text => { submissions.push(text); }}
      onCancel={() => {}} onClose={async () => {store.interactions.close();}}/>, {
      stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
      patchConsole: false, exitOnCtrlC: false, maxFps: 100,
    });
  });
  const key = async (text: string) => {
    await act(async () => { input.write(text); if (text === '\x1b') await delay(40); });
    await flushRender(instance);
  };
  try {
    assert.equal(input.isRaw, true);
    assert.ok(output.text.includes('\x1b[?1049h'), '进入备用屏');
    await key('主草稿');
    await key('\t');
    await key('\x1b');
    assert.equal(store.interactions.list()[0]!.status, 'pending', 'Esc 仅稍后回答');
    await key('\t');
    await key('留白');
    await key('\r');
    const outcome = await ticket.result;
    assert.equal(outcome.status, 'answered');
    if (outcome.status === 'answered' && outcome.response.kind === 'question') {
      assert.deepEqual(outcome.response.answers.q, {type: 'text', text: '留白'});
    }
    await key('\r');
    assert.deepEqual(submissions, ['主草稿']);
    await act(async () => {
      store.message('s', 'kalon', 'assistant', '我的大哲学家，这段正文的左侧轨道不会被复制进去。');
    });
    await flushRender(instance);
    await key('\x1b[<0;1;1M\x1b[<32;60;3M\x1b[<0;60;3m');
    const oscMatch = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(output.text);
    assert.ok(oscMatch, 'SGR 鼠标拖拽释放后写出 OSC 52 剪贴板序列');
    const copied = Buffer.from(oscMatch![1]!, 'base64').toString('utf8');
    assert.equal(copied, '✧ Kalon · 台词\n我的大哲学家，这段正文的左侧轨道不会被复制进去。\n');
    assert.ok(!copied.includes('▎'), '复制结果不含左轨字符');
    output.rows = 12; output.columns = 30;
    await act(async () => { output.emit('resize'); });
    await flushRender(instance);
  } finally {
    store.interactions.close();
    await act(async () => { instance.unmount(); });
    await instance.waitUntilExit();
    assert.equal(input.isRaw, false, '退出恢复输入模式');
    assert.ok(output.text.includes('\x1b[?1049l'), '恢复原终端屏幕');
    input.destroy(); output.destroy();
  }
});

test('npm run demo 场景接线：内联思考/工具卡、三角色卡、内联权限与提问、@kalon 初始草稿及角色历史窗口', {timeout: 8000}, async () => {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  output.columns = 100;
  output.rows = 42;
  const directory = await mkdtemp(join(tmpdir(), 'logox-scene-'));
  const runtime = createDemo('demo', directory);
  await runtime.ready;
  const store = runtime.store;
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App store={store} sessionId="demo" demoScene scenario={runtime.scenario}
      onSubmit={runtime.submit} onCancel={runtime.cancel} onClose={runtime.close}/>, {
      stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
      patchConsole: false, exitOnCtrlC: false, maxFps: 100,
    });
  });
  const key = async (text: string) => {
    await act(async () => { input.write(text); await delay(40); });
    await flushRender(instance);
  };
  try {
    assert.match(output.text, /保留项目内容，让它更像一个有审美的开发者作品/);
    assert.match(output.text, /◇ Aletheia/);
    assert.match(output.text, /⊞ Techne/);
    assert.match(output.text, /允许修改这两个文件吗？/);
    await key('\x1b[6~'); // 较低的终端滚动后可见排队中的 Kalon
    assert.match(output.text, /✧ Kalon/);
    await key('\x1b[5~');
    assert.match(output.text, /@kalon 看一下首页配色。只给建议，先别改文件。/);
    assert.match(output.text, /◈ Logox · Techne 等待授权/);

    // 1. Enter 发送预填的 @kalon 快速派发草稿（仍留在 Logox 主窗口）
    await key('\r');
    assert.match(output.text, /在 Logox 中指派/);
    assert.doesNotMatch(output.text, /行，先不动文件/, '未轮到 Kalon 时不能提前生成回复');
    const accepted = store.getSnapshot().messages.find(message => message.text.includes('看一下首页配色'));
    assert.ok(accepted?.activityId);
    assert.equal(store.activities.get('demo', accepted.activityId)!.status, 'queued');

    // 2. Tab 聚焦并确认 Techne 权限 -> Techne 收起，Kalon 自动展开提问
    await key('\x07'); // Aletheia
    await key('\x07'); // Techne 独立窗口
    await key('\t');
    await key('\x1b');
    assert.equal(store.interactions.list()[0]!.status, 'pending', '稍后回答只收起卡片');
    await key('\t');
    await key('\r');
    assert.equal(store.interactions.list()[0]!.status, 'answered');
    await act(async () => {
      await waitForSnapshot(store, snapshot => snapshot.interactions.some(request =>
        request.activityId === runtime.scenario.kalon && request.status === 'pending'));
    });
    await flushRender(instance);
    await key('\x1b'); // 返回主窗口，同一请求已同步
    await key('\t'); // 聚焦实际提问，并定位到对应卡片
    assert.match(output.text, /你希望首页更接近哪种气质？/);
    assert.match(output.text, /◈ Logox · Kalon 等待回答/);

    // 3. 确认 Kalon 审美提问 -> 浮现 Anamnesis 入梦候选卡与收尾结语
    await key('\r');
    assert.match(output.text, /Anamnesis · 偏好候选/);
    await act(async () => {await waitForSnapshot(store, snapshot => snapshot.activities.some(activity => activity.activityId === accepted.activityId && activity.status === 'completed'));});
    await flushRender(instance);
    assert.match(output.text, /结构与审美校准均已收束完毕/);
    assert.equal(store.activities.get('demo', accepted.activityId)!.status, 'completed');
    assert.match(output.text, /行，先不动文件/);
    assert.equal(store.getSnapshot().messages.filter(message => message.activityId === accepted.activityId && message.role === 'user').length, 1, '切换与重绘不重复提交');

    // 4. Ctrl+G 切换角色独立历史窗口，Esc 返回 Logox
    await key('\x07');
    assert.match(output.text, /◇ Aletheia · 澄明 · 侦察者 · 独立对话/);
    await key('\x1b');
    assert.match(output.text, /◈ Logox · 本轮完成 · Anamnesis 整理候选/);
  } finally {
    await act(async () => {await runtime.close(); instance.unmount();});
    await rm(directory, {recursive: true, force: true});
    await instance.waitUntilExit();
    input.destroy(); output.destroy();
  }
});

test('多行输入真实 Ink 接线：Shift+Enter、粘贴、五行视口、缩放与上下键焦点路由', {timeout: 8000}, async () => {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  output.columns = 50; output.rows = 14;
  const store = new RuntimeStore();
  const submissions: string[] = [];
  const permission = store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'a', ownerId: 'techne', title: '许可', tool: 'write', arguments: {path: 'a.ts'}, reason: '等待许可'});
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App store={store} sessionId="s" onSubmit={async text => {submissions.push(text);}}
      onCancel={() => {}} onClose={async () => {}}/>, {
      stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
      patchConsole: false, exitOnCtrlC: false, maxFps: 100,
    });
  });
  const key = async (text: string) => {
    await act(async () => {input.write(text);});
    await flushRender(instance);
  };
  const latestFrame = () => output.text.split('\x1b[1;1H\x1b[J').at(-1)!.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  try {
    await key('first');
    await key('\x1b[13;2u');
    await key('second');
    assert.deepEqual(submissions, [], 'Shift+Enter 不发送');
    await key('\x1b[200~\r\n三🙂\r\n四\r\n五\r\n六\r\n七\r\n八\x1b[201~');
    assert.deepEqual(submissions, [], '粘贴中的回车不发送');
    assert.match(latestFrame(), /六/);
    assert.match(latestFrame(), /八/);
    assert.doesNotMatch(latestFrame(), /first/, '旧输入行已离开输入视口');
    await key('\x1b[A');
    await key('!');
    assert.equal(store.interactions.list()[0]!.status, 'pending', '输入焦点上下移动不提交许可');
    output.columns = 20; output.rows = 8;
    await act(async () => {output.emit('resize');});
    await flushRender(instance);
    assert.ok(latestFrame().split('\n').length <= 8, '缩放后底部区不超出终端');
    await key('\r');
    assert.deepEqual(submissions, ['first\nsecond\n三🙂\n四\n五\n六\n七!\n八']);
    await key('\t');
    await key('\x1b[A');
    await key('\r');
    const result = await permission.result;
    assert.equal(result.status, 'answered');
    assert.ok(result.status === 'answered' && result.response.kind === 'permission');
    if (result.status === 'answered' && result.response.kind === 'permission') assert.equal(result.response.decision, 'allow_once');
  } finally {
    store.interactions.close();
    await act(async () => {instance.unmount();});
    await instance.waitUntilExit();
    input.destroy(); output.destroy();
  }
});



test('真实 Ink 鼠标悬停：全移动报告、纯色变亮与恢复，点击仍能展开，退出关闭报告', {timeout: 8000}, async () => {
  const previousColorLevel = chalk.level;
  chalk.level = 3;
  const input = new TerminalInput();
  const output = new TerminalOutput();
  output.columns = 100; output.rows = 55;
  let instance!: ReturnType<typeof render>;
  const rows = buildDemoSceneRows(initialDemoSceneState, 99);
  const rowIndex = rows.findIndex(r => r.messageId === 'main-aletheia');
  const key = async (text: string) => {
    await act(async () => { input.write(text); await delay(30); });
    await flushRender(instance);
  };
  const line = () => output.backgroundColors[rowIndex] ?? [];
  try {
    await act(async () => {
      instance = render(<App store={new RuntimeStore()} sessionId="hover" demoScene onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>, {
        stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100,
      });
    });
    await flushRender(instance);
    assert.ok(output.text.includes('\x1b[?1003h'));
    assert.ok(line().includes('#2c473d'), '收起使用透亮主题色 #2c473d');
    await key('\x1b[<35;8;' + (rowIndex + 1) + 'M');
    assert.ok(line().includes('#395c4f'), '悬停使用展开透亮色 #395c4f');
    assert.doesNotMatch(output.lines.join('\n'), /翻看刚读完的三份源码/);
    await key('\x1b[<35;1;' + (rowIndex + 1) + 'M');
    assert.ok(line().includes('#2c473d'), '移到轨道恢复收起色');
    await key('\x1b[<35;8;' + (rowIndex + 1) + 'M');
    await key('\x1b[<0;8;' + (rowIndex + 1) + 'M\x1b[<0;8;' + (rowIndex + 1) + 'm');
    await act(async () => { await delay(200); });
    await flushRender(instance);
    assert.match(output.text, /翻看刚读完的三份源码/);
  } finally {
    if (instance) {await act(async () => { instance.unmount(); }); await instance.waitUntilExit();}
    assert.ok(output.text.includes('\x1b[?1003l'));
    chalk.level = previousColorLevel;
    input.destroy(); output.destroy();
  }
});

test('demo 实际请求：Ctrl+X 取消许可后继续提问，自由回答从输入区进入运行时', {timeout: 8000}, async () => {
  const actWarnings = captureActWarnings();
  const directory = await mkdtemp(join(tmpdir(), 'logox-scene-answer-'));
  const runtime = createDemo('answer', directory);
  await runtime.ready;
  const input = new TerminalInput();
  const output = new TerminalOutput();
  output.columns = 100; output.rows = 50;
  let instance!: ReturnType<typeof render>;
  const key = async (text: string) => {
    await act(async () => {input.write(text); await delay(40);});
    await flushRender(instance);
  };
  try {
    await act(async () => {
      instance = render(<App store={runtime.store} sessionId="answer" demoScene scenario={runtime.scenario}
        onSubmit={runtime.submit} onCancel={runtime.cancel} onClose={runtime.close}/>, {
        stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
        patchConsole: false, exitOnCtrlC: false, maxFps: 100,
      });
    });
    await key('\t');
    await key('\x18');
    assert.equal(runtime.store.interactions.list()[0]!.status, 'cancelled');
    assert.equal(runtime.store.interactions.list()[0]!.response, undefined);
    await act(async () => {await waitForSnapshot(runtime.store, snapshot => snapshot.interactions.some(item => item.activityId === runtime.scenario.kalon && item.status === 'pending'));});
    await key('\t');
    await key('\x1b[B');
    await key('\x1b[B');
    await key('\r');
    assert.equal(runtime.store.interactions.list()[1]!.status, 'pending', '空白自由回答保留等待');
    await key('\x1b[200~像独立杂志🙂\x1b[201~');
    await key('\r');
    const answered = runtime.store.interactions.list()[1]!;
    assert.equal(answered.status, 'answered');
    assert.ok(answered.response?.kind === 'question');
    if (answered.response?.kind === 'question') assert.deepEqual(answered.response.answers.style, {type: 'text', text: '像独立杂志🙂'});
    await act(async () => {await runtime.close();});
    assert.ok(runtime.store.activities.list().every(item => ['cancelled', 'completed'].includes(item.status)));
  } finally {
    await act(async () => {await runtime.close(); if (instance) instance.unmount();});
    if (instance) await instance.waitUntilExit();
    input.destroy(); output.destroy();
    await rm(directory, {recursive: true, force: true});
    actWarnings.restore(); actWarnings.assertClean();
  }
});
test('真实舞台 Ink 接线：内联许可可稍后回答，草稿保留，拒绝不写文件，角色窗口可继续', {timeout: 10000}, async () => {
  const {createApplication} = await import('../src/application.js');
  const {loadConfig} = await import('../src/config/config.js');
  const {readFile} = await import('node:fs/promises');
  const input = new TerminalInput(), output = new TerminalOutput();
  output.rows = 36; output.columns = 100;
  const directory = await mkdtemp(join(tmpdir(), 'logox-real-ui-'));
  let round = 0;
  const runtime = await createApplication({cwd: directory, resourceOptions: {home: directory, boundary: directory}, sessionId: 'real-ui',
    config: await loadConfig(directory, {provider: {model: 'test', context_window: 131072}}, {}, directory, directory),
    provider: {async respond(_request, onDelta) {
      round++;
      if (round === 1) return {message: {role: 'assistant', text: '', toolCalls: [{
        id: 'write', name: 'write', arguments: '{"path":"never.txt","content":"bad"}',
      }]}, stop: 'tools'};
      const text = round === 2 ? '用户拒绝后保留建议。' : '角色窗口收到补充。';
      onDelta({kind: 'text', text});
      return {message: {role: 'assistant', text}, stop: 'complete'};
    }},
  });
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App stage store={runtime.store} sessionId={runtime.sessionId}
      onSubmit={runtime.submit} onCancel={runtime.cancel} onClose={runtime.close}/>, {
      stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
      patchConsole: false, exitOnCtrlC: false, maxFps: 100,
    });
  });
  const key = async (text: string) => {
    await act(async () => {input.write(text); await delay(45);});
    await flushRender(instance);
  };
  try {
    await key('@techne 写文件'); await key('\r');
    await act(async () => {await waitForSnapshot(runtime.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));});
    await flushRender(instance);
    assert.match(output.text, /允许执行 write/);
    assert.ok(!output.text.includes('首屏布局'));
    await key('保留的主草稿');
    await key('\t'); await key('\x1b');
    assert.equal(runtime.store.interactions.list()[0]?.status, 'pending');
    await key('\t'); await key('\r'); // 默认拒绝
    await act(async () => {await waitForSnapshot(runtime.store, snapshot => snapshot.activities.some(item => item.status === 'completed'));});
    await assert.rejects(readFile(join(directory, 'never.txt')));
    await key('\r'); // 草稿仍能提交
    await act(async () => {await waitForSnapshot(runtime.store, snapshot => snapshot.activities.length === 2 && snapshot.activities.every(item => item.status === 'completed'));});
    assert.ok(runtime.store.getSnapshot().messages.some(message => message.role === 'user' && message.text === '保留的主草稿'));
    await key('\x07'); // Ctrl+G -> Aletheia
    await key('独立补充'); await key('\r');
    await act(async () => {await waitForSnapshot(runtime.store, snapshot => snapshot.activities.length === 3 && snapshot.activities.every(item => item.status === 'completed'));});
    assert.equal(runtime.store.getSnapshot().activities.at(-1)?.ownerId, 'aletheia');
    output.columns = 32; output.rows = 12;
    await act(async () => {output.emit('resize');});
    await flushRender(instance);
  } finally {
    await act(async () => {await runtime.close(); instance.unmount();});
    await instance.waitUntilExit();
    input.destroy(); output.destroy();
    await rm(directory, {recursive: true, force: true});
  }
});
test('真实舞台的多问题可逐项选择和自由输入，回答不会覆盖主草稿', {timeout: 8000}, async () => {
  const input = new TerminalInput(), output = new TerminalOutput(), store = new RuntimeStore();
  const submissions: string[] = [];
  store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'actor',
    title: '确认需求', status: 'waiting_input', stage: '待回答', detail: ''});
  store.message('s', 'kalon', 'user', '询问语言和排版', {activityId: 'k'});
  const ticket = store.interactions.open({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'question', title: '确认需求',
    questions: [
      {id: 'language', header: '语言', question: '选哪种语言？', options: [
        {id: 'zh', label: '中文', description: '使用中文。'}, {id: 'en', label: '英文', description: '使用英文。'},
      ]},
      {id: 'layout', header: '排版', question: '还有什么排版要求？'},
    ]});
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App stage store={store} sessionId="s" onSubmit={async text => {submissions.push(text);}}
      onCancel={() => {}} onClose={async () => store.interactions.close()}/>, {
      stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
      patchConsole: false, exitOnCtrlC: false, maxFps: 100,
    });
  });
  const key = async (text: string) => {await act(async () => {input.write(text); await delay(40);}); await flushRender(instance);};
  try {
    await key('主草稿');
    await key('\t'); await key('\r');
    assert.equal(store.interactions.list()[0]?.status, 'pending');
    await key('上下保留留白'); await key('\r');
    const outcome = await ticket.result;
    assert.equal(outcome.status, 'answered');
    if (outcome.status === 'answered' && outcome.response.kind === 'question') assert.deepEqual(outcome.response.answers,
      {language: {type: 'option', optionId: 'zh'}, layout: {type: 'text', text: '上下保留留白'}});
    await key('\r');
    assert.deepEqual(submissions, ['主草稿']);
  } finally {
    store.interactions.close(); await act(async () => instance.unmount()); await instance.waitUntilExit();
    input.destroy(); output.destroy();
  }
});

import {AuthStorage} from '../src/providers/auth.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';

test('实际 Ink /login：提供商选择、遮罩粘贴、持久保存、取消与草稿恢复', {timeout: 8000}, async () => {
  const actWarnings = captureActWarnings();
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-tui-'));
  const authPath = join(cwd, 'user-auth.json');
  const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'fixture'}}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, authPath, sessionId: 'login-ui'});
  const input = new TerminalInput(), output = new TerminalOutput();
  const submissions: string[] = [];
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App store={app.store} sessionId={app.sessionId} stage authentication={app.authentication} getCommandContext={app.commandContext}
      onSubmit={async text => {submissions.push(text);if (text.startsWith('/login')) await app.submit(text);}}
      onCancel={app.cancel} onClose={app.close}/>, {
      stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
      patchConsole: false, exitOnCtrlC: false, maxFps: 100,
    });
  });
  const key = async (value: string) => {
    await act(async () => {input.write(value);await delay(value === '\x1b' ? 40 : 10);});
    await flushRender(instance);
  };
  const phase = async (expected: string | null) => {
    await act(async () => {
      for (let i = 0; i < 100 && (app.authentication.getSnapshot()?.phase ?? null) !== expected; i++) await delay(10);
    });
    assert.equal(app.authentication.getSnapshot()?.phase ?? null, expected);
    await flushRender(instance);
  };
  try {
    await key('/lo');await key('\r');await phase('provider');
    assert.ok(output.text.includes('登录提供商'));
    await key('\x1b[B');await key('\r');await phase('key');
    assert.equal(app.authentication.getSnapshot()?.provider, 'deepseek');
    await key('\x1b[200~synthetic-ui-secret\x1b[201~');
    assert.ok(!output.text.includes('synthetic-ui-secret'));
    assert.ok(output.text.includes('•'));
    await key('\r');await phase(null);
    assert.equal(await new AuthStorage(authPath).key('deepseek'), 'synthetic-ui-secret');
    assert.ok(!JSON.stringify(app.store.getSnapshot()).includes('synthetic-ui-secret'));
    assert.deepEqual(submissions, ['/login']);
    await key('ordinary-draft');
    await act(async () => {await app.submit('/login deepseek');});await phase('key');
    output.columns = 32;output.rows = 12;
    await act(async () => {output.emit('resize');});await flushRender(instance);
    await key('cancelled-secret');await key('\x1b');await phase(null);
    assert.equal(await new AuthStorage(authPath).key('deepseek'), 'synthetic-ui-secret');
    assert.ok(!output.text.includes('cancelled-secret'));
    await key('\r');assert.deepEqual(submissions, ['/login', 'ordinary-draft']);
    assert.deepEqual(await app.journal.load(app.sessionId, 'logox'), []);
  } finally {
    await act(async () => {await app.close();instance.unmount();});await instance.waitUntilExit();
    await rm(cwd, {recursive: true, force: true});
    actWarnings.restore(); actWarnings.assertClean();
  }
});

test('正式舞台命令联想：过滤、选择、补齐、执行、参数确认与审批焦点', {timeout: 8000}, async () => {
  const input = new TerminalInput(), output = new TerminalOutput(), store = new RuntimeStore();
  const submissions: string[] = [];
  const ticket = store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'a', ownerId: 'techne',
    title: '写文件', tool: 'write', arguments: {path: 'fixture.txt'}, reason: '待审批'});
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App stage sessionId="s" store={store}
      getCommandContext={() => ({providers: ['deepseek', 'antigravity'], loginProviders: ['deepseek'], models: ['fixture', 'qwen-test']})}
      onSubmit={async text => {submissions.push(text);}} onCancel={() => {}} onClose={async () => store.interactions.close()}/>,
      {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, maxFps: 100, patchConsole: false, exitOnCtrlC: false});
  });
  const key = async (value: string) => {
    await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);});
    await flushRender(instance);
  };
  const frame = () => output.text.split('\x1b[1;1H\x1b[J').at(-1)!.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  try {
    await key('/');
    assert.match(frame(), /❯ \/help/); assert.match(frame(), /(?:登录并保存 API key|Log in and save)/);
    await key('\x1b[B'); await key('\t');
    assert.deepEqual(submissions, [], 'Tab 不执行命令，也不抢占审批');
    assert.match(frame(), /❯ \/login/);
    await key('\r'); assert.deepEqual(submissions, ['/login']);
    await key('/mod'); assert.match(frame(), /(?:选择已登录提供商的模型|Select model|Open model picker)/);
    await key('\t'); assert.match(frame(), /techne/);
    await key('\x1b[B'); await key('\t');
    assert.deepEqual(submissions, ['/login']);
    await key('\r'); assert.deepEqual(submissions, ['/login', '/model techne']);
    await key('/pro'); await key('\x1b[B'); await key('\t');
    assert.match(frame(), /❯ deepseek/);
    await key('\r'); assert.deepEqual(submissions, ['/login', '/model techne'], '参数确认只补齐');
    await key('\r'); assert.deepEqual(submissions, ['/login', '/model techne', '/provider deepseek']);
    await key('/l'); await key('\x1b');
    assert.doesNotMatch(frame(), /(?:登录并保存 API key|Log in and save)/); assert.match(frame(), /❯ \/l/);
    await key('\t'); await key('\r');
    assert.equal((await ticket.result).status, 'answered', '菜单关闭后 Tab 仍可聚焦审批');
    assert.match(frame(), /❯ \/l/, '审批后保留主草稿');
    await key('o'); assert.match(frame(), /(?:登录并保存 API key|Log in and save)/, '编辑后重新联想');
    await key('g'); await key('\x7f');
    assert.match(frame(), /(?:登录并保存 API key|Log in and save)/, '回到曾经关闭的前缀也重新联想');
    output.columns = 32; output.rows = 12;
    await act(async () => output.emit('resize')); await flushRender(instance);
    assert.match(frame(), /❯ \/login/);
    await key('\r'); assert.equal(submissions.at(-1), '/login');
    await key('/sta'); await key('\x1b\r');
    assert.equal(submissions.at(-1), '/login', 'Alt+Enter 仍是换行');
    assert.doesNotMatch(frame(), /查看模型、会话和任务/);
  } finally {
    store.interactions.close(); await act(async () => instance.unmount()); await instance.waitUntilExit();
    input.destroy(); output.destroy();
  }
});
