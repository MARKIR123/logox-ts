import {randomUUID} from 'node:crypto';
import {readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {withFileLock} from '../store/file-lock.js';

import {shellWords, shellImpact, shellCommands} from './shell.js';
import {isScratchpadPath} from '../kernel/scratchpad.js';
export {shellWords} from './shell.js';
export const permissionModeSchema = z.enum(['default', 'auto', 'creative']);
export const permissionRuleSchema = z.strictObject({
  id: z.string().min(1), scope: z.enum(['session', 'project']), decision: z.enum(['allow', 'deny']),
  tool: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]*$/), pattern: z.string().min(1).max(2000),
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export interface PermissionTarget {tool: string; paths: readonly string[]; risky: boolean; command?: string; effect?: 'read' | 'write' | 'unknown'; danger?: string}
function globMatch(pattern: string, value: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {source += '.*'; i++;}
    else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$', process.platform === 'win32' ? 'i' : '').test(value.replaceAll('\\', '/'));
}
export class PermissionEngine {
  private rules: PermissionRule[] = [];
  private scratchpadDir?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}
  private changed(): void {for (const listener of this.listeners) listener();}
  setScratchpadDir(dir: string): void {this.scratchpadDir = dir;}
  constructor(readonly root: string, public mode: PermissionMode = 'default', private readonly file = join(root, '.logox', 'permissions.json')) {}
  private async readProject() {
    let raw: string;
    try {raw = await readFile(this.file, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    const saved = z.strictObject({root: z.string(), mode: permissionModeSchema.optional(), rules: z.array(permissionRuleSchema)}).parse(JSON.parse(raw));
    if (saved.root !== await realpath(this.root) || saved.rules.some(rule => rule.scope !== 'project')) throw new Error('权限文件项目身份不符');
    if (new Set(saved.rules.map(rule => rule.id)).size !== saved.rules.length) throw new Error('权限规则 ID 重复，原文件保留');
    return saved;
  }
  async load(): Promise<void> {
    const saved = await this.readProject();
    this.rules = [...this.rules.filter(rule => rule.scope === 'session'), ...saved?.rules ?? []];
    if (saved?.mode) this.mode = saved.mode;
  }
  snapshot(): readonly PermissionRule[] {return this.rules.map(rule => ({...rule}));}
  private update(change: (rules: PermissionRule[]) => PermissionRule[], project: boolean, mode?: PermissionMode): Promise<void> {
    const operation = this.queue.then(async () => {
      if (!project) {this.rules = change(this.rules); this.changed(); return;}
      await withFileLock(this.file, async () => {
        const saved = await this.readProject();
        const current = [...this.rules.filter(rule => rule.scope === 'session'), ...saved?.rules ?? []];
        const next = change(current);
        const rules = next.filter(rule => rule.scope === 'project');
        const nextMode = mode ?? saved?.mode ?? this.mode;
        if (mode !== undefined || JSON.stringify(rules) !== JSON.stringify(saved?.rules ?? [])) {
          const temporary = this.file + '.' + randomUUID() + '.tmp';
          try {
            await writeFile(temporary, JSON.stringify({root: await realpath(this.root), mode: nextMode, rules}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
            await rename(temporary, this.file);
          } finally {await rm(temporary, {force: true});}
        }
        this.rules = next;
        this.mode = nextMode;
      });
      this.changed();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async add(input: Omit<PermissionRule, 'id'>): Promise<PermissionRule> {
    const rule = permissionRuleSchema.parse({...input, id: randomUUID()});
    if (rule.tool === 'shell' && rule.pattern !== '*') {
      const parsed = shellWords(rule.pattern);
      if (parsed.compound || parsed.dynamic) throw new Error('Shell 规则必须是静态词元前缀');
    }
    await this.update(rules => [...rules, rule], rule.scope === 'project');
    return rule;
  }
  async setMode(mode: PermissionMode): Promise<void> {
    await this.update(rules => rules, true, permissionModeSchema.parse(mode));
  }
  clearSession(): void {this.rules = this.rules.filter(rule => rule.scope !== 'session');}
  async revoke(id: string): Promise<void> {
    await this.update(rules => {if (!rules.some(rule => rule.id === id)) throw new Error('权限规则不存在'); return rules.filter(rule => rule.id !== id);}, !this.rules.some(rule => rule.id === id && rule.scope === 'session'));
  }
  evaluate(target: PermissionTarget): {decision: 'allow' | 'deny' | 'ask' | 'review'; reason: string} {
    const shell = target.command === undefined ? undefined : shellWords(target.command);
    const impact = target.command === undefined ? undefined : shellImpact(target.command, 0, this.root);
    if (impact?.kind === 'forbidden') return {decision: 'deny', reason: impact.reason};
    const matches = (rule: PermissionRule) => (rule.tool === target.tool || target.tool.startsWith(rule.tool + ':')) && (rule.pattern === '*' || (shell
      ? (() => {
        if (rule.decision === 'allow' && (shell.compound || shell.dynamic)) return false;
        const prefix = shellWords(rule.pattern).words;
        return shellCommands(target.command!).some(command => {const words = shellWords(command).words;
          return prefix.every((word, i) => word.toLowerCase() === words[i]?.toLowerCase());});
      })()
      : target.paths.some(path => globMatch(rule.pattern, path))));
    if (this.rules.some(rule => rule.decision === 'deny' && matches(rule))) return {decision: 'deny', reason: '命中显式拒绝规则'};
    if (this.scratchpadDir && target.paths.length > 0 && target.paths.every(p => isScratchpadPath(p, this.scratchpadDir!))) {
      return {decision: 'allow', reason: 'Scratchpad directory is allowed for temporary operations'};
    }
    const danger = target.danger ?? (impact?.kind === 'danger' ? impact.reason : undefined);
    if (danger) return {decision: this.mode === 'creative' ? 'deny' : 'ask', reason: danger};
    if (this.rules.some(rule => rule.decision === 'allow' && matches(rule))) return {decision: 'allow', reason: '命中允许规则'};
    if (this.mode === 'creative') return {decision: 'allow', reason: 'creative：危险过滤后默认允许'};
    const read = target.effect === 'read' || ['read', 'glob', 'grep', 'ask_user'].includes(target.tool) || impact?.kind === 'safe';
    if (!target.risky && read) return {decision: 'allow', reason: '普通只读操作'};
    if (this.mode === 'auto') {
      if (!target.risky && ['write', 'edit'].includes(target.tool)) return {decision: 'allow', reason: 'auto：项目内常规文件编辑'};
      return {decision: 'review', reason: 'auto：需要独立模型判断实际影响'};
    }
    return {decision: 'ask', reason: target.risky ? '敏感或越界目标需要授权' : 'default：操作尚未授权'};
  }
}
