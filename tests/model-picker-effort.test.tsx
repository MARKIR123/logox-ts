import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {TerminalScreen} from './terminal-screen.js';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal.js';
import {Picker, effortStyles} from '../src/tui/picker.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
class TerminalOutput extends TerminalScreen {}
function frame(output: TerminalOutput): string {return output.lines.join('\n');}
async function press(input: TerminalInput, instance: ReturnType<typeof render>, value: string): Promise<void> {
  await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();
}

test('effortStyles: 档位颜色与定义完整性', () => {
  assert.equal(effortStyles.off?.color, '#8b949e');
  assert.equal(effortStyles.low?.color, '#7ee7c4');
  assert.equal(effortStyles.medium?.color, '#5282b5');
  assert.equal(effortStyles.high?.color, '#d97757');
  assert.equal(effortStyles.max?.color, '#e8a8dc');
  assert.equal(effortStyles.auto?.color, '#e5b567');
});

test('Picker：模型列表下方空一行，呈现思考强度与颜色，支持左右键切换档位并回调', async () => {
  const input = new TerminalInput(), output = new TerminalOutput();
  let selectedId = '', selectedEffort = '';

  const items = [
    {
      id: 'm1',
      label: 'gemini-3.8-flash',
      description: 'antigravity',
      effort: 'high',
      effortLevels: ['low', 'medium', 'high', 'auto'],
    },
    {
      id: 'm2',
      label: 'claude-sonnet-4-6',
      description: 'antigravity',
      effort: 'high',
      effortLevels: ['high', 'auto'],
    },
  ];

  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(
      <Picker
        title="选择模型"
        items={items}
        current="m1"
        width={80}
        height={11}
        onSelect={(id, effort) => {
          selectedId = id;
          selectedEffort = effort ?? '';
        }}
        onCancel={() => {}}
      />,
      {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100}
    );
  });

  await instance.waitUntilRenderFlush();
  const screen = frame(output);

  // 1. 验证模型条目包含思考档位标识
  assert.match(screen, /gemini-3.8-flash.*✦ high/);

  // 2. 验证思考强度行呈现在下方，包含 ✦ 符号、滑轨与激活的 high
  assert.match(screen, /(?:✦ 思考强度:|✦ Thinking:)/);
  assert.match(screen, /\[.*●.*\]/);
  assert.match(screen, /high/);

  // 3. 验证模型列表与思考强度行之间存在空行
  const lines = output.lines;
  const modelLineIdx = lines.findIndex(l => l.includes('gemini-3.8-flash'));
  const effortLineIdx = lines.findIndex(l => l.includes('✦ Thinking:') || l.includes('✦ 思考强度:'));
  assert.ok(modelLineIdx >= 0 && effortLineIdx >= 0, '模型行与思考强度行均存在');
  assert.ok(effortLineIdx > modelLineIdx, '思考强度行在模型列表下方');

  // 模型列表与思考强度行之间至少空一行（即 effortLineIdx - modelLineIdx >= 2）
  // 列表中有 2 个模型（m1, m2），紧随其后有一行空行，然后是思考强度行
  assert.ok(effortLineIdx >= modelLineIdx + 2, '模型列表与思考强度之间有空行');

  // 4. 按左键切换档位为 medium
  await press(input, instance, '\x1b[D');
  assert.match(frame(output), /medium/);
  assert.match(frame(output), /gemini-3.8-flash.*✦ medium/);

  // 5. 按 Enter 确认，验证选择回调
  await press(input, instance, '\r');
  assert.equal(selectedId, 'm1');
  assert.equal(selectedEffort, 'medium');

  await act(async () => {
    instance.unmount();
  });
});
