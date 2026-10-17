import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import type {ModelCapacity} from '../context/contracts.js';
import type {Provider} from '../runtime/messages.js';
import {modelSettings, presets, type Config, type ModelSettings} from '../config/config.js';
import {createProvider, ProviderError} from './http.js';
import {modelCapacities} from './model-capacities.js';
import type {ThinkingEffort} from '../config/model-preferences.js';
import {AuthStorage} from './auth.js';
import {createHttpTransport} from './transport.js';

const credentialSchema = z.object({type: z.literal('api_key'), key: z.string(), env: z.record(z.string(), z.string()).optional()});
const modelsSchema = z.object({data: z.array(z.object({id: z.string().min(1),
  context_window: z.number().int().min(256).optional(), context_length: z.number().int().min(256).optional(),
  max_output_tokens: z.number().int().positive().optional(),
})).max(10000)});

async function storedKey(file: string, provider: string, env: NodeJS.ProcessEnv): Promise<string> {
  const path = file.startsWith('~/') || file.startsWith('~\\') ? join(homedir(), file.slice(2)) : file;
  let raw: Record<string, unknown>;
  try {raw = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')));}
  catch {throw new ProviderError('无法读取认证文件；检查路径与 JSON 格式');}
  const value = raw[provider];
  if (value === undefined) return '';
  const credential = credentialSchema.safeParse(value);
  if (!credential.success) throw new ProviderError('该提供商认证不是受支持的 api_key；OAuth 尚未接入');
  const key = credential.data.key;
  if (key.startsWith('!')) throw new ProviderError('认证命令尚未接入；请使用密钥或环境变量引用');
  const reference = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(key);
  if (reference) return env[reference[1] ?? reference[2]!] ?? credential.data.env?.[reference[1] ?? reference[2]!] ?? '';
  if (key.includes('$')) throw new ProviderError('认证文件只支持完整的 $ENV 或 ${ENV} 引用');
  return key;
}

/** 统一提供商选择与请求时认证；不拥有 Agent 历史或任务状态。 */
export class ProviderRegistry {
  private config: Config;
  private transport: ReturnType<typeof createHttpTransport> | undefined;
  private readonly fetcher: typeof fetch;
  private closed = false;
  private readonly capabilities = new Map<string, {window?: number; maxOutput?: number}>();
  constructor(config: Config, private readonly env: NodeJS.ProcessEnv = process.env,
    fetcher?: typeof fetch,
    readonly auth = new AuthStorage()) {
    this.config = config;
    this.fetcher = fetcher ?? ((input, init) => {
      if (this.closed) return Promise.reject(new ProviderError('模型网络服务已关闭'));
      this.transport ??= createHttpTransport(this.env);
      return this.transport.fetch(input, init);
    });
  }
  async close(): Promise<void> {this.closed = true; await this.transport?.close();}

  names(): string[] {return [...new Set([...Object.keys(presets), ...Object.keys(this.config.providers), this.config.provider.name])];}
  loginNames(): string[] {
    return this.names().filter(name => {
      const config = this.configFor(name), definition = config.providers[name] ?? presets[name];
      const host = new URL(modelSettings(config, this.env).baseUrl).hostname;
      return !!(config.provider.api_key_env ?? definition?.api_key_env) || !['localhost', '127.0.0.1', '[::1]'].includes(host);
    });
  }
  selection(): {provider: string; model: string; kind: ModelSettings['kind']; baseUrl: string} {
    const {model, kind, baseUrl} = modelSettings(this.config, this.env);
    return {provider: this.config.provider.name, model, kind, baseUrl};
  }
  private configFor(name: string, model?: string): Config {
    const current = this.config.provider;
    return {...this.config, provider: name === current.name
      ? {...current, ...(model !== undefined ? {model, ...(model !== current.model ? {context_window: undefined, max_output_tokens: undefined} : {})} : {})}
      : {name, model: model ?? '', temperature: current.temperature, max_tokens: current.max_tokens, timeout: current.timeout, thinking_effort: current.thinking_effort}};
  }
  thinking(): {effort: ThinkingEffort; levels: readonly ThinkingEffort[]} {
    const settings = modelSettings(this.config, this.env);
    return {effort: this.config.provider.thinking_effort, levels: settings.thinkingLevels ?? ['auto']};
  }
  selectEffort(effort: ThinkingEffort): void {
    if (!this.thinking().levels.includes(effort)) throw new ProviderError('当前模型未声明支持此思考档位');
    this.config = {...this.config, provider: {...this.config.provider, thinking_effort: effort}};
  }
  candidate(name: string, model?: string): ProviderRegistry {
    const next = new ProviderRegistry(this.configFor(name, model), this.env, this.fetcher, this.auth);
    for (const [key, value] of this.capabilities) next.capabilities.set(key, {...value});
    const settings = modelSettings(next.config, this.env);
    if (!settings.thinkingLevels?.includes(next.config.provider.thinking_effort)) next.config.provider.thinking_effort = 'auto';
    return next;
  }
  adopt(next: ProviderRegistry): void {this.config = next.config;}
  select(name: string, model?: string): void {
    const next = this.configFor(name, model);
    modelSettings(next, this.env);
    this.config = next;
  }
  async settings(requireAuth = true): Promise<ModelSettings> {return this.settingsFor(this.config.provider.name, requireAuth);}
  private async settingsFor(name: string, requireAuth: boolean): Promise<ModelSettings> {
    const config = this.configFor(name), settings = modelSettings(config, this.env), provider = config.provider;
    const learned = this.capabilities.get(JSON.stringify([name, settings.model]));
    const builtin = settings.baseUrl.replace(/\/$/, '') === presets[name]?.base_url.replace(/\/$/, '') ? modelCapacities[name + '/' + settings.model] : undefined;
    settings.maxTokens = Math.min(settings.maxTokens, config.provider.max_output_tokens ?? config.models[name + '/' + settings.model]?.max_output_tokens ?? learned?.maxOutput ?? builtin?.maxOutput ?? Infinity);
    settings.key = await this.auth.key(name) || settings.key;
    const selected = config.providers[name] ?? presets[name];
    const file = provider.auth_file ?? config.providers[name]?.auth_file;
    if (!settings.key && file) settings.key = await storedKey(file, provider.auth_provider ?? config.providers[name]?.auth_provider ?? name, this.env);
    const keyEnv = provider.api_key_env ?? selected?.api_key_env;
    if (requireAuth && !settings.key && (keyEnv || file)) throw new ProviderError('提供商 ' + name + ' 未登录；使用 /login，或设置 ' + (keyEnv ?? 'api_key_env') + ' 或检查 auth_file', false, 'authentication');
    return settings;
  }
  capacity(name = this.config.provider.name, model?: string): ModelCapacity {
    const config = this.configFor(name, model), settings = modelSettings(config, this.env);
    if (!settings.model) throw new ProviderError('尚未配置模型；使用 /model 选择模型');
    const learned = this.capabilities.get(JSON.stringify([name, settings.model]));
    const override = config.models[name + '/' + settings.model];
    const builtin = settings.baseUrl.replace(/\/$/, '') === presets[name]?.base_url.replace(/\/$/, '') ? modelCapacities[name + '/' + settings.model] : undefined;
    const isAntigravity = name === 'antigravity' || settings.baseUrl.includes('8045');
    const antigravityWindow = isAntigravity ? (settings.model.toLowerCase().includes('gemini') || settings.model.toLowerCase().includes('claude') ? 1_000_000 : 128_000) : undefined;
    const antigravityOutput = isAntigravity ? (settings.model.toLowerCase().includes('claude') ? 128_000 : 64_000) : undefined;
    const window = config.provider.context_window ?? override?.context_window ?? learned?.window ?? builtin?.window ?? antigravityWindow;
    const maxOutput = config.provider.max_output_tokens ?? override?.max_output_tokens ?? learned?.maxOutput ?? builtin?.maxOutput ?? antigravityOutput;
    if (!window) throw new ProviderError('模型 ' + name + '/' + settings.model + ' 的上下文窗口未知；在 [models."' + name + '/' + settings.model + '"] 配置 context_window 后重启（本地填实际 num_ctx）。', false, 'capacity');
    return {identity: JSON.stringify([name, settings.model, settings.baseUrl, settings.kind, window, maxOutput]),
      window, ...(maxOutput ? {maxOutput} : {})};
  }
  providerFor(name: string, model?: string): Provider {
    return this.candidate(name, model).provider();
  }
  provider(): Provider {
    return {respond: async (request, onDelta, signal) => {
      signal.throwIfAborted();
      const settings = await this.settings();
      signal.throwIfAborted();
      return createProvider(settings, this.fetcher).respond(request, onDelta, signal);
    }};
  }
  async models(signal: AbortSignal = AbortSignal.timeout(15000)): Promise<string[]> {
    return this.modelsFor(this.config.provider.name, signal);
  }
  private async modelsFor(name: string, signal: AbortSignal): Promise<string[]> {
    const settings = await this.settingsFor(name, true);
    signal.throwIfAborted();
    const headers: Record<string, string> = {};
    if (settings.kind === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (settings.key) headers['x-api-key'] = settings.key;
    } else if (settings.key) headers.authorization = 'Bearer ' + settings.key;
    let response: Response;
    try {response = await this.fetcher(settings.baseUrl.replace(/\/$/, '') + '/models', {headers, signal, redirect: 'error'});}
    catch {signal.throwIfAborted(); throw new ProviderError('模型列表连接失败', true);}
    if (!response.ok) {await response.body?.cancel(); throw new ProviderError('模型列表查询失败（HTTP ' + response.status + '）');}
    const payload = modelsSchema.safeParse(await response.json().catch(() => undefined));
    if (!payload.success) throw new ProviderError('模型列表格式无效');
    for (const model of payload.data.data) {
      const window = model.context_window ?? model.context_length;
      this.capabilities.set(JSON.stringify([name, model.id]), {...(window ? {window} : {}), ...(model.max_output_tokens ? {maxOutput: model.max_output_tokens} : {})});
    }
    return [...new Set(payload.data.data.map(model => model.id))].sort();
  }
  /** 查询已认证云端和已配置本地接口；不改变当前会话选择。 */
  async modelCatalog(signal: AbortSignal): Promise<{models: {provider: string; id: string}[]; issues: string[]}> {
    const results = await Promise.allSettled(this.names().map(async name => {
      const settings = await this.settingsFor(name, false);
      signal.throwIfAborted();
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(settings.baseUrl).hostname);
      const definition = this.config.providers[name];
      const configured = name === this.config.provider.name || !!definition;
      const noAuth = !(name === this.config.provider.name ? this.config.provider.api_key_env : undefined) && !definition?.api_key_env && !definition?.auth_file;
      if (!settings.key && !(configured && (local || noAuth && !!definition))) return [];
      const querySignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      try {return (await this.modelsFor(name, querySignal)).map(id => ({provider: name, id}));}
      catch {signal.throwIfAborted(); throw new Error(name + '：模型列表不可用，请检查认证或连接');}
    }));
    signal.throwIfAborted();
    const models: {provider: string; id: string}[] = [], issues: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') models.push(...result.value);
      else issues.push(result.reason instanceof Error ? result.reason.message : '模型列表查询失败');
    }
    return {models, issues};
  }
  async check(signal: AbortSignal = new AbortController().signal): Promise<{text: string; elapsedMs: number}> {
    const started = Date.now();
    const settings = await this.settings();
    const turn = await createProvider({...settings, maxTokens: Math.min(settings.maxTokens, 512)}, this.fetcher).respond({
      system: 'This is a connection check. Answer briefly.',
      messages: [{role: 'user', text: 'Reply with exactly LOGOX_PROVIDER_READY.'}], tools: [],
      thinking: false,
    }, () => {}, signal);
    if (turn.stop !== 'complete' || !turn.message.text.trim()) throw new ProviderError('连接检查未取得完整正文；停止原因：' + turn.stop);
    return {text: turn.message.text, elapsedMs: Date.now() - started};
  }
}
