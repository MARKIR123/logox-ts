import {useState} from 'react';
import stringWidth from 'string-width';
import {Box, Text, useInput} from 'ink';
import type {CommandTab, CommandToggle} from '../runtime/command-surface.js';
import {palette, safeText} from './cards.js';
import {layoutInput} from './editor.js';
import {clipLine} from './viewport.js';
import {CommandPane, panePadding} from './command-pane.js';
import {ToggleList, moveToggle} from './toggle-list.js';
import {useMouse} from './mouse.js';

export function TabbedPage({title, tabs, initialTab, width, height, onClose, onSave, onAction, saving = false, error = '', notice = ''}: {
  title: string; tabs: readonly CommandTab[]; initialTab: string; width: number; height: number; onClose(): void;
  onSave?(tabId: string, items: readonly CommandToggle[]): void;
  onAction?(tabId: string, action: string): void;
  saving?: boolean; error?: string; notice?: string;
}) {
  const [active, setActive] = useState(initialTab);
  const [focusArea, setFocusArea] = useState<'tabs' | 'content'>('tabs');
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [choices, setChoices] = useState<Record<string, readonly CommandToggle[]>>({});
  const [focused, setFocused] = useState<Record<string, number>>({});
  const index = Math.max(0, tabs.findIndex(tab => tab.id === active)), tab = tabs[index];
  const columns = Math.max(1, width - 2 * panePadding(width)), contentHeight = Math.max(1, height - 5);
  const lines = tab?.lines.flatMap(text => layoutInput({text: safeText(text), cursor: 0}, columns).lines.map(line => line.text)) ?? [];
  const max = Math.max(0, lines.length - contentHeight), offset = Math.min(max, offsets[tab?.id ?? ''] ?? 0);
  const items = tab?.toggles ? choices[tab.id] ?? tab.toggles : undefined;
  const selected = Math.min(Math.max(0, (items?.length ?? 1) - 1), focused[tab?.id ?? ''] ?? 0);
  const toggleHeight = Math.max(1, contentHeight - 1);
  const start = Math.max(0, Math.min(selected - Math.floor(toggleHeight / 2), (items?.length ?? 0) - toggleHeight));
  const toggle = (at: number) => {if (tab && items && !saving) setChoices(previous => ({...previous, [tab.id]: items.map((item, index) => index === at ? {...item, enabled: !item.enabled} : item)}));};
  const reorder = (at: number, direction: number) => {
    if (!tab || !items || saving) return;
    const changed = moveToggle(items, at, direction);
    setChoices(previous => ({...previous, [tab.id]: changed.items})); setFocused(previous => ({...previous, [tab.id]: changed.index}));
  };
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) {
      if (!saving) onClose();
      return;
    }
    if (key.ctrl) return;
    if (saving) return;
    // 顶层导航或未聚焦内容时，左右键与 Tab 始终切换页签，绝不阻断导航
    if ((key.tab || focusArea === 'tabs' && (key.leftArrow || key.rightArrow)) && tabs.length > 0) {
      const step = (key.leftArrow || (key.tab && key.shift)) ? -1 : 1;
      setActive(tabs[(index + tabs.length + step) % tabs.length]!.id);
      setFocusArea('tabs');
      return;
    }
    if (!tab) return;
    if (items) {
      if (focusArea === 'tabs') {
        if (key.downArrow) {setFocusArea('content'); return;}
        if (input === ' ') {setFocusArea('content'); toggle(selected); return;}
        if (input === '[' || input === ']' || input === '<' || input === '>') {
          setFocusArea('content'); reorder(selected, (input === '[' || input === '<') ? -1 : 1); return;
        }
        if (key.return) {onSave?.(tab.id, items); return;}
      } else {
        if (key.upArrow) {
          if (selected === 0) setFocusArea('tabs');
          else setFocused(previous => ({...previous, [tab.id]: selected - 1}));
          return;
        }
        if (key.downArrow) {
          setFocused(previous => ({...previous, [tab.id]: Math.min(items.length - 1, selected + 1)}));
          return;
        }
        if (key.leftArrow || key.rightArrow || input === '[' || input === ']' || input === '<' || input === '>') {
          reorder(selected, (key.leftArrow || input === '[' || input === '<') ? -1 : 1);
          return;
        }
        if (input === ' ') {toggle(selected); return;}
        if (key.return) {onSave?.(tab.id, items); return;}
      }
      return;
    }
    if (tab.id === 'permissions' && (input === ' ' || input === 'm' || input === 'M')) {
      onAction?.('permissions', 'toggle_mode');
      return;
    }
    let next: number | undefined;
    if (key.upArrow || key.downArrow) next = offset + (key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) next = offset + (key.pageUp ? -contentHeight : contentHeight);
    if (key.home || key.end) next = key.home ? 0 : max;
    if (next !== undefined) setOffsets(previous => ({...previous, [tab.id]: Math.max(0, Math.min(max, next))}));
  });
  useMouse(event => {
    if (event.action !== 'press' || event.button !== 0 || saving) return;
    const padding = panePadding(width), contentTop = 4;
    if (event.y === 2) {
      let column = padding;
      for (const candidate of tabs) {
        const end = column + stringWidth('  ' + candidate.title + '  ');
        if (event.x >= column && event.x < end) {setActive(candidate.id); return;}
        column = end;
      }
    }
    if (tab && items && event.y >= contentTop && event.y < contentTop + toggleHeight) {
      const at = start + event.y - contentTop;
      if (!items[at]) return;
      setFocused(previous => ({...previous, [tab.id]: at}));
      const x = event.x - padding;
      if (width >= 18 && x >= columns - 4) reorder(at, x < columns - 2 ? -1 : 1);
      else toggle(at);
    }
  });
  const footer = saving ? 'Saving...' : items ? '←→ / Tab Switch · ↑↓ Select · Space Toggle · [ / ] Reorder · Enter Save · Esc Discard' : '←→ / Tab Switch · ↑↓ / PgUp PgDn Scroll · Esc Back';
  return <CommandPane title={title} width={width} height={height} footer={notice || footer}>
    <Box height={1} flexShrink={0} overflow="hidden">
      {stringWidth(tabs.map(item => '  ' + item.title + '  ').join('')) > columns ? <Text color={tab?.color ?? palette.accent} bold wrap="truncate">{clipLine('❯ ' + (tab?.title ?? '') + ' · ' + (index + 1) + '/' + tabs.length, columns)}</Text> : tabs.map(item => <Text key={item.id} bold={item.id === tab?.id} color={item.id === tab?.id ? item.color ?? palette.accent : palette.muted}>
        {(item.id === tab?.id ? '❯ ' : '  ') + item.title + '  '}
      </Text>)}
    </Box>
    <Box height={1} flexShrink={0}/>
    <Box height={contentHeight} flexShrink={0} overflow="hidden" flexDirection="column">
      {items ? <>
        <ToggleList items={items} selected={selected} start={start} count={toggleHeight} width={columns} disabled={saving}/>
        <Text color={error ? palette.error : palette.muted} wrap="truncate">{clipLine(error || 'Order determines priority on narrow screens', columns)}</Text>
      </> : lines.slice(offset, offset + contentHeight).map((line, i) => {
        const isFirst = offset + i === 0;
        if (!line || !line.trim()) {
          return <Box key={i} height={1} flexShrink={0}><Text> </Text></Box>;
        }
        if (line.startsWith('──') || line.startsWith('---')) {
          return (
            <Box key={i} height={1} flexShrink={0}>
              <Text color="#555555" wrap="truncate">{clipLine(line, columns)}</Text>
            </Box>
          );
        }
        if (isFirst) {
          return (
            <Box key={i} height={1} flexShrink={0}>
              <Text color={tab?.color ?? palette.accent} bold wrap="truncate">{clipLine(line, columns)}</Text>
            </Box>
          );
        }
        const colonIndex = line.indexOf(': ');
        if (colonIndex > 0 && colonIndex < 35 && !line.startsWith('http') && !line.startsWith('  • ')) {
          const label = line.slice(0, colonIndex + 1);
          const value = line.slice(colonIndex + 1).trimStart();
          return (
            <Box key={i} height={1} flexShrink={0}>
              <Text color="#888888">{label} </Text>
              <Text color={palette.fg} bold wrap="truncate">{clipLine(value, Math.max(1, columns - stringWidth(label) - 1))}</Text>
            </Box>
          );
        }
        return (
          <Box key={i} height={1} flexShrink={0}>
            <Text color={palette.fg} wrap="truncate">{clipLine(line, columns)}</Text>
          </Box>
        );
      })}
    </Box>
  </CommandPane>;
}
