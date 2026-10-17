import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {commandCatalog} from '../commands.js';
import {parseDocument} from 'yaml';
import {actorIdSchema} from '../actors/definitions.js';

export type ResourceKind = 'guidelines' | 'skills' | 'commands';
export interface ResourceIssue {readonly kind: ResourceKind; readonly path: string; readonly reason: string}
export interface TextResource {readonly path: string; readonly text: string}
export interface SkillResource {readonly name: string; readonly description: string; readonly path: string; readonly actors?: readonly string[]}
export interface CommandResource extends SkillResource {readonly template: string}
export interface ResourceSnapshot {
  readonly guidelines: readonly TextResource[];
  readonly skills: readonly SkillResource[];
  readonly commands: readonly CommandResource[];
  readonly issues: readonly ResourceIssue[];
}
export interface ResourceOptions {home?: string; boundary?: string}
export interface SkillVisibility {readonly actorId: string; readonly skills?: readonly string[]; readonly borrowed?: readonly string[]}
const maxBytes = 64 * 1024;
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const forbidden = (path: string) => path.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy');
function metadata(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  if (match) for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  const body = match ? text.slice(match[0].length).trim() : text.trim();
  return {fields, body, description: (fields.description || body.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '') || '').slice(0, 500)};
}
async function ancestors(cwd: string, boundary?: string) {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const canonicalBoundary = boundary ? await realpath(boundary).catch(() => resolve(boundary)) : undefined;
  const directories: string[] = [];
  let current = canonicalCwd;
  for (;;) {
    directories.unshift(current);
    if (canonicalBoundary && key(current) === key(canonicalBoundary)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}
export class Resources {
  private readonly assignments = new Map<string, Set<string>>();
  private value: ResourceSnapshot = Object.freeze({guidelines: [], skills: [], commands: [], issues: []});
  constructor(readonly cwd: string, readonly options: ResourceOptions = {}) {}
  snapshot(): ResourceSnapshot {return this.value;}
  /** 显式分配只改变此 Resources 实例；借阅由单次任务输入提供，不写分配表。 */
  assignSkill(name: string, actorId: string, assigned = true): void {
    actorIdSchema.parse(actorId);
    if (!this.value.skills.some(skill => skill.name === name)) throw new Error('技能不存在');
    const actors = this.assignments.get(name) ?? new Set<string>();
    if (assigned) actors.add(actorId); else actors.delete(actorId);
    if (actors.size) this.assignments.set(name, actors); else this.assignments.delete(name);
  }
  skillsFor(input: SkillVisibility): readonly SkillResource[] {
    actorIdSchema.parse(input.actorId);
    return Object.freeze(this.value.skills.filter(skill => {
      const explicit = input.skills?.includes(skill.name) || this.assignments.get(skill.name)?.has(input.actorId);
      return explicit || input.borrowed?.includes(skill.name) || skill.actors?.includes(input.actorId)
        || (input.actorId === 'logox' && skill.actors === undefined);
    }));
  }
  prompt(visibility: SkillVisibility = {actorId: 'logox'}): {context: string} {
    const state = this.value;
    const skills = this.skillsFor(visibility);
    return {context: [
      ...state.guidelines.map(item => '项目协作约定：' + item.path + '\n' + item.text),
      ...(skills.length ? ['可用技能（先按路径用 read 读取正文；技能文件不注册工具）：\n' + skills.map(item =>
        JSON.stringify({name: item.name, description: item.description, path: item.path})).join('\n')] : []),
    ].join('\n\n')};
  }
  expand(name: string, args: string): string | undefined {
    const command = this.value.commands.find(item => item.name === name.toLowerCase());
    if (!command) return undefined;
    if (Buffer.byteLength(args) > 16 * 1024 || args.includes('\0')) throw new Error('命令参数超过 16 KiB 或含无效字符');
    // 一次替换，参数中的占位符和 $& 等字符不会再次展开。
    const expanded = command.template.replace(/\{\{\s*args\s*\}\}|\$ARGUMENTS\b|\$args\b/gi, () => args.trim()).trim();
    if (!expanded || Buffer.byteLength(expanded) > maxBytes) throw new Error('命令展开为空或超过 64 KiB');
    return expanded;
  }
  async reload(): Promise<ResourceSnapshot> {
    const issues: ResourceIssue[] = [], seen = new Set<string>();
    const issue = (kind: ResourceKind, path: string, reason: string) => {issues.push(Object.freeze({kind, path, reason}));};
    const read = async (path: string, kind: ResourceKind): Promise<TextResource | undefined> => {
      try {
        if (forbidden(path)) throw new Error('legacy 材料不加载');
        const canonical = await realpath(path);
        if (forbidden(canonical)) throw new Error('legacy 材料不加载');
        if (seen.has(key(canonical))) return undefined;
        const handle = await open(canonical, 'r');
        let bytes: Buffer;
        try {
          if (!(await handle.stat()).isFile()) throw new Error('不是普通文件');
          const buffer = Buffer.alloc(maxBytes + 1);
          let count = 0;
          while (count < buffer.length) {
            const next = await handle.read(buffer, count, buffer.length - count, null);
            if (!next.bytesRead) break; count += next.bytesRead;
          }
          if (count > maxBytes) throw new Error('超过 64 KiB，整份跳过');
          bytes = buffer.subarray(0, count);
        } finally {await handle.close();}
        const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).trim();
        if (!text) return undefined;
        seen.add(key(canonical));
        return Object.freeze({path: canonical, text});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(kind, path, error instanceof Error ? error.message : '读取失败');
        return undefined;
      }
    };
    // 角色人设由角色档案维护；用户目录只提供人工规范、技能与模板。
    const home = this.options.home ?? homedir();
    const userDirs = [join(home, '.logox'), join(home, '.logox-ts')];
    const guidelines: TextResource[] = [];
    let total = 0;
    for (const directory of [join(home, '.logox'), ...await ancestors(this.cwd, this.options.boundary)]) {
      const isUser = directory === join(home, '.logox');
      for (const name of isUser ? ['AGENTS.md', 'CLAUDE.md'] : ['LOGOX.md', 'AGENTS.md', 'CLAUDE.md']) {
        let selected = false;
        const candidatePaths = isUser
          ? [join(home, '.logox-ts', name), join(home, '.logox', name)]
          : [join(directory, name), join(directory, '.logox-ts', name), join(directory, '.logox', name)];
        for (const path of candidatePaths) {
          try {await lstat(path); selected = true;} catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {issue('guidelines', path, '无法检查规范文件'); selected = true;}
          }
          if (!selected) continue;
          const resource = await read(path, 'guidelines');
          if (resource) {
            const size = Buffer.byteLength(resource.text);
            if (total + size <= 128 * 1024) {guidelines.push(resource); total += size;}
            else issue('guidelines', path, '项目规范总量超过 128 KiB，整份跳过');
          }
          break;
        }
        if (selected) break;
      }
    }
    const skills = new Map<string, SkillResource>(), commands = new Map<string, CommandResource>();
    const builtins = new Set<string>(commandCatalog.map(item => item.name));
    for (const root of [...new Set([...userDirs, join(this.cwd, '.logox'), join(this.cwd, '.logox-ts')])]) {
      for (const kind of ['skills', 'commands'] as const) {
        const directory = join(root, kind);
        let entries;
        try {entries = await readdir(directory, {withFileTypes: true});} catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(kind, directory, '目录扫描失败');
          continue;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 256)) {
          let path = join(directory, entry.name);
          if (kind === 'skills') {
            if (!entry.isDirectory() || forbidden(entry.name)) continue;
            path = join(path, 'SKILL.md');
            try {await lstat(path);} catch {path = join(directory, entry.name, 'skill.md');}
          } else if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const resource = await read(path, kind);
          if (!resource) continue;
          const meta = metadata(resource.text);
          const name = (kind === 'skills' ? meta.fields.name || entry.name : entry.name.slice(0, -3)).toLowerCase();
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {issue(kind, path, '名称无效'); continue;}
          if (kind === 'commands' && builtins.has(name)) {issue(kind, path, '与内置命令重名，未加载'); continue;}
          const item = {name, description: meta.description || name, path: resource.path};
          if (kind === 'skills') {
            try {
              const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(resource.text);
              let actors: readonly string[] | undefined;
              if (header) {
                const document = parseDocument(header[1]!, {uniqueKeys: true});
                if (document.errors.length) throw new Error('技能 Frontmatter 无效');
                const fields: unknown = document.toJS({maxAliasCount: 0});
                if (fields && typeof fields === 'object' && Object.hasOwn(fields, 'actors')) {
                  const raw: unknown = (fields as Record<string, unknown>).actors;
                  if (!Array.isArray(raw) || raw.length > 256) throw new Error('actors 必须是角色 ID 列表');
                  actors = Object.freeze([...new Set(raw.map(value => actorIdSchema.parse(value)))]);
                }
              }
              skills.set(name, Object.freeze({...item, ...(actors ? {actors} : {})}));
            } catch (error) {issue(kind, path, error instanceof Error ? error.message : '技能角色声明无效');}
          }
          else commands.set(name, Object.freeze({...item, template: meta.body}));
        }
        if (entries.length > 256) issue(kind, directory, '目录超过 256 项，其余跳过');
      }
    }
    this.value = Object.freeze({guidelines: Object.freeze(guidelines),
      skills: Object.freeze([...skills.values()]), commands: Object.freeze([...commands.values()]), issues: Object.freeze(issues)});
    return this.value;
  }
}
