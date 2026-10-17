import {glob, lstat, realpath, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import {PermissionEngine, shellWords, type PermissionTarget} from '../permissions/engine.js';
import {PermissionGuard, type GuardOptions} from '../permissions/guard.js';
import {shellImpact} from '../permissions/shell.js';
import {pathDanger, riskyPath, runtimePath, searchablePath, searchExclusions} from '../permissions/paths.js';
import type {ActorContext} from '../actors/ensemble.js';
import type {ImageBlock, ToolCall, ToolDefinition} from '../runtime/messages.js';
import {questionSchema} from '../runtime/contracts.js';
import {Snapshots, bytesOrMissing} from './snapshots.js';
import {runProcess} from './process.js';

const pathArg = z.string().min(1);
const schemas = {
  read: z.strictObject({path: pathArg, offset: z.number().int().positive().default(1), limit: z.number().int().min(1).max(2000).default(2000)}),
  write: z.strictObject({path: pathArg, content: z.string()}),
  edit: z.strictObject({path: pathArg, old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().default(false)}),
  glob: z.strictObject({pattern: z.string().min(1), path: pathArg.default('.')}),
  grep: z.object({pattern: z.string().min(1), path: pathArg.default('.'), limit: z.number().int().min(1).max(500).default(100), offset: z.number().int().optional()}),
  shell: z.strictObject({
    command: z.string().min(1),
    timeout: z.preprocess(
      val => typeof val === 'number' && val > 600 ? Math.round(val / 1000) : val,
      z.number().int().min(1).max(600).default(60),
    ),
  }),
  ask_user: z.strictObject({title: z.string().min(1), questions: z.array(questionSchema).min(1).max(3)}),
};
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  read: 'Read a file from the local filesystem with line numbers (offset starts at 1). Reads images (PNG, JPG, JPEG, GIF, WebP) and presents them visually as a multimodal LLM. Use this tool when asked to view or inspect screenshots and images.',
  write: 'Write full UTF-8 content to a file, creating parent directories if needed.',
  edit: 'Perform exact string replacement in a file. Requires unique match unless replace_all is true.',
  glob: 'Find files matching a glob pattern, ignoring dependencies, caches, and VCS directories.',
  grep: 'Search files using regular expressions, returning file paths, line numbers, and matching content.',
  shell: 'Execute a shell command in the working directory (PowerShell on Windows).',
  ask_user: 'Ask the user questions (1-3) and await their response.',
};
export const toolDefinitions: readonly ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name as ToolName], parameters: z.toJSONSchema(schema),
}));
function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep);
}
async function resolvedPath(path: string): Promise<string> {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try {return resolve(await realpath(current), ...missing.reverse());}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (current === parent) throw error;
      missing.push(relative(parent, current));
      current = parent;
    }
  }
}
async function fileVersion(path: string): Promise<string> {
  try {const info = await stat(path); return JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.ino]);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error;}
}
function decode(bytes: Buffer): {text: string; bom: boolean} {
  if (bytes.includes(0)) throw new Error('Binary or UTF-16 files are not supported yet');
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  try {return {text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bom ? bytes.subarray(3) : bytes), bom};}
  catch {throw new Error('File is not valid UTF-8, no changes applied');}
}
export interface ToolResult {text: string; isError: boolean; disposition?: 'denied' | 'error' | undefined; images?: ImageBlock[] | undefined}
export function validateToolCall(call: ToolCall): {valid: true; data: unknown} | {valid: false; error: string} {
  if (!Object.hasOwn(schemas, call.name)) {
    return {valid: false, error: `Unknown tool: ${call.name}. Available tools: ${Object.keys(schemas).join(', ')}`};
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch (e) {
    return {valid: false, error: `Invalid JSON in tool arguments: ${e instanceof Error ? e.message : String(e)}`};
  }
  if (!args || typeof args !== 'object') {
    return {valid: false, error: `Tool arguments must be a JSON object, received ${typeof args}`};
  }
  const result = schemas[call.name as ToolName].safeParse(args);
  if (result.success) return {valid: true, data: result.data};

  const missingParams = result.error.issues
    .filter(issue => issue.code === 'invalid_type' && (issue.message.includes('required') || (issue as unknown as {received?: string}).received === 'undefined'))
    .map(issue => issue.path.join('.') || 'root');

  const unrecognizedKeys = result.error.issues
    .filter(issue => issue.code === 'unrecognized_keys')
    .flatMap(issue => (issue as unknown as {keys: string[]}).keys);

  const issuesList = result.error.issues.map(issue => {
    const field = issue.path.join('.') || 'parameter';
    return `${field}: ${issue.message}`;
  });

  const parts: string[] = [];
  if (missingParams.length > 0) {
    parts.push(`The required parameter(s) ${missingParams.map(p => `\`${p}\``).join(', ')} is missing`);
  }
  if (unrecognizedKeys.length > 0) {
    parts.push(`Unexpected parameter(s) ${unrecognizedKeys.map(k => `\`${k}\``).join(', ')} provided`);
  }
  parts.push(`Details: ${issuesList.join('; ')}`);

  return {
    valid: false,
    error: `Parameter validation failed for tool \`${call.name}\`: ${parts.join('. ')}. (参数校验失败)`,
  };
}

export function validToolCall(call: ToolCall): boolean {
  return validateToolCall(call).valid;
}
export class Tools {
  readonly snapshots: Snapshots;
  constructor(readonly cwd: string, private readonly report: (context: ActorContext, text: string) => void = () => {},
    readonly permissions = new PermissionEngine(cwd)) {
    this.snapshots = new Snapshots(join(cwd, '.logox', 'snapshots'));
  }
  private readonly guards = new Map<string, PermissionGuard>();
  private readonly disposedGuards = new WeakSet<PermissionGuard>();
  configurePermissions(sessionId: string, options: GuardOptions): () => void {
    const previous = this.guards.get(sessionId);
    const guard = new PermissionGuard(this.permissions, options);
    this.guards.set(sessionId, guard);
    return () => {
      this.disposedGuards.add(guard);
      if (this.guards.get(sessionId) !== guard) return;
      if (previous && !this.disposedGuards.has(previous)) this.guards.set(sessionId, previous);
      else this.guards.delete(sessionId);
    };
  }
  permissionGuard(context: Pick<ActorContext, 'sessionId'>): PermissionGuard {
    let guard = this.guards.get(context.sessionId);
    if (!guard) {guard = new PermissionGuard(this.permissions); this.guards.set(context.sessionId, guard);}
    return guard;
  }
  /** 扩展完整 schema 由调用方先校验，再进入唯一裁决入口。 */
  async authorizeExtension(call: ToolCall, context: ActorContext, effect: PermissionTarget['effect'] = 'unknown'): Promise<boolean> {
    context.signal.throwIfAborted();
    const raw: unknown = JSON.parse(call.arguments);
    const paths: {original: string; canonical: string}[] = [];
    const visit = async (value: unknown): Promise<void> => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (['path', 'file_path', 'target_file', 'file', 'dir', 'cwd', 'paths'].includes(key)) {
          for (const candidate of Array.isArray(item) ? item : [item]) if (typeof candidate === 'string') {
            const path = await resolvedPath(resolve(this.cwd, candidate));
            if ([path, resolve(this.cwd, candidate)].some(candidate => candidate.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) throw new Error('Project conventions forbid reading or modifying legacy materials');
            paths.push({original: resolve(this.cwd, candidate), canonical: path});
          }
        }
        await visit(item);
      }
    };
    await visit(raw);
    const root = await realpath(this.cwd);
    const danger = paths.flatMap(item => [item.original, item.canonical]).map(path => pathDanger(path, effect)).find(Boolean);
    const target: PermissionTarget = {tool: call.name, paths: paths.flatMap(item => [item.original, item.canonical, relative(this.cwd, item.original).replaceAll('\\', '/'), relative(this.cwd, item.canonical).replaceAll('\\', '/')]),
      effect, risky: paths.some(item => !inside(root, item.canonical) || riskyPath(item.original, effect) || riskyPath(item.canonical, effect)),
      ...(danger ? {danger} : {}),
      ...(raw && typeof raw === 'object' && 'command' in raw && typeof raw.command === 'string' ? {command: raw.command} : {})};
    const guard = this.permissionGuard(context), args = z.record(z.string(), z.json()).parse(raw);
    let policy: string;
    let allowed: boolean;
    do {
      allowed = await guard.authorize(target, args, context); policy = guard.policy();
      context.signal.throwIfAborted();
      for (const path of paths) if (await resolvedPath(path.original) !== path.canonical) throw new Error('Extension target path changed during approval');
    } while (allowed && policy !== guard.policy());
    return allowed;
  }
  async execute(call: ToolCall, context: ActorContext): Promise<ToolResult> {
    try {
      context.signal.throwIfAborted();
      if (!Object.hasOwn(schemas, call.name)) throw new Error('Unknown tool: ' + call.name);
      const name = call.name as ToolName;
      const raw: unknown = JSON.parse(call.arguments);
      const parsed = schemas[name].parse(raw);
      if (name === 'ask_user') {
        const args = schemas.ask_user.parse(parsed);
        if (!await this.permissionGuard(context).authorize({tool: name, paths: [], risky: false, effect: 'read'}, JSON.parse(JSON.stringify(args)), context)) return {text: 'Question denied by permission rules.', isError: true, disposition: 'denied'};
        context.startTool?.();
        const outcome = await context.ask({kind: 'question', ...args});
        return {text: JSON.stringify(outcome), isError: outcome.status !== 'answered'};
      }
      const originalPath = 'path' in parsed ? resolve(this.cwd, parsed.path) : this.cwd;
      const path = await resolvedPath(originalPath);
      const root = await realpath(this.cwd);
      if ([path, ...('path' in parsed ? [resolve(this.cwd, parsed.path)] : [])].some(candidate => candidate.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) throw new Error('Project conventions forbid reading or modifying legacy materials');
      const preparedVersion = ['write', 'edit'].includes(name) ? await fileVersion(path) : undefined;
      const shellPaths: {original: string; canonical: string}[] = [];
      if (name === 'shell') for (const word of shellWords(schemas.shell.parse(parsed).command).words.slice(1)) {
        if (word.startsWith('-') || word.startsWith('$')) continue;
        const original = resolve(this.cwd, word), canonical = await resolvedPath(original);
        if ([original, canonical].some(candidate => candidate.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) throw new Error('Project conventions forbid reading or modifying legacy materials');
        shellPaths.push({original, canonical});
      }
      const effect: PermissionTarget['effect'] = ['read', 'glob', 'grep'].includes(name) || name === 'shell' && shellImpact(schemas.shell.parse(parsed).command).kind === 'safe' ? 'read'
        : ['write', 'edit'].includes(name) ? 'write' : 'unknown';
      const targets = [originalPath, path, ...shellPaths.flatMap(item => [item.original, item.canonical])];
      const danger = targets.map(path => pathDanger(path, effect)).find(Boolean);
      const target: PermissionTarget = {tool: name, effect, paths: [relative(root, path).replaceAll('\\', '/'), path, relative(root, originalPath).replaceAll('\\', '/'), originalPath,
        ...shellPaths.flatMap(item => [item.original, item.canonical, relative(root, item.original).replaceAll('\\', '/'), relative(root, item.canonical).replaceAll('\\', '/')])],
        risky: !inside(root, path) || targets.some(path => riskyPath(path, effect)) || shellPaths.some(item => !inside(root, item.canonical)),
        ...(danger ? {danger} : {}),
        ...(name === 'shell' ? {command: schemas.shell.parse(parsed).command} : {})};
      const guard = this.permissionGuard(context), permissionArgs = JSON.parse(JSON.stringify(parsed)) as Record<string, z.infer<ReturnType<typeof z.json>>>;
      this.report(context, name + ' · ' + ('path' in parsed ? parsed.path : name === 'shell' ? schemas.shell.parse(parsed).command : ''));
      let policy: string;
      do {
        if (!await guard.authorize(target, permissionArgs, context)) return {text: 'Operation denied (操作被拒绝). Please respect this decision and pursue alternative approaches without repeating the same action.', isError: true, disposition: 'denied'};
        policy = guard.policy();
        context.signal.throwIfAborted();
        for (const item of shellPaths) if (await resolvedPath(item.original) !== item.canonical) throw new Error('Shell path changed during approval');
        if (await resolvedPath(originalPath) !== path) throw new Error('Target path changed while awaiting approval; please re-request');
        if (preparedVersion !== undefined && preparedVersion !== await fileVersion(path)) throw new Error('File modified while awaiting approval; changes aborted. Please re-read file and try again.');
      } while (policy !== guard.policy());
      context.startTool?.();
      if (['read', 'edit', 'write'].includes(name)) {
        const size = await stat(path).then(info => info.size).catch(error => {if (error.code === 'ENOENT') return 0; throw error;});
        if (size > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB, use search to narrow scope');
      }
      if (name === 'read') {
        const args = schemas.read.parse(parsed);
        const bytes = await bytesOrMissing(path);
        if (!bytes) throw new Error('File not found: ' + args.path);
        if (bytes.length > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB, use search to narrow scope');
        const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
        const imageMimes: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp',
        };
        const mime = imageMimes[ext];
        if (mime) {
          if (bytes.length > 10 * 1024 * 1024) throw new Error('Image exceeds 10 MiB limit');
          return {
            text: `[Image file: ${args.path}, size: ${bytes.length} bytes, format: ${mime}. Visual content presented to model.]`,
            isError: false,
            images: [{data: bytes.toString('base64'), mimeType: mime}],
          };
        }
        const lines = decode(bytes).text.split(/\r?\n/);
        return {text: lines.slice(args.offset - 1, args.offset - 1 + args.limit)
          .map((line, index) => (args.offset + index) + ': ' + line.slice(0, 2000)).join('\n') +
          (lines.length > args.offset - 1 + args.limit ? '\n(Remaining lines omitted)' : ''), isError: false};
      }
      if (name === 'write' || name === 'edit') {
        const before = await bytesOrMissing(path);
        if (before && before.length > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB');
        let after: Buffer;
        if (name === 'write') after = Buffer.from(schemas.write.parse(parsed).content);
        else {
          const args = schemas.edit.parse(parsed);
          if (!before) throw new Error('File not found: ' + path);
          const decoded = decode(before);
          const newline = decoded.text.includes('\r\n') ? '\r\n' : '\n';
          const old = args.old_text.replace(/\r?\n/g, newline);
          const replacement = args.new_text.replace(/\r?\n/g, newline);
          const count = decoded.text.split(old).length - 1;
          if (!count) throw new Error('No match found for old_text; please re-read file');
          if (count > 1 && !args.replace_all) throw new Error('Multiple matches found; provide more context or set replace_all: true');
          after = Buffer.from((decoded.bom ? '\uFEFF' : '') + (args.replace_all ? decoded.text.split(old).join(replacement) : decoded.text.replace(old, () => replacement)));
        }
        if (after.length > 32 * 1024 * 1024) throw new Error('Content exceeds 32 MiB');
        await this.snapshots.apply(path, before, after, context.activityId, context.signal);
        return {text: 'Updated ' + path + ' (已修改); use /undo to revert file changes from this round.', isError: false};
      }
      if (name === 'glob') {
        const args = schemas.glob.parse(parsed);
        if (isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes('..')) throw new Error('pattern must be relative to target directory');
        const results: string[] = [];
        const includeRuntime = runtimePath(originalPath) || runtimePath(path) || runtimePath(args.pattern);
        for await (const candidate of glob(args.pattern, {cwd: path, exclude: candidate => !searchablePath(candidate, includeRuntime) || candidate.split(/[\\/]/).some(part => ['node_modules', 'dist'].includes(part.toLowerCase()))})) {
          context.signal.throwIfAborted();
          const full = join(path, candidate);
          if (!searchablePath(full, includeRuntime) || !(await lstat(full)).isFile() || !inside(path, await realpath(full))) continue;
          results.push(candidate);
          if (results.length >= 1000) break;
        }
        return {text: results.sort().slice(0, 200).join('\n') + (results.length > 200 ? '\n(Showing first 200 items)' : ''), isError: false};
      }
      if (name === 'grep') {
        const args = schemas.grep.parse(parsed);
        const includeRuntime = runtimePath(originalPath) || runtimePath(path);
        const matchSchema = z.object({type: z.literal('match'), data: z.object({path: z.object({text: z.string()}), line_number: z.number(), lines: z.object({text: z.string()})})});
        const rawMatches: z.infer<typeof matchSchema>[] = [];
        const result = await runProcess('rg', ['--json', '--no-config', '--hidden', '--no-ignore', '--max-count', String(args.limit),
          ...searchExclusions(includeRuntime).flatMap(pattern => ['--iglob', '!' + pattern]), '--regexp', args.pattern, '--', path],
        this.cwd, context.signal, 30_000, 64_000, line => {
          let raw: unknown;
          try {raw = JSON.parse(line);} catch {return true;}
          const match = matchSchema.safeParse(raw);
          if (match.success && searchablePath(match.data.data.path.text, includeRuntime)) rawMatches.push(match.data);
          return rawMatches.length < args.limit;
        });
        if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || 'rg search failed');
        const matches: string[] = [];
        for (const item of rawMatches) {
          const file = resolve(this.cwd, item.data.path.text);
          const canonical = await realpath(file);
          if (!searchablePath(file, includeRuntime) || !searchablePath(canonical, includeRuntime) || !inside(path, canonical)) continue;
          matches.push(relative(this.cwd, file) + ':' + item.data.line_number + ': ' + item.data.lines.text.trimEnd().slice(0, 2000));
          if (matches.length >= args.limit) break;
        }
        return {text: (matches.join('\n') || 'No matches found.') + (rawMatches.length >= args.limit ? '\n(Display limit reached, search stopped)' : ''), isError: false};
      }
      const args = schemas.shell.parse(parsed);
      const result = await runProcess(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
        process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command] : ['-c', args.command],
        this.cwd, context.signal, args.timeout * 1000);
      return {text: '退出码：' + result.code + ' (Exit code: ' + result.code + ')\n' + result.stdout + (result.stderr ? '\nStderr:\n' + result.stderr : ''), isError: result.code !== 0};
    } catch (error) {
      return {text: context.signal.aborted ? 'Tool cancelled.' : error instanceof z.ZodError ? 'Invalid tool arguments: ' + error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join('; ')
        : error instanceof Error ? error.message : String(error), isError: true};
    }
  }
}
