import {useState} from 'react';
import {Box, Text, useCursor, useInput, usePaste} from 'ink';
import stringWidth from 'string-width';
import type {PickerItem} from '../runtime/command-surface.js';
import {palette, safeText} from './cards.js';
import {clipLine} from './viewport.js';
import {emptyDraft, erase, graphemes, insert, type Draft} from './editor.js';
import {CommandPane, panePadding} from './command-pane.js';

export interface EffortStyle {
  readonly color: string;
  readonly label: string;
}

export const effortStyles: Record<string, EffortStyle> = {
  off:    {color: '#8b949e', label: 'off'},
  low:    {color: '#7ee7c4', label: 'low'},
  medium: {color: '#5282b5', label: 'medium'},
  high:   {color: '#d97757', label: 'high'},
  max:    {color: '#e8a8dc', label: 'max'},
  auto:   {color: '#e5b567', label: 'auto'},
};

export interface PickerProps {
  title: string; description?: string; items: readonly PickerItem[]; current?: string;
  status?: 'loading' | 'ready' | 'saving'; error?: string; emptyText?: string;
  width: number; height: number; y?: number;
  notice?: string;
  deleteLabel?: string | undefined; onDelete?(id: string): void;
  effort?: string | undefined; effortLevels?: readonly string[] | undefined;
  onSelect(id: string, effort?: string): void; onCancel(): void;
}
export function Picker({title, description = '', items, current = '', status = 'ready', error = '',
  emptyText = 'No matching options', width, height, y = 0, notice = '', deleteLabel, onDelete, effort, effortLevels, onSelect, onCancel}: PickerProps) {
  const [search, setSearch] = useState<Draft>(emptyDraft);
  const [focused, setFocused] = useState(current);
  const filter = search.text.toLocaleLowerCase();
  const matches = items.filter(item => (item.label + ' ' + (item.description ?? '')).toLocaleLowerCase().includes(filter));
  const enabled = matches.filter(item => !item.disabled);
  const selected = enabled.find(item => item.id === focused) ?? enabled.find(item => item.id === current) ?? enabled[0];
  const index = matches.findIndex(item => item.id === selected?.id);
  const itemEffortLevels = selected?.effortLevels && selected.effortLevels.length > 0 ? selected.effortLevels : (effortLevels && effortLevels.length > 0 ? effortLevels : undefined);
  const [itemEfforts, setItemEfforts] = useState<Record<string, string>>({});
  const currentEffort = (selected ? itemEfforts[selected.id] : undefined) ?? selected?.effort ?? effort ?? itemEffortLevels?.[0];
  const hasEffortBar = Boolean(itemEffortLevels && itemEffortLevels.length > 0);
  const count = Math.max(1, height - (hasEffortBar ? 7 : 5));
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), matches.length - count));
  const padding = panePadding(width), columns = Math.max(1, width - 2 * padding);
  const searchWidth = Math.max(1, columns - 6);
  let tail = search.text;
  while (stringWidth(tail) > searchWidth) tail = graphemes(tail).slice(1).join('');
  const {setCursorPosition} = useCursor();
  setCursorPosition(status === 'ready' && height >= 6 ? {x: Math.min(width - 1, padding + 6 + stringWidth(tail)), y: y + 3} : undefined);
  const edit = (next: Draft) => {if (next.text.length <= 512) {setSearch(next); setFocused('');};};
  usePaste(text => {if (status === 'ready') edit(insert(search, text.replace(/[\r\n]/g, ' ')));});
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) {if (status !== 'saving') onCancel(); return;}
    if (status !== 'ready') return;
    if (key.ctrl && input === 'x' && selected?.deletable && onDelete) {onDelete(selected.id); return;}
    if (key.return) {if (selected) onSelect(selected.id, currentEffort); return;}
    if (itemEffortLevels && itemEffortLevels.length > 0 && (key.leftArrow || key.rightArrow) && selected) {
      const idx = Math.max(0, itemEffortLevels.indexOf(currentEffort ?? itemEffortLevels[0]!));
      const nextIdx = (idx + (key.leftArrow ? -1 : 1) + itemEffortLevels.length) % itemEffortLevels.length;
      const nextEffort = itemEffortLevels[nextIdx]!;
      setItemEfforts(prev => ({...prev, [selected.id]: nextEffort}));
      return;
    }
    const at = enabled.findIndex(item => item.id === selected?.id);
    let next: number | undefined;
    if (key.upArrow || key.downArrow) next = at + (key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) next = at + (key.pageUp ? -count : count);
    if (key.home || key.end) next = key.home ? 0 : enabled.length - 1;
    if (next !== undefined) {setFocused(enabled[Math.max(0, Math.min(enabled.length - 1, next))]?.id ?? ''); return;}
    if (key.backspace || key.delete) {edit(erase(search, true)); return;}
    if (key.ctrl && input === 'u') {edit(emptyDraft); return;}
    if (!key.ctrl && !key.meta && !key.tab && input) edit(insert(search, input));
  });
  const effortNotice = hasEffortBar ? ' · ←→ Thinking' : '';
  const footer = status === 'saving' ? 'Processing...' : '↑↓ Select' + effortNotice + ' · Enter Confirm · Esc Back' + (selected?.deletable && deleteLabel ? ' · Ctrl+X ' + deleteLabel : '');
  return <CommandPane title={title} width={width} height={height} footer={notice || footer}>
    <Box height={1} flexShrink={0}><Text color={error ? palette.error : palette.muted} wrap="truncate">{clipLine(safeText(error || description), columns)}</Text></Box>
    <Box height={1} flexShrink={0}><Text color={palette.fg} wrap="truncate">{'Search: ' + tail}</Text></Box>
    <Box height={count} flexShrink={0} flexDirection="column" overflow="hidden">
      {status === 'loading' ? <Text color={palette.muted}>Searching...</Text> : matches.length ? matches.slice(start, start + count).map(item => {
        const active = item.id === selected?.id;
        const itemEffort = active ? currentEffort : (itemEfforts[item.id] ?? item.effort);
        const effortBadge = itemEffort && item.effortLevels && item.effortLevels.length > 1 ? ' · ✦ ' + itemEffort : '';
        const detail = clipLine(safeText(item.description ?? ''), Math.max(0, Math.min(24, Math.floor(columns / 3))));
        const labelColumns = Math.max(1, columns - 2 - (detail ? stringWidth(detail) + 2 : 0));
        const label = clipLine(safeText(item.label + (item.id === current ? ' · current' : '') + effortBadge), labelColumns);
        const content = label + (detail ? ' '.repeat(Math.max(2, labelColumns - stringWidth(label) + 2)) + detail : '');
        return <Box key={item.id} height={1} flexShrink={0}><Text bold={active} color={item.disabled ? palette.muted : item.color ?? (active ? palette.accent : palette.fg)} wrap="truncate">
          {(active ? '❯ ' : '  ') + content}
        </Text></Box>;
      }) : <Text color={palette.muted} wrap="truncate">{emptyText}</Text>}
    </Box>
    {hasEffortBar && <>
      <Box height={1} flexShrink={0} />
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate">
          <Text color={palette.accent}>{'✦ Thinking: '}</Text>
          <Text color={palette.borderMuted}>{'[ '}</Text>
          {(() => {
            const levels = itemEffortLevels ?? [];
            const activeIdx = Math.max(0, levels.indexOf(currentEffort ?? levels[0]!));
            const dashCount = Math.max(2, Math.min(6, Math.floor(12 / Math.max(1, levels.length - 1))));
            const currentStyle = effortStyles[currentEffort ?? ''] ?? {color: palette.accent};
            return levels.map((tier, idx) => {
              const isSelected = idx === activeIdx;
              const isPast = idx < activeIdx;
              const railColor = isPast ? currentStyle.color : palette.borderMuted;
              return <Text key={tier}>
                {idx > 0 && <Text color={railColor}>{'─'.repeat(dashCount)}</Text>}
                <Text color={isSelected ? currentStyle.color : (isPast ? currentStyle.color : palette.borderMuted)} bold={isSelected}>
                  {isSelected ? '●' : '○'}
                </Text>
              </Text>;
            });
          })()}
          <Text color={palette.borderMuted}>{' ] '}</Text>
          <Text color={(effortStyles[currentEffort ?? ''] ?? {color: palette.accent}).color} bold>{currentEffort}</Text>
          <Text color={palette.muted}>{'  (← → to adjust)'}</Text>
        </Text>
      </Box>
    </>}
  </CommandPane>;
}
