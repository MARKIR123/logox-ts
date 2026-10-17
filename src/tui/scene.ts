import type {ActivityStatus, Interaction, Step} from '../runtime/contracts.js';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type {ActorId} from '../actors/ensemble.js';
import {actorCardPalette, choiceStyle, mixHex, palette, safeText, ownerColor, ownerHeader, ownerSurface, type ActorStyles} from './cards.js';
import {cast} from '../actors/ensemble.js';
import type {Row} from './viewport.js';
import type {ContentCell} from './selection.js';
import {layoutMarkdown} from './markdown.js';
import {stepStatus, stepIcon, thinkingDuration} from './row-presentation.js';

export interface SceneSegment {
  readonly text: string;
  readonly color?: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly selectionKey?: string;
  readonly selectionOffset?: number;
}

export interface SceneAction {
  readonly kind:
    | 'toggle_fold'
    | 'actor_summary'
    | 'actor_body'
    | 'select_permission'
    | 'confirm_permission'
    | 'select_style'
    | 'focus_custom'
    | 'confirm_style'
    | 'select_answer'
    | 'confirm_answer'
    | 'stop_actor'
    | 'later';
  readonly requestId?: string;
  readonly foldId?: string;
  readonly owner?: string;
  readonly value?: string;
}

export interface SceneRow extends Row {
  readonly color?: string;
  readonly hover?: {readonly foldId: string; readonly startCol: number; readonly endCol: number};
  readonly bg?: string;
  readonly prefixSegments?: readonly SceneSegment[];
  readonly suffixSegments?: readonly SceneSegment[];
  readonly segments?: readonly SceneSegment[];
  readonly action?: SceneAction;
  readonly hits?: readonly {readonly startCol: number; readonly endCol: number; readonly action: SceneAction}[];
  readonly animation?: {readonly step?: Step; readonly thinking?: boolean; readonly highlighted?: boolean; readonly actorBg?: string; readonly actorColor?: string; readonly active?: boolean};
  readonly controls?: readonly {readonly startCol: number; readonly endCol: number; readonly action: SceneAction; readonly disabled?: boolean}[];
}

export interface DemoEvent {
  readonly id: number | string;
  readonly type: 'dispatch' | 'direct' | 'main' | 'permission' | 'style';
  readonly actor?: 'aletheia' | 'techne' | 'kalon';
  readonly text?: string;
  readonly direction?: string;
  readonly reply?: string;
  readonly value?: 'allow' | 'deny';
  readonly from?: string;
  readonly status?: string;
  readonly activityId?: string;
  readonly error?: string;
}

export interface DemoSceneState {
  readonly view: ActorId;
  readonly permission: 'allow' | 'deny' | null;
  readonly permissionChoice: 'allow' | 'deny';
  readonly style: string | null;
  readonly choice: 'minimal' | 'editorial' | 'custom';
  readonly custom: string;
  readonly customError: boolean;
  readonly folds: Readonly<Record<string, boolean>>;
  readonly events: readonly DemoEvent[];
  readonly runtime?: {
    readonly techne: ActivityStatus;
    readonly kalon: ActivityStatus;
    readonly permissionRequest?: Interaction;
    readonly styleRequest?: Interaction;
    readonly background?: readonly {id: string; title: string; stage: string; detail: string; status: string}[];
  };
}

export type DemoSceneUi = Pick<DemoSceneState, 'view' | 'permissionChoice' | 'choice' | 'custom' | 'customError' | 'folds'>;

export const INITIAL_DEMO_DRAFT = '@kalon 看一下首页配色。只给建议，先别改文件。';

export const initialDemoSceneState: DemoSceneState = {
  view: 'logox',
  permission: null,
  permissionChoice: 'deny',
  style: null,
  choice: 'minimal',
  custom: '',
  customError: false,
  folds: {},
  events: [],
};

export const demoRoles = {
  aletheia: {name: 'Aletheia', role: '澄明 · 侦察者', symbol: '◇', color: actorCardPalette.aletheia.highlight, task: '勘察首页结构与问题坐标'},
  techne: {name: 'Techne', role: '精工 · 构建匠人', symbol: '⊞', color: actorCardPalette.techne.highlight, task: '调整首屏层级与项目排列'},
  kalon: {name: 'Kalon', role: '雅正 · 审美官', symbol: '✧', color: actorCardPalette.kalon.highlight, task: '校准首页的字体、颜色和留白'},
} as const;

export function isFoldOpen(state: Pick<DemoSceneState, 'folds'>, id: string, fallback = false): boolean {
  return id in state.folds ? Boolean(state.folds[id]) : fallback;
}


export function defaultSceneFoldOpen(state: DemoSceneState, id: string): boolean {
  if (id === 'main-techne' || id === 'history-techne-question') {
    return state.runtime ? state.runtime.permissionRequest?.status === 'pending' : !state.permission;
  }
  if (id === 'main-kalon' || id === 'history-kalon-question') {
    return state.runtime ? state.runtime.styleRequest?.status === 'pending' : Boolean(state.permission) && !state.style;
  }
  return false;
}

function portfolioTaskStatus(state: DemoSceneState, owner: 'techne' | 'kalon'): string {
  const runtime = state.runtime;
  const request = owner === 'techne' ? runtime?.permissionRequest : runtime?.styleRequest;
  if (runtime) {
    const status = runtime[owner];
    if (status === 'cancelled') return '已取消';
    if (status === 'failed') return '执行失败';
    if (status === 'queued') return '排队中';
    if (status === 'running') return '处理中';
    if (status === 'paused') return '已暂停';
    if (request?.status === 'cancelled') return '已结束 · 请求已取消';
  }
  if (owner === 'techne') return state.permission
    ? state.permission === 'allow' ? '已完成 · 演示方案已获许可' : '已结束 · 未修改文件'
    : '等待你授权';
  return state.style ? '已完成 · 偏好已记录' : state.permission || request?.status === 'pending' ? '等待你回答' : '排队中 · 等待 Techne';
}

function railColorFor(who: string, roles: ActorStyles = cast): string {
  if (who === 'user') return palette.user;
  if (who === 'system') return palette.muted;
  if (who === 'logox') return palette.accent;
  return ownerColor(who, roles);
}

function whoLabel(who: string, roles: ActorStyles = cast): string {
  if (who === 'user') return '你';
  if (who === 'system') return '系统';
  if (who === 'logox') return '◈ Logox';
  return ownerHeader(who, roles);
}


function statusColor(status: string, actorColor = palette.accent): string {
  if (/待授权|待回答|等待/.test(status)) return actorColor;
  if (/待核验/.test(status)) return palette.dreamText;
  return palette.muted;
}

interface FrameWrap {
  readonly leftSegments: readonly SceneSegment[];
  readonly rightSegments: readonly SceneSegment[];
  readonly leftCols: number;
  readonly rightCols: number;
  readonly innerWidth: number;
  readonly bg?: string;
}

interface RowBuilder {
  rows: SceneRow[];
  width: number;
  baseGutterCols: number;
  contentWidth: number;
  hoveredFoldId: string | null;
  pushBlank(railColor?: string, frame?: FrameWrap, action?: SceneAction): void;
  pushTurnHeader(id: string, who: string, origin?: string, clock?: string): void;
  pushProse(id: string, text: string, railColor: string, tone?: 'body' | 'direction', frame?: FrameWrap, action?: SceneAction, color?: string): void;
  pushMarkdown(id: string, text: string, railColor: string, frame?: FrameWrap): void;
  pushFramedLine(
    id: string,
    railColor: string,
    innerSegments: readonly SceneSegment[],
    frame: FrameWrap,
    action?: SceneAction,
    lineBg?: string,
  ): void;
  pushCardCap(
    id: string,
    edge: 'top' | 'bottom',
    cardBg: string | undefined,
    railColor: string,
    parentFrame?: FrameWrap,
    action?: SceneAction,
  ): void;
  pushCardHeader(id: string, label: readonly SceneSegment[], title: string, status: string, frame: FrameWrap, railColor: string, action: SceneAction, statusTint?: string, textTint?: string, textBold?: boolean): void;
  pushOrdinaryCard(opts: {
    id: string;
    kind: string;
    title: string;
    bodyLines: readonly string[];
    status?: string;
    open: boolean;
    railColor: string;
    parentFrame?: FrameWrap;
    ownerId?: string;
    toneColor?: string;
    step?: Step;
    tokens?: number;
    renderBody?(frame: FrameWrap): void;
  }): void;
}

export function insetFrame(parent: FrameWrap, bg: string | undefined, left = 2, right = left): FrameWrap {
  left = Math.min(left, Math.max(0, parent.innerWidth - 1));
  right = Math.min(right, Math.max(0, parent.innerWidth - left - 1));
  return {
    leftSegments: [...parent.leftSegments, {text: ' '.repeat(left), ...(bg ? {bg} : {})}],
    rightSegments: [{text: ' '.repeat(right), ...(bg ? {bg} : {})}, ...parent.rightSegments],
    leftCols: parent.leftCols + left,
    rightCols: parent.rightCols + right,
    innerWidth: Math.max(1, parent.innerWidth - left - right),
    ...(bg ? {bg} : {}),
  };
}

const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});

// Preserve segment styling while wrapping at display-cell boundaries.
function wrapSegments(segments: readonly SceneSegment[], width: number): SceneSegment[][] {
  const lines: SceneSegment[][] = [[]];
  let used = 0;
  for (const segment of segments) {
    let offset = segment.selectionOffset ?? 0;
    for (const {segment: part} of segmenter.segment(safeText(segment.text))) {
      if (part === '\n' || (used > 0 && used + stringWidth(part) > width)) {
        lines.push([]); used = 0;
        if (part === '\n') continue;
      }
      const line = lines.at(-1)!;
      const last = line.at(-1);
      const value = {...segment, text: part, selectionOffset: offset};
      offset += part.length;
      if (last && last.color === value.color && last.bg === value.bg && last.bold === value.bold && last.italic === value.italic && last.selectionKey === value.selectionKey) {
        line[line.length - 1] = {...last, text: last.text + part};
      } else line.push(value);
      used += stringWidth(part);
    }
  }
  return lines;
}

export function createBuilder(width: number, hoveredFoldId: string | null, roles: ActorStyles = cast): RowBuilder {
  const rows: SceneRow[] = [];
  const baseGutterCols = width >= 6 ? 2 : 0;
  const contentWidth = Math.max(1, width - baseGutterCols);
  const topFrame = (): FrameWrap => ({leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: contentWidth});

  const pushBlank = (railColor = '', frame?: FrameWrap, action?: SceneAction) => {
    const f = frame ?? topFrame();
    rows.push({
      messageId: 'spacer-' + rows.length, line: 0, text: '', railColor,
      gutterCols: railColor ? baseGutterCols + f.leftCols : 0,
      softWrap: false, noSelect: true, tone: 'spacer',
      ...(f.bg ? {bg: f.bg} : {}),
      ...(f.bg || f.leftCols || f.rightCols ? {segments: [
        ...f.leftSegments, {text: ' '.repeat(f.innerWidth), ...(f.bg ? {bg: f.bg} : {})}, ...f.rightSegments,
      ]} : {}),
      ...(action ? {action} : {}),
    });
  };

  const pushFramedLine: RowBuilder['pushFramedLine'] = (id, railColor, innerSegments, frame, action, lineBg) => {
    const bg = lineBg ?? frame.bg;
    const wrapped = wrapSegments(innerSegments, frame.innerWidth);
    let offset = 0;
    for (let index = 0; index < wrapped.length; index++) {
      const inner = wrapped[index]!;
      const used = inner.reduce((sum, s) => sum + stringWidth(s.text), 0);
      const segments = [...frame.leftSegments,
        ...inner.map(s => bg && !s.bg ? {...s, bg} : s),
        {text: ' '.repeat(Math.max(0, frame.innerWidth - used)), ...(bg ? {bg} : {})},
        ...frame.rightSegments];
      const selectionCells: ContentCell[] = [];
      let column = 0;
      for (const [partIndex, segment] of segments.entries()) {
        let fieldOffset = segment.selectionOffset ?? offset;
        const key = segment.selectionKey ?? (partIndex >= frame.leftSegments.length && partIndex < frame.leftSegments.length + inner.length ? id : id + ':frame:' + index);
        for (const {segment: glyph} of segmenter.segment(segment.text)) {
          const width = Math.max(1, stringWidth(glyph));
          selectionCells.push({column, width, key, offset: fieldOffset});
          column += width; fieldOffset += glyph.length;
        }
        if (partIndex >= frame.leftSegments.length && partIndex < frame.leftSegments.length + inner.length) offset += segment.text.length;
      }
      rows.push({
        messageId: id, line: index, text: inner.map(s => s.text).join(''), displayText: segments.map(s => s.text).join(''), selectionCells, railColor,
        gutterCols: baseGutterCols + frame.leftCols, softWrap: index < wrapped.length - 1, noSelect: true, tone: 'body',
        ...(bg ? {bg} : {}), segments, ...(action ? {action} : {}),
      });
    }
  };

  const pushTurnHeader: RowBuilder['pushTurnHeader'] = (id, who, origin = '', clock = '') => {
    const railColor = railColorFor(who, roles);
    const name = whoLabel(who, roles);
    const pieces: SceneSegment[] = [{text: name, color: railColor, bold: true, selectionKey: id + ':name', selectionOffset: 0}];
    if (origin) pieces.push({text: '  ' + origin, color: palette.muted});
    const used = pieces.reduce((sum, s) => sum + stringWidth(s.text), 0);
    if (clock && used + stringWidth(clock) + 2 <= contentWidth) pieces.push({text: ' '.repeat(contentWidth - used - stringWidth(clock)) + clock, color: palette.muted});
    pushFramedLine(id, railColor, pieces, topFrame());
  };

  const pushProse: RowBuilder['pushProse'] = (id, text, railColor, tone = 'body', frame, action, color) => {
    const f = frame ?? topFrame();
    let line = 0;
    let sourceStart = 0;
    for (const paragraph of safeText(text).split('\n')) {
      const wrapped = wrapAnsi(paragraph, f.innerWidth, {hard: true, trim: false}).split('\n');
      for (let index = 0; index < wrapped.length; index++) {
        const value = wrapped[index]!;
        const padTail = Math.max(0, f.innerWidth - stringWidth(value));
        rows.push({
          messageId: id, line: line++, text: value, displayText: f.leftSegments.map(s => s.text).join('') + value + (f.bg || f.rightCols ? ' '.repeat(padTail) + f.rightSegments.map(s => s.text).join('') : ''), railColor, gutterCols: baseGutterCols + f.leftCols,
          softWrap: index < wrapped.length - 1, noSelect: false, tone,
          sourceStart, sourceEnd: sourceStart + value.length,
          ...(color ? {color} : {}),
          ...(f.bg ? {bg: f.bg} : {}),
          ...(f.leftCols ? {prefixSegments: f.leftSegments} : {}),
          ...(f.bg || f.rightCols ? {suffixSegments: [
            {text: ' '.repeat(padTail), ...(f.bg ? {bg: f.bg} : {})}, ...f.rightSegments,
          ]} : {}),
          ...(action ? {action} : {}),
        });
        sourceStart += value.length;
      }
      sourceStart++;
    }
  };

  const pushMarkdown: RowBuilder['pushMarkdown'] = (id, text, railColor, frame) => {
    const f = frame ?? topFrame();
    for (const [line, value] of layoutMarkdown(text, f.innerWidth).entries()) {
      rows.push({messageId: id, line, text: value.text, displayText: f.leftSegments.map(s => s.text).join('') + value.text + (f.bg || f.rightCols ? ' '.repeat(Math.max(0, f.innerWidth - stringWidth(value.text))) + f.rightSegments.map(s => s.text).join('') : ''), railColor, gutterCols: baseGutterCols + f.leftCols,
        softWrap: value.softWrap, noSelect: Boolean(value.noSelect), tone: 'body', sourceText: text,
        sourceStart: value.start, sourceEnd: value.end, sourceCells: value.cells,
        ...(value.sourceBlock ? {sourceBlock: value.sourceBlock} : {}),
        ...(f.bg ? {bg: f.bg} : {}),
        ...(f.leftCols ? {prefixSegments: f.leftSegments} : {}),
        ...(f.bg || f.rightCols ? {suffixSegments: [{text: ' '.repeat(Math.max(0, f.innerWidth - stringWidth(value.text))), ...(f.bg ? {bg: f.bg} : {})}, ...f.rightSegments]} : {}),
        segments: [...f.leftSegments, ...value.pieces.map(piece => ({text: piece.text,
          ...(piece.bold ? {bold: true} : {}), ...(piece.italic ? {italic: true} : {}),
          color: piece.muted ? palette.muted : piece.code ? railColor : palette.fg})),
          ...(f.bg || f.rightCols ? [{text: ' '.repeat(Math.max(0, f.innerWidth - stringWidth(value.text)))}, ...f.rightSegments] : [])],
      });
    }
  };

  const pushCardCap: RowBuilder['pushCardCap'] = (id, edge, cardBg, railColor, parentFrame, action) => {
    const pf = parentFrame ?? topFrame();
    // 顶部 ▄（U+2584，上 1/2 透明 + 下 1/2 卡色）与底部 ▀（U+2580，上 1/2 卡色 + 下 1/2 透明）对称，上下各 0.5 行内边距，卡片视觉总高恰好 2 行
    const glyph = edge === 'top' ? '▄' : '▀';
    const segment: SceneSegment = !cardBg ? {text: ' '.repeat(pf.innerWidth)} : {text: glyph.repeat(pf.innerWidth), color: cardBg};
    pushFramedLine(id, railColor, [segment], pf, action);
  };

  const pushCardHeader: RowBuilder['pushCardHeader'] = (id, label, title, status, frame, railColor, action, statusTint = palette.muted, textTint = palette.fg, textBold = false) => {
    label = label.map((segment, index) => ({...segment, selectionKey: id + ':label:' + index, selectionOffset: 0}));
    const titleSegment = {text: title, color: textTint, bold: textBold, selectionKey: id + ':title', selectionOffset: 0};
    const statusSegment = {text: status, color: statusTint, selectionKey: id + ':status', selectionOffset: 0};
    const labelW = label.reduce((sum, s) => sum + stringWidth(s.text), 0);
    const statusW = stringWidth(status);
    const titleW = stringWidth(title);
    const separator = title ? ' · ' : '';
    const used = labelW + stringWidth(separator) + titleW;
    if (used + statusW + (status ? 1 : 0) <= frame.innerWidth) {
      pushFramedLine(id, railColor, [
        ...label,
        {text: separator, color: palette.muted},
        titleSegment,
        {text: ' '.repeat(Math.max(0, frame.innerWidth - used - statusW))},
        statusSegment,
      ], frame, action);
      return;
    }
    // Keep identity and status visible; the complete task gets its own wrapped rows.
    const header = [...label];
    if (labelW + statusW + 1 <= frame.innerWidth) {
      header.push({text: ' '.repeat(frame.innerWidth - labelW - statusW)}, statusSegment);
      pushFramedLine(id, railColor, header, frame, action);
    } else {
      pushFramedLine(id, railColor, header, frame, action);
      if (status) pushFramedLine(id + '-status', railColor, [statusSegment], frame, action);
    }
    if (title) pushFramedLine(id + '-task', railColor, [titleSegment], frame, action);
  };

  const pushOrdinaryCard: RowBuilder['pushOrdinaryCard'] = opts => {
    const pf = opts.parentFrame ?? topFrame();
    const isDream = opts.kind === '入梦';
    const firstRow = rows.length;
    const bright = opts.open || hoveredFoldId === opts.id;
    const simple = opts.kind === '思考' || opts.kind === 'Thinking' || opts.kind === '工具调用';
    const cardBg = isDream ? (bright ? palette.dreamExpanded : palette.dreamCollapsed) : opts.open && simple ? palette.toolExpanded : pf.bg;
    const frame = insetFrame(pf, cardBg);
    const action: SceneAction = {kind: 'toggle_fold', foldId: opts.id};
    if (isDream) {
      pushCardCap(opts.id + '-top', 'top', cardBg, opts.railColor, pf, action);
    }
    const highlightColor = isDream
      ? palette.dreamText
      : opts.ownerId && opts.ownerId !== 'anamnesis'
        ? railColorFor(opts.ownerId, roles)
        : opts.railColor || palette.accent;
    const labelColor = opts.toneColor ?? (isDream ? palette.dreamText : bright ? highlightColor : palette.muted);
    const titleColor = opts.toneColor ?? (simple ? hoveredFoldId === opts.id ? highlightColor : palette.muted : isDream ? palette.dreamText : bright ? highlightColor : palette.fg);
    if (simple) {
      const thinking = opts.kind !== '工具调用';
      const terminal = opts.step && ['completed', 'failed', 'cancelled'].includes(opts.step.state);
      const title = thinking ? terminal ? 'Thought for' : 'Thinking...' : opts.title;
      const status = thinking ? (opts.step ? thinkingDuration(opts.step, Date.now()) : '') : opts.step ? stepStatus(opts.step, Date.now()) : opts.status ?? '';
      const icon = thinking && opts.step ? stepIcon(opts.step, Date.now(), false) : '▮';
      const fault = opts.step?.disposition === 'denied' ? 'Denied' : opts.step?.disposition === 'error' || opts.step?.state === 'failed' ? 'Error' : '';
      pushFramedLine(opts.id, opts.railColor, [
        {text: icon + ' ', color: fault ? palette.error : thinking && opts.step && !terminal ? highlightColor : palette.muted, selectionKey: opts.id + ':icon', selectionOffset: 0},
        {text: title, color: titleColor, selectionKey: opts.id + ':title', selectionOffset: 0},
        {text: status ? thinking ? terminal ? ' ' : ' · ' : '  ' : ''},
        {text: status, color: palette.muted, selectionKey: opts.id + ':status', selectionOffset: 0},
        ...(thinking ? [{text: ' · ' + (opts.tokens ?? 0) + ' Tokens' + (opts.step?.state === 'waiting' ? ' · ' + (opts.step.waiting ?? '等待中') : ''), color: palette.muted, selectionKey: opts.id + ':tokens', selectionOffset: 0}] : []),
        ...(fault ? [{text: '  ' + fault, color: palette.error, bold: true, selectionKey: opts.id + ':fault', selectionOffset: 0}] : []),
      ], frame, action);
      if (opts.step) for (let index = firstRow; index < rows.length; index++) {
        const row = rows[index]!;
        rows[index] = {...row, animation: {step: opts.step, thinking, highlighted: hoveredFoldId === opts.id, actorColor: highlightColor}};
      }
    } else pushCardHeader(opts.id, [{text: opts.kind, color: labelColor, bold: isDream}],
      opts.title, opts.status ?? '', frame, opts.railColor, action,
      isDream ? palette.dreamMuted : statusColor(opts.status ?? '', highlightColor), titleColor, false);
    if (opts.open) {
      opts.bodyLines.forEach((text, index) => pushProse(opts.id + '-body-' + index, text, opts.railColor, opts.kind === '工具调用' ? 'direction' : 'body', frame, action, opts.toneColor ?? (isDream ? palette.dreamText : undefined)));
      opts.renderBody?.(frame);
    }
    if (isDream) {
      pushCardCap(opts.id + '-bottom', 'bottom', cardBg, opts.railColor, pf, action);
    }
    for (let index = firstRow; index < rows.length; index++) {
      const row = rows[index]!;
      const startCol = opts.open || isDream ? baseGutterCols + pf.leftCols : row.gutterCols;
      const titleCells = row.selectionCells?.filter(cell => cell.key === opts.id + ':title' || cell.key === opts.id + ':icon') ?? [];
      const endCol = opts.open || isDream ? width - pf.rightCols : simple ? baseGutterCols + Math.max(startCol - baseGutterCols, ...titleCells.map(cell => cell.column + cell.width)) : row.gutterCols + stringWidth(row.text.trimEnd());
      rows[index] = {...row, hits: [...row.hits ?? [], {startCol, endCol, action}],
        ...(!opts.open ? {hover: {foldId: opts.id, startCol, endCol}} : {})};
    }
  };

  return {rows, width, baseGutterCols, contentWidth, hoveredFoldId, pushBlank, pushTurnHeader, pushProse, pushMarkdown, pushFramedLine, pushCardCap, pushCardHeader, pushOrdinaryCard};
}

function markHover(rows: SceneRow[], start: number, foldId: string, startCol: number, endCol: number) {
  for (let index = start; index < rows.length; index++) {
    rows[index] = {...rows[index]!, hover: {foldId, startCol, endCol}};
  }
}

export function actionAt(row: SceneRow | undefined, x: number): SceneAction | undefined {
  const control = row?.controls?.find(item => x >= item.startCol && x < item.endCol);
  if (control) return control.disabled ? undefined : control.action;
  if (row?.hits) return row.hits.find(hit => x >= hit.startCol && x < hit.endCol)?.action;
  return row?.action;
}

export function hoveredCardAt(row: SceneRow | undefined, x: number): string | null {
  return row?.hover && x >= row.hover.startCol && x < row.hover.endCol ? row.hover.foldId : null;
}

function appendOption(builder: RowBuilder, id: string, label: string, description: string, checked: boolean, frame: FrameWrap, railColor: string, actorColor: string, action: SceneAction) {
  const style = choiceStyle(checked, actorColor);
  builder.pushFramedLine(id, railColor, [
    {text: style.marker, color: style.color, bold: checked},
    {text: label, color: style.color, bold: checked},
  ], frame, action);
  if (description) builder.pushProse(id + '-description', description, railColor, 'body', insetFrame(frame, frame.bg, style.indent, 0), action, style.descriptionColor);
}

function appendInteractionActions(builder: RowBuilder, id: string, frame: FrameWrap, railColor: string, actorColor: string, kind: 'confirm_permission' | 'confirm_style') {
  const action: SceneAction = {kind, foldId: id};
  const confirm: SceneSegment = {text: 'Enter 确认', color: actorColor, bold: true};
  const later: SceneSegment = {text: 'Esc 稍后', color: palette.muted};
  if (frame.innerWidth >= stringWidth(confirm.text + '    ' + later.text)) {
    builder.pushFramedLine(id + '-actions', railColor, [confirm, {text: '    '}, later], frame, action);
  } else {
    builder.pushFramedLine(id + '-actions', railColor, [confirm], frame, action);
    builder.pushFramedLine(id + '-later', railColor, [later], frame, {kind: 'later', foldId: id});
  }
}

function appendPermissionInteraction(builder: RowBuilder, state: DemoSceneState, railColor: string, frame: FrameWrap, actorColor: string, foldId: string) {
  if (state.runtime && state.runtime.permissionRequest?.status !== 'pending' && !state.permission) {
    builder.pushProse(foldId + '-perm-state', state.runtime.permissionRequest?.status === 'cancelled' || state.runtime.techne === 'cancelled' ? '许可已取消，未执行修改。' : '当前没有待回答的许可请求。', railColor, 'body', frame);
    return;
  }
  if (state.permission) {
    builder.pushOrdinaryCard({id: 'permission-done-' + foldId, ownerId: 'techne', kind: '权限', title: '修改文件许可', bodyLines: [state.permission === 'allow' ? '你已允许本次修改。' : '你已拒绝本次修改，保留建议。'], status: '已回答', open: isFoldOpen(state, 'permission-done-' + foldId, false), railColor, parentFrame: frame});
    return;
  }
  builder.pushFramedLine(foldId + '-perm-rule', railColor, [{text: '─'.repeat(frame.innerWidth), color: mixHex(actorColor, frame.bg, 0.25)}], frame);
  if (state.runtime) builder.pushProse(foldId + '-perm-demo', '演示授权：仅展示方案，不实际修改文件。', railColor, 'direction', frame);
  builder.pushProse(foldId + '-perm-legend', '允许修改这两个文件吗？', railColor, 'body', frame);
  for (const file of ['src/pages/index.tsx:18-34', 'src/styles/home.css:96-112']) builder.pushProse(foldId + '-file-' + file, file, railColor, 'direction', frame);
  appendOption(builder, foldId + '-perm-allow', '允许这一次', '只执行本次首屏布局与留白收敛。', state.permissionChoice === 'allow', frame, railColor, actorColor, {kind: 'select_permission', value: 'allow'});
  appendOption(builder, foldId + '-perm-deny', '不允许', '保留建议，不修改源码文件。', state.permissionChoice === 'deny', frame, railColor, actorColor, {kind: 'select_permission', value: 'deny'});
  appendInteractionActions(builder, foldId, frame, railColor, actorColor, 'confirm_permission');
}

function appendQuestionInteraction(builder: RowBuilder, state: DemoSceneState, railColor: string, frame: FrameWrap, actorColor: string, foldId: string) {
  if (state.runtime && state.runtime.styleRequest?.status !== 'pending' && !state.style) {
    builder.pushProse(foldId + '-style-state', state.runtime.styleRequest?.status === 'cancelled' || state.runtime.kalon === 'cancelled' ? '偏好提问已取消，未生成候选。' : '当前没有待回答的偏好问题。', railColor, 'body', frame);
    return;
  }
  if (state.style) {
    builder.pushOrdinaryCard({id: 'question-done-' + foldId, ownerId: 'kalon', kind: '提问', title: '首页气质', bodyLines: [state.style], status: '已回答', open: isFoldOpen(state, 'question-done-' + foldId, false), railColor, parentFrame: frame});
    return;
  }
  builder.pushFramedLine(foldId + '-style-rule', railColor, [{text: '─'.repeat(frame.innerWidth), color: mixHex(actorColor, frame.bg, 0.25)}], frame);
  builder.pushProse(foldId + '-style-legend', '你希望首页更接近哪种气质？', railColor, 'body', frame);
  const options = [
    {value: 'minimal', label: '克制的文字作品集', desc: '让项目和文字成为重点，装饰少一点。'},
    {value: 'editorial', label: '温暖的编辑部', desc: '用柔和的配色和有阅读感的版式。'},
    {value: 'custom', label: '我有自己的想法', desc: '写下你的偏好。'},
  ] as const;
  for (const opt of options) {
    appendOption(builder, foldId + '-style-' + opt.value, opt.label, opt.desc, state.choice === opt.value, frame, railColor, actorColor, {kind: 'select_style', value: opt.value});
  }
  builder.pushFramedLine(foldId + '-style-custom', railColor, [
    {text: '补充偏好：', color: palette.muted},
    {text: state.custom || '像独立杂志，但不要复古装饰', color: state.custom ? palette.fg : palette.muted},
  ], frame, {kind: 'focus_custom'});
  if (state.customError) builder.pushProse(foldId + '-style-error', '请写下你的想法，或选择一个方向。', railColor, 'body', frame);
  appendInteractionActions(builder, foldId, frame, railColor, actorColor, 'confirm_style');
}


export function appendActorCard(
  builder: RowBuilder,
  opts: {
    id: string;
    owner: string;
    roles?: ActorStyles;
    task: string;
    status: string;
    open: boolean;
    railColor: string;
    active?: boolean;
    stop?: {readonly disabled: boolean; readonly focused: boolean; readonly hovered: boolean};
    renderBody(frame: FrameWrap, actorColor: string, bodyAction: SceneAction): void;
  },
) {
  const roles: ActorStyles = opts.roles ?? cast;
  const role = roles[opts.owner] ?? {symbol: '◇', name: opts.owner, color: palette.accent};
  const shortStatus = opts.status.split(' · ')[0]!.replace('等待你授权', '待授权').replace('等待你回答', '待回答');
  const firstRow = builder.rows.length;
  const bright = opts.open || builder.hoveredFoldId === opts.id;
  const cardBg = ownerSurface(opts.owner, bright, opts.roles);
  const outerFrame: FrameWrap = {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth};
  const frame = insetFrame(outerFrame, cardBg);
  const action: SceneAction = {kind: 'actor_summary', foldId: opts.id, owner: opts.owner};
  // 上下对称：顶部 ▄（下 1/2 卡色 + 上 1/2 透明）与底部 ▀（上 1/2 卡色 + 下 1/2 透明）
  builder.pushCardCap(opts.id + '-top', 'top', cardBg, opts.railColor, outerFrame, action);
  builder.pushCardHeader(
    opts.id,
    [{text: role.symbol + ' ' + role.name, color: role.color, bold: true}],
    opts.task,
    shortStatus + (opts.stop ? opts.stop.disabled ? ' · 停止中…' : ' · ■ 停止' : ''),
    frame,
    opts.railColor,
    action,
    statusColor(shortStatus, role.color),
    bright ? role.color : palette.fg,
    false,
  );
  if (opts.stop) {
    const label = opts.stop.disabled ? '停止中…' : '■ 停止';
    for (let index = firstRow; index < builder.rows.length; index++) {
      const row = builder.rows[index]!, at = row.text.lastIndexOf(label);
      if (at < 0) continue;
      const startCol = row.gutterCols + stringWidth(row.text.slice(0, at));
      const tint = opts.stop.focused || opts.stop.hovered ? role.color : palette.muted;
      const segments = row.segments?.flatMap(segment => {
        // The status is a dedicated segment; only its stop label uses focus color.
        if (!segment.text.includes(label)) return [segment];
        const split = segment.text.lastIndexOf(label);
        return [{...segment, text: segment.text.slice(0, split)}, {...segment, text: label, color: tint, bold: Boolean(opts.stop?.focused)},
          {...segment, text: segment.text.slice(split + label.length)}];
      });
      builder.rows[index] = {...row, ...(segments ? {segments} : {}), controls: [{startCol, endCol: startCol + stringWidth(label),
        action: {kind: 'stop_actor', foldId: opts.id, owner: opts.owner}, disabled: opts.stop.disabled}]};
    }
  }
  if (opts.open) {
    opts.renderBody(frame, role.color, action);
  }
  builder.pushCardCap(opts.id + '-bottom', 'bottom', cardBg, opts.railColor, outerFrame, action);
  for (let index = firstRow; index < builder.rows.length; index++) {
    const row = builder.rows[index]!;
    builder.rows[index] = {...row, hits: [...row.hits ?? [], {startCol: builder.baseGutterCols, endCol: builder.width, action}],
      animation: {...row.animation, ...(cardBg ? {actorBg: cardBg} : {}), actorColor: role.color, active: opts.active ?? false}};
  }
  if (!opts.open) markHover(builder.rows, firstRow, opts.id, builder.baseGutterCols, builder.width);
}

export function buildDemoSceneRows(state: DemoSceneState, width: number, hoveredFoldId: string | null = null): readonly SceneRow[] {
  const builder = createBuilder(width, hoveredFoldId);
  if (state.view !== 'logox') {
    return buildActorHistoryRows(builder, state, state.view);
  }
  const logoxRail = palette.accent;

  // Turn 1: User
  builder.pushTurnHeader('main-user-turn', 'user');
  builder.pushProse('main-user', '保留项目内容，让它更像一个有审美的开发者作品，少一点模板感。', palette.user, 'body');
  builder.pushBlank();

  // Turn 2: Logox + borderless filled cards with compact sub-row gaps and generous internal margins
  builder.pushTurnHeader('main-logox-turn', 'logox', '执导者');
  builder.pushProse(
    'main-reply',
    '先剥离症结，再动筋骨，最后点染神韵。Aletheia 先去摸清源码坐标，Techne 据此重构首屏骨架，Kalon 最后校准字距、色彩与呼吸感。',
    logoxRail,
    'body',
  );

  builder.pushOrdinaryCard({
    id: 'main-thinking',
    ownerId: 'logox',
    kind: '思考',
    title: '先确认信息层级',
    bodyLines: ['项目底子并不单薄，病灶在于各处元素都在争抢第一视线。先收束秩序，不必推倒重来。'],
    status: '已结束',
    open: isFoldOpen(state, 'main-thinking', false),
    railColor: logoxRail,
  });

  builder.pushOrdinaryCard({
    id: 'main-tool',
    ownerId: 'logox',
    kind: '工具调用',
    title: 'Read · package.json',
    bodyLines: ['确认首页入口与构建工具链配置。'],
    status: '已完成',
    open: isFoldOpen(state, 'main-tool', false),
    railColor: logoxRail,
  });

  // Actor 1: Aletheia
  appendActorCard(builder, {
    id: 'main-aletheia',
    owner: 'aletheia',
    task: demoRoles.aletheia.task,
    status: '已完成 · 读取 3 个文件',
    open: isFoldOpen(state, 'main-aletheia', false),
    railColor: demoRoles.aletheia.color,
    renderBody(frame, _actorColor, bodyAction) {
      builder.pushProse('main-aletheia-dir', '（翻看刚读完的三份源码）', demoRoles.aletheia.color, 'direction', frame, bodyAction);
      builder.pushProse(
        'main-aletheia-prose',
        '三处问题位置都标出来了：首屏三个元素在抢视觉重心，窄屏下还有三层多余的嵌套内边距。坐标已经发给 Techne，视觉细节留给 Kalon 收尾。',
        demoRoles.aletheia.color,
        'body',
        frame,
        bodyAction,
      );
      builder.pushOrdinaryCard({
        id: 'main-aletheia-reads',
        ownerId: 'aletheia',
        kind: '工具调用',
        title: 'Read · 3 个首页相关文件',
        bodyLines: [
          'src/pages/index.tsx:18             首屏标题、标签组与按钮字重同级，焦点分散',
          'src/components/ProjectCard.tsx:42  项目简介重复首屏第三行导语',
          'src/styles/home.css:96             移动端三层容器留白叠加至 48px',
        ],
        status: '已完成',
        open: isFoldOpen(state, 'main-aletheia-reads', false),
        railColor: demoRoles.aletheia.color,
        parentFrame: frame,
      });
    },
  });

  // Actor 2: Techne
  const tStatus = portfolioTaskStatus(state, 'techne');
  appendActorCard(builder, {
    id: 'main-techne',
    owner: 'techne',
    task: demoRoles.techne.task,
    status: tStatus,
    open: isFoldOpen(state, 'main-techne', defaultSceneFoldOpen(state, 'main-techne')),
    railColor: demoRoles.techne.color,
    renderBody(frame, actorColor, bodyAction) {
      builder.pushProse('main-techne-dir', '（核对完行号，把改动范围收在两个文件内）', demoRoles.techne.color, 'direction', frame, bodyAction);
      builder.pushProse(
        'main-techne-prose',
        'Aletheia 给的位置很准。项目文案我不动，只拆掉多余容器、对齐首屏网格——免得一会儿又被 Kalon 嫌像没刷漆的毛坯房。',
        demoRoles.techne.color,
        'body',
        frame,
        bodyAction,
      );
      appendPermissionInteraction(builder, state, demoRoles.techne.color, frame, actorColor, 'main-techne');
      if (state.permission === 'allow') {
        builder.pushOrdinaryCard({
          id: 'main-edit',
          ownerId: 'techne',
          kind: '工具调用',
          title: state.runtime ? '方案 · 布局与样式（未执行）' : 'Edit · 布局与样式',
          bodyLines: [
            'src/pages/index.tsx:18 — 收束首屏主副层级，移除重复导语节点',
            state.runtime ? 'src/styles/home.css:96 — 建议合并窄屏嵌套留白（48px → 18px），尚未执行验证' : 'src/styles/home.css:96 — 合并窄屏嵌套留白（48px → 18px），网格断言通过',
          ],
          status: '已完成',
          open: isFoldOpen(state, 'main-edit', false),
          railColor: demoRoles.techne.color,
          parentFrame: frame,
        });
      }
    },
  });

  // Actor 3: Kalon
  const kalonReady = state.runtime ? state.runtime.kalon !== 'queued' : Boolean(state.permission);
  const kStatus = portfolioTaskStatus(state, 'kalon');
  appendActorCard(builder, {
    id: 'main-kalon',
    owner: 'kalon',
    task: demoRoles.kalon.task,
    status: kStatus,
    open: isFoldOpen(state, 'main-kalon', defaultSceneFoldOpen(state, 'main-kalon')),
    railColor: demoRoles.kalon.color,
    renderBody(frame, actorColor, bodyAction) {
      builder.pushProse(
        'main-kalon-dir',
        state.runtime ? '（端详当前首屏的版式方案）' : state.permission ? '（端详着刚改完的首屏版式）' : '（扫了眼首屏当前的样式表）',
        demoRoles.kalon.color,
        'direction',
        frame,
        bodyAction,
      );
      builder.pushProse(
        'main-kalon-prose',
        kalonReady
          ? state.runtime ? '先生，布局方案的许可已收束。接下来定个调吧——首页你更想要哪种感觉？' : '先生，Techne 这回总算把底子收拾干净了。接下来定个调吧——首页你更想要哪种感觉？'
          : '等 Techne 先把布局骨架改利落，我再来调字距、配色和留白。',
        demoRoles.kalon.color,
        'body',
        frame,
        bodyAction,
      );
      if (kalonReady) {
        appendQuestionInteraction(builder, state, demoRoles.kalon.color, frame, actorColor, 'main-kalon');
      }
    },
  });

  if (state.style) {
    builder.pushOrdinaryCard({
      id: 'main-memory',
      ownerId: 'anamnesis',
      kind: '入梦',
      title: 'Anamnesis · 偏好候选',
      bodyLines: [`本轮偏好为「${state.style}」。依据本轮回答，尚未写入长期档案。`],
      status: '待核验',
      open: isFoldOpen(state, 'main-memory', false),
      railColor: logoxRail,
    });
    if (!state.runtime || state.runtime.kalon === 'completed') builder.pushProse('main-finish', '结构与审美校准均已收束完毕。', logoxRail, 'body');
  }
  builder.pushBlank();

  // Dynamic events (e.g. @kalon quick dispatch or follow-up messages)
  for (const event of state.events) {
    if (event.type === 'dispatch' && event.actor && event.text) {
      const role = demoRoles[event.actor];
      builder.pushTurnHeader(`main-user-${event.id}`, 'user', `→ ${role.name} · 在 Logox 中指派`);
      builder.pushProse(`main-user-prose-${event.id}`, event.text, palette.user, 'body');
      builder.pushBlank();

      builder.pushTurnHeader(`main-actor-turn-${event.id}`, event.actor, '快速派发任务');
      appendActorCard(builder, {
        id: `dispatch-${event.id}`,
        owner: event.actor,
        task: event.text.replace(/^@\w+\s*/, ''),
        status: event.status ?? '任务已接收',
        open: isFoldOpen(state, `dispatch-${event.id}`, true),
        railColor: role.color,
        renderBody(frame, _actorColor, bodyAction) {
          if (event.direction) builder.pushProse(`dispatch-dir-${event.id}`, event.direction, role.color, 'direction', frame, bodyAction);
          builder.pushProse(`dispatch-reply-${event.id}`, event.reply || event.error || (event.status && event.status !== '排队中' ? event.status : '任务已接收，等待登场。'), role.color, 'body', frame, bodyAction);
        },
      });
      builder.pushBlank();
    } else if (event.type === 'main' && event.text) {
      builder.pushTurnHeader(`main-user-${event.id}`, 'user');
      builder.pushProse(`main-user-prose-${event.id}`, event.text, palette.user, 'body');
      builder.pushBlank();
      builder.pushTurnHeader(`main-reply-turn-${event.id}`, 'logox', '执导者');
      builder.pushProse(`main-reply-prose-${event.id}`, event.reply || event.error || event.status || '等待登场。', logoxRail, 'body');
      builder.pushBlank();
    }
  }

  for (const activity of state.runtime?.background ?? []) {
    builder.pushOrdinaryCard({id: activity.id, ownerId: 'anamnesis', kind: '入梦', title: activity.title,
      bodyLines: [activity.stage, activity.detail].filter(Boolean), status: activity.status,
      open: isFoldOpen(state, activity.id, false), railColor: logoxRail});
    builder.pushBlank();
  }

  return builder.rows;
}

function buildActorHistoryRows(
  builder: RowBuilder,
  state: DemoSceneState,
  owner: 'aletheia' | 'techne' | 'kalon',
): readonly SceneRow[] {
  const role = demoRoles[owner];
  const actorRail = role.color;
  const outerFrame: FrameWrap = {
    leftSegments: [],
    rightSegments: [],
    leftCols: 0,
    rightCols: 0,
    innerWidth: builder.contentWidth,
  };

  if (owner === 'kalon') {
    builder.pushTurnHeader('kalon-prev-dir-turn', 'logox', `→ ${role.name}`, '上一轮 · 10:02');
    builder.pushProse('kalon-prev-dir', '先只读检查首页配色和信息层级，看看模板感出在哪里。', palette.accent, 'body');
    builder.pushBlank();

    builder.pushTurnHeader('kalon-prev-turn', 'kalon', '审美官', '10:03');
    builder.pushOrdinaryCard({
      id: 'kalon-previous-read',
      kind: '工具调用',
      title: 'Read · src/styles/home.css',
      bodyLines: ['L14-L52：同一高饱和强调色同时涂在标题、卡片描边与按钮上，显得杂乱。'],
      status: '已完成',
      open: isFoldOpen(state, 'kalon-previous-read', false),
      railColor: actorRail,
    });
    builder.pushOrdinaryCard({
      id: 'kalon-previous-thinking',
      kind: '思考',
      title: '收敛表面装饰',
      bodyLines: ['去掉多余的高亮边框，靠字重阶梯与留白立起秩序。'],
      status: '已结束',
      open: isFoldOpen(state, 'kalon-previous-thinking', false),
      railColor: actorRail,
    });
    builder.pushBlank();

    builder.pushTurnHeader('kalon-prev-user-turn', 'user', `→ ${role.name} · 本窗口`, '10:04');
    builder.pushProse('kalon-prev-user', '我喜欢克制的文字作品集，但不希望它冷得像产品文档。', palette.user, 'body');
    builder.pushBlank();

    builder.pushTurnHeader('kalon-prev-reply-turn', 'kalon', '审美官', '10:05');
    builder.pushProse('kalon-prev-reply-dir', '（在色板旁记下一组暖灰参数）', actorRail, 'direction');
    builder.pushProse(
      'kalon-prev-reply',
      '明白。把名字、干净的自述和代表作留在视觉中心，底色调暖半度，强调色只留给真正需要点开的地方。',
      actorRail,
      'body',
    );
    builder.pushBlank();

    builder.pushTurnHeader('kalon-curr-dir-turn', 'logox', `→ ${role.name}`, '当前轮');
    builder.pushProse('kalon-curr-dir', 'Techne 正在按 Aletheia 的坐标改结构。这轮请你收尾字体、颜色和留白，等他的骨架确定后继续。', palette.accent, 'body');
    builder.pushBlank();
  } else if (owner === 'aletheia') {
    builder.pushTurnHeader('aletheia-dir-turn', 'logox', `→ ${role.name}`, '当前轮');
    builder.pushProse('aletheia-dir', '摸清首页的层级症结、重复内容和移动端留白，给出精确到行号的坐标。', palette.accent, 'body');
    builder.pushBlank();

    builder.pushTurnHeader('aletheia-work-turn', 'aletheia', '侦察者', '当前轮');
    const paths = ['src/pages/index.tsx:18', 'src/components/ProjectCard.tsx:42', 'src/styles/home.css:96'];
    const notes = [
      'L18-L34：h1、.tag-list 与 .cta-btn 字重与对比度同级，首屏无主次。',
      'L42-L58：项目卡片副标题原样复述了首屏导语。',
      'L96-L112：@media (max-width: 560px) 三层容器内边距叠加至 48px。',
    ];
    for (let i = 0; i < paths.length; ++i) {
      builder.pushOrdinaryCard({
        id: `aletheia-read-${i}`,
        ownerId: 'aletheia',
        kind: '工具调用',
        title: `Read · ${paths[i]}`,
        bodyLines: [notes[i]!],
        status: '已完成',
        open: isFoldOpen(state, `aletheia-read-${i}`, false),
        railColor: actorRail,
      });
    }
    builder.pushProse('aletheia-dir-line', '（整理好三处定位记录）', actorRail, 'direction');
    builder.pushProse(
      'aletheia-reply',
      '三处问题的源码坐标已核实完毕（index.tsx:18、ProjectCard.tsx:42、home.css:96），已移交 Logox 与 Techne。',
      actorRail,
      'body',
    );
    builder.pushBlank();
  } else {
    builder.pushTurnHeader('techne-dir-turn', 'logox', `→ ${role.name}`, '当前轮');
    builder.pushProse('techne-dir', '按 Aletheia 给出的精确坐标调整首屏骨架，保留用户原有的项目内容。', palette.accent, 'body');
    builder.pushBlank();

    builder.pushTurnHeader('techne-work-turn', 'techne', '向用户请求修改许可', '当前轮');
    builder.pushOrdinaryCard({
      id: 'techne-read',
      ownerId: 'techne',
      kind: '工具调用',
      title: 'Read · src/pages/index.tsx:18',
      bodyLines: ['核对 L18-L34 组件树与样式引用，确认修改切口无外部副作用。'],
      status: '已完成',
      open: isFoldOpen(state, 'techne-read', false),
      railColor: actorRail,
    });
    builder.pushOrdinaryCard({
      id: 'techne-thinking',
      ownerId: 'techne',
      kind: '思考',
      title: '缩小修改范围',
      bodyLines: ['只动结构咬合与响应式内边距，切口严格控制在两处文件以内。'],
      status: '已结束',
      open: isFoldOpen(state, 'techne-thinking', false),
      railColor: actorRail,
    });
    const permOpen = isFoldOpen(state, 'history-techne-question', defaultSceneFoldOpen(state, 'history-techne-question'));
    if (state.permission || !permOpen) {
      builder.pushOrdinaryCard({
        id: 'history-techne-question',
        ownerId: 'techne',
        kind: '权限',
        title: '允许修改文件',
        bodyLines: [state.permission ? '本次许可已回答，裁决记录保留在下方。' : '展开卡片以回答修改许可。'],
        status: state.permission ? '已回答' : state.runtime?.permissionRequest?.status === 'cancelled' ? '已取消' : '等待回答',
        open: permOpen,
        railColor: actorRail,
      });
    } else {
      const cardBg = actorCardPalette.techne.open;
      const histFrame: FrameWrap = {
        leftSegments: [],
        rightSegments: [],
        leftCols: 0,
        rightCols: 0,
        innerWidth: builder.contentWidth,
        bg: cardBg,
      };
      builder.pushCardCap('history-techne-question-top', 'top', cardBg, actorRail, outerFrame);
      appendPermissionInteraction(builder, state, actorRail, insetFrame(histFrame, cardBg), actorRail, 'history-techne-question');
      builder.pushCardCap('history-techne-question-bottom', 'bottom', cardBg, actorRail, outerFrame);
    }
    builder.pushBlank();
  }

  if (owner === 'kalon' && state.runtime?.styleRequest && !state.permission) {
    appendQuestionInteraction(builder, state, actorRail, outerFrame, actorRail, 'history-kalon-question');
    builder.pushBlank();
  }
  for (const event of state.events) {
    if ((event.type === 'dispatch' || event.type === 'direct') && event.actor === owner && event.text) {
      const origin = event.type === 'dispatch' ? `→ ${role.name} · 来源 Logox 窗口 @${owner}` : `→ ${role.name} · 本窗口`;
      builder.pushTurnHeader(`hist-user-${event.id}`, 'user', origin);
      builder.pushProse(`hist-user-prose-${event.id}`, event.text, palette.user, 'body');
      builder.pushBlank();

      builder.pushTurnHeader(`hist-actor-${event.id}`, owner);
      if (event.direction) builder.pushProse(`hist-actor-dir-${event.id}`, event.direction, actorRail, 'direction');
      builder.pushProse(`hist-actor-reply-${event.id}`, event.reply || event.error || event.status || '等待登场。', actorRail, 'body');
      if (event.reply && event.status && event.status !== '已完成') builder.pushProse(`hist-actor-state-${event.id}`, event.status, actorRail, 'direction');
      builder.pushBlank();
    } else if (event.type === 'permission' && owner === 'techne') {
      builder.pushTurnHeader(`hist-perm-user-${event.id}`, 'user', `→ Techne · ${event.from || '裁决'}`);
      builder.pushProse(`hist-perm-user-prose-${event.id}`, event.value === 'allow' ? '允许这一次修改。' : '不允许修改文件。', palette.user, 'body');
      builder.pushBlank();

      builder.pushTurnHeader(`hist-perm-techne-${event.id}`, 'techne');
      if (event.value === 'allow') {
        builder.pushOrdinaryCard({
          id: `techne-edit-${event.id}`,
          kind: '工具调用',
          title: state.runtime ? '方案 · 布局与样式（未执行）' : 'Edit · 布局与样式',
          bodyLines: ['src/pages/index.tsx:18：收束首屏主副层级。src/styles/home.css:96：合并窄屏嵌套留白。'],
          status: '已完成',
          open: isFoldOpen(state, `techne-edit-${event.id}`, false),
          railColor: actorRail,
        });
        builder.pushProse(`hist-perm-dir-${event.id}`, state.runtime ? '（记下本次演示许可）' : '（确认布局测试全部通过）', actorRail, 'direction');
      } else {
        builder.pushProse(`hist-perm-dir-${event.id}`, '（保留原文件未改动）', actorRail, 'direction');
      }
      builder.pushProse(
        `hist-perm-reply-${event.id}`,
        event.value === 'allow' ? state.runtime ? '演示方案已获许可；没有实际修改文件，交由 Kalon 继续确认偏好。' : '结构已改好，留白余量按要求对齐，交由 Kalon 调整视觉细节。' : '文件未动，结构调整方案已附在建议里交给 Kalon。',
        actorRail,
        'body',
      );
      builder.pushBlank();
    } else if (event.type === 'permission' && owner === 'kalon') {
      builder.pushTurnHeader(`hist-handoff-${event.id}`, 'logox', `→ ${role.name}`);
      builder.pushProse(
        `hist-handoff-prose-${event.id}`,
        event.value === 'allow' ? state.runtime ? '布局演示方案已获许可，请继续确认审美偏好。' : 'Techne 已完成首屏骨架修改，继续你的审美校准。' : '用户选择暂不改动源码文件，请继续给出只读审美诊断。',
        palette.accent,
        'body',
      );
      builder.pushBlank();

      builder.pushTurnHeader(`hist-kalon-q-${event.id}`, 'kalon', '向用户询问首页气质');
      const qOpen = isFoldOpen(state, 'history-kalon-question', defaultSceneFoldOpen(state, 'history-kalon-question'));
      if (state.style || !qOpen) {
        builder.pushOrdinaryCard({
          id: 'history-kalon-question',
          kind: '提问',
          title: '你希望首页更接近哪种气质？',
          bodyLines: [state.style ? '本次提问已回答，用户偏好保留在下方。' : '展开卡片以回答首页气质偏好。'],
          status: state.style ? '已回答' : state.runtime?.styleRequest?.status === 'cancelled' ? '已取消' : '等待回答',
          open: qOpen,
          railColor: actorRail,
        });
      } else {
        const cardBg = actorCardPalette.kalon.open;
        const histFrame: FrameWrap = {
          leftSegments: [],
          rightSegments: [],
          leftCols: 0,
          rightCols: 0,
          innerWidth: builder.contentWidth,
          bg: cardBg,
        };
        builder.pushCardCap('history-kalon-question-top', 'top', cardBg, actorRail, outerFrame);
        appendQuestionInteraction(builder, state, actorRail, insetFrame(histFrame, cardBg), actorRail, 'history-kalon-question');
        builder.pushCardCap('history-kalon-question-bottom', 'bottom', cardBg, actorRail, outerFrame);
      }
      builder.pushBlank();
    } else if (event.type === 'style' && owner === 'kalon' && event.text) {
      builder.pushTurnHeader(`hist-style-user-${event.id}`, 'user', `→ Kalon · ${event.from || '回答'}`);
      builder.pushProse(`hist-style-user-prose-${event.id}`, event.text, palette.user, 'body');
      builder.pushBlank();

      builder.pushTurnHeader(`hist-style-kalon-${event.id}`, 'kalon');
      builder.pushProse(`hist-style-dir-${event.id}`, state.runtime ? '（记下选定的字距与留白方向）' : '（按选定方向微调完字距与留白比例）', actorRail, 'direction');
      builder.pushProse(
        `hist-style-reply-${event.id}`,
        state.runtime ? `「${event.text}」已整理为候选；页面和长期档案尚未写入。` : `已按「${event.text}」把字体、配色与留白比例调到位，交给先生过目。`,
        actorRail,
        'body',
      );
      builder.pushBlank();
    }
  }

  return builder.rows;
}
