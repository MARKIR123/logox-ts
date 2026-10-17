import {readFile, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {parse} from 'smol-toml';
import {z} from 'zod';
import {effortSchema, preferenceSchema, StateFile} from './model-preferences.js';
import {hooksSchema, mcpServerSchema} from '../extensions/config.js';

export const priceSchema = z.object({currency: z.string().min(1).default('USD'),
  input: z.number().finite().nonnegative().optional(), output: z.number().finite().nonnegative().optional(),
  cache_read: z.number().finite().nonnegative().optional(), cache_write: z.number().finite().nonnegative().optional()});
const capacitySchema = z.object({
  thinking_protocol: z.enum(['deepseek', 'anthropic-budget', 'anthropic-adaptive', 'reasoning-effort']).optional(),
  thinking_levels: z.array(effortSchema).min(1).optional(), prices: priceSchema.optional(),
  context_window: z.number().int().min(256).optional(),
  max_output_tokens: z.number().int().positive().optional(),
});
export const contextPolicySchema = z.object({
  keep_recent_rounds: z.number().int().nonnegative().default(2),
  keep_recent_tools: z.number().int().nonnegative().default(2),
  reserve_tokens: z.number().int().nonnegative().default(32768),
  low_watermark_ratio: z.number().positive().lt(1).default(0.5),
  max_budget_tokens: z.number().int().positive().optional(),
  target_budget_tokens: z.number().int().positive().optional(),
  summary_provider: z.string().min(1).optional(),
  summary_model: z.string().min(1).optional(),
}).refine(policy => !policy.max_budget_tokens || !policy.target_budget_tokens || policy.target_budget_tokens < policy.max_budget_tokens,
  'target_budget_tokens 必须小于 max_budget_tokens');
export type ContextPolicy = z.infer<typeof contextPolicySchema>;
export const themeSchema = z.object({
  user: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#5282b5'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#d97757'),
  dream_collapsed: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#c4cbd2'),
  dream_expanded: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#dce2e8'),
}).default({
  user: '#5282b5',
  accent: '#d97757',
  dream_collapsed: '#c4cbd2',
  dream_expanded: '#dce2e8',
});
export type ThemeConfig = z.infer<typeof themeSchema>;
const schema = z.object({
  theme: themeSchema,
  permissions: z.object({mode: z.enum(['default', 'auto', 'creative']).default('default'), readonly_concurrency: z.number().int().min(1).max(8).default(4)}).default({mode: 'default', readonly_concurrency: 4}),
  mcp: z.object({servers: z.record(z.string().min(1), mcpServerSchema).default({})}).default({servers: {}}),
  hooks: hooksSchema.default({enabled: false, timeout_s: 5, entries: []}),
  context: contextPolicySchema.default({keep_recent_rounds: 2, keep_recent_tools: 2, reserve_tokens: 32768, low_watermark_ratio: 0.5}),
  models: z.record(z.string(), capacitySchema).default({}),
  provider: z.object({
    context_window: capacitySchema.shape.context_window, max_output_tokens: capacitySchema.shape.max_output_tokens,
    thinking_effort: effortSchema.default('auto'),
    name: z.string().default('openai-compatible'), model: z.string().default(''),
    base_url: z.string().url().optional(), api_key_env: z.string().optional(),
    auth_file: z.string().min(1).optional(), auth_provider: z.string().min(1).optional(),
    kind: z.enum(['openai_compat', 'anthropic']).optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    max_tokens: z.number().int().positive().default(16384),
    timeout: z.number().positive().default(600),
  }).default({thinking_effort: 'auto', name: 'openai-compatible', model: '', temperature: 0.2, max_tokens: 16384, timeout: 600}),
  kernel: z.object({
    max_iterations: z.number().int().nonnegative().default(0),
    max_retries: z.number().int().nonnegative().max(10).default(3),
  }).default({max_iterations: 0, max_retries: 3}),
  providers: z.record(z.string(), z.object({
    kind: z.enum(['openai_compat', 'anthropic']).default('openai_compat'),
    base_url: z.string().url(), api_key_env: z.string().optional(), default_model: z.string().optional(),
    auth_file: z.string().min(1).optional(), auth_provider: z.string().min(1).optional(),
  })).default({}),
});
export type Config = z.infer<typeof schema>;
export interface ModelSettings {
  kind: 'openai_compat' | 'anthropic'; baseUrl: string; model: string; key: string;
  temperature: number; maxTokens: number; timeoutMs: number; thinkingControl?: boolean;
  thinkingEffort?: import('./model-preferences.js').ThinkingEffort;
  thinkingProtocol?: 'deepseek' | 'anthropic-budget' | 'anthropic-adaptive' | 'reasoning-effort';
  thinkingLevels?: readonly import('./model-preferences.js').ThinkingEffort[];
}
export const presets: Record<string, {kind: ModelSettings['kind']; base_url: string; api_key_env?: string}> = {
  'openai-compatible': {kind: 'openai_compat', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY'},
  deepseek: {kind: 'openai_compat', base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY'},
  antigravity: {kind: 'openai_compat', base_url: 'http://127.0.0.1:8045/v1'},
  anthropic: {kind: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_key_env: 'ANTHROPIC_API_KEY'},
};
function pathKey(path: string): string {return process.platform === 'win32' ? path.toLowerCase() : path;}
function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result = {...left};
  for (const [key, value] of Object.entries(right)) {
    if (key === 'api_key') throw new Error('请使用 api_key_env，配置文件不保存密钥');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      let previous = result[key] && typeof result[key] === 'object' ? result[key] as Record<string, unknown> : {};
      const update = value as Record<string, unknown>;
      // 提供商身份改变时，不继承上一个接口的地址、模型或认证。
      if (key === 'provider' && typeof update.name === 'string' && typeof previous.name === 'string' && update.name !== previous.name) {
        previous = Object.fromEntries(Object.entries(previous).filter(([field]) => ['temperature', 'max_tokens', 'timeout', 'thinking_effort'].includes(field)));
      } else if (key === 'provider' && typeof update.model === 'string' && typeof previous.model === 'string' && update.model !== previous.model) {
        previous = Object.fromEntries(Object.entries(previous).filter(([field]) => !['context_window', 'max_output_tokens'].includes(field)));
      }
      result[key] = merge(previous, update);
    } else result[key] = value;
  }
  return result;
}
export async function loadConfig(cwd: string, overrides: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env, home = homedir(), projectBoundary?: string,
  diagnostic: (message: string) => void = message => {process.stderr.write(message + '\n');}): Promise<Config> {
  const ancestors: string[] = [];
  let directory = resolve(cwd);
  for (;;) {
    ancestors.unshift(directory);
    if (projectBoundary && pathKey(directory) === pathKey(resolve(projectBoundary))) break;
    const parent = dirname(directory);
    if (directory === parent) break;
    directory = parent;
  }
  const actualHome = pathKey(await realpath(homedir()));
  const projectDirectories = (await Promise.all(ancestors.map(path => realpath(path)))).filter(path => pathKey(path) !== actualHome);
  const files = [
    join(home, '.logox', 'config.toml'),
    join(home, '.logox-ts', 'config.toml'),
    ...projectDirectories.flatMap(path => [
      join(path, '.logox', 'config.toml'),
      join(path, '.logox-ts', 'config.toml'),
    ]),
  ];
  let raw: Record<string, unknown> = {};
  const loaded = new Set<string>();
  for (const file of files) {
    let content: string;
    try {
      const canonical = pathKey(await realpath(file));
      if (loaded.has(canonical)) continue;
      loaded.add(canonical);
      content = await readFile(file, 'utf8');
    }
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
    try {raw = merge(raw, parse(content, {unsafeKeyBehaviour: 'throw'}));}
    catch {throw new Error('配置无效：' + file + '（检查 TOML 格式及 api_key_env）');}
  }
  try {
    const previous = await new StateFile(join(cwd, '.logox', 'state', 'model-preferences.json'), preferenceSchema).read();
    if (previous) {
      const candidate = merge(raw, {provider: {name: previous.provider, model: previous.model, thinking_effort: previous.effort}});
      modelSettings(schema.parse(candidate), env);
      raw = candidate;
    }
  } catch {diagnostic('上次模型选择无法读取或已无效，使用配置；状态原文件保留。');}
  let environment: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('LOGOX__') || value === undefined) continue;
    const path = key.slice(7).toLowerCase().split('__');
    if (path.some(part => !part || ['__proto__', 'constructor', 'prototype', 'api_key'].includes(part))) throw new Error('环境配置键无效');
    const update: Record<string, unknown> = {};
    let cursor = update;
    for (const part of path.slice(0, -1)) {cursor[part] = {}; cursor = cursor[part] as Record<string, unknown>;}
    cursor[path.at(-1)!] = ['name', 'model', 'base_url', 'api_key_env', 'kind', 'default_model', 'auth_file', 'auth_provider'].includes(path.at(-1)!) ? value : /^(true|false)$/.test(value) ? value === 'true' : /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    environment = merge(environment, update);
  }
  return schema.parse(merge(merge(raw, environment), overrides));
}
export function modelSettings(config: Config, env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const selected = config.providers[config.provider.name] ?? presets[config.provider.name];
  if (!selected && !config.provider.base_url) throw new Error('未知 provider：' + config.provider.name);
  const provider = config.provider;
  const baseUrl = provider.base_url ?? selected!.base_url;
  const keyEnv = provider.api_key_env ?? selected?.api_key_env;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型地址必须是无凭据的 HTTP(S) 地址');
  const model = provider.model || (selected && 'default_model' in selected ? selected.default_model ?? '' : '');
  const declared = config.models[provider.name + '/' + model];
  const official = baseUrl.replace(/\/$/, '') === presets[provider.name]?.base_url.replace(/\/$/, '');
  const protocol = declared?.thinking_protocol ?? (official && provider.name === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model) ? 'deepseek'
    : official && provider.name === 'anthropic' && /^claude-(opus-4-[678]|sonnet-4-6)$/.test(model) ? 'anthropic-adaptive'
    : official && provider.name === 'anthropic' && /^claude-(3-7-sonnet|sonnet-4(?:-5)?|opus-4(?:-1|-5)?)(?:-\d{8})?$/.test(model) ? 'anthropic-budget'
    : (provider.name === 'antigravity' || url.port === '8045') && (model.toLowerCase().includes('gemini') || model.toLowerCase().includes('claude')) ? 'reasoning-effort'
    : undefined);
  const kind = provider.kind ?? selected?.kind ?? 'openai_compat';
  if ((protocol?.startsWith('anthropic-') && kind !== 'anthropic') || ((protocol === 'deepseek' || protocol === 'reasoning-effort') && kind !== 'openai_compat')) throw new Error('thinking_protocol 与提供商 kind 不匹配');
  return {kind, baseUrl,
    model, thinkingEffort: provider.thinking_effort,
    ...(protocol ? {thinkingProtocol: protocol, thinkingLevels: declared?.thinking_levels ?? (protocol === 'deepseek' ? ['auto', 'off', 'low', 'high', 'max'] : protocol === 'anthropic-adaptive' && model.startsWith('claude-opus-') ? ['auto', 'off', 'low', 'medium', 'high', 'max'] : ['auto', 'off', 'low', 'medium', 'high'])} : {}),
    key: keyEnv ? env[keyEnv] ?? '' : '',
    temperature: provider.temperature, maxTokens: provider.max_tokens, timeoutMs: provider.timeout * 1000,
    ...(provider.name === 'deepseek' && url.hostname === 'api.deepseek.com' ? {thinkingControl: true} : {})};
}
