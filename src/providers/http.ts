import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {ModelSettings} from '../config/config.js';
import type {Delta, ModelMessage, ModelRequest, ModelTurn, Provider, ToolCall} from '../runtime/messages.js';

export type ProviderErrorCategory = 'model_missing' | 'authentication' | 'quota' | 'temporary' | 'capacity' | 'protocol';
type ProtocolIssue = 'empty_assistant' | 'tool_pairing' | 'reasoning' | 'invalid_field';
export interface ProviderDiagnostic {
  status?: number; code?: string; phase?: 'connection' | 'stream'; parameter?: string; issue?: ProtocolIssue;
  elapsedMs?: number; progressIdleMs?: number; transportIdleMs?: number; receivedBytes?: number;
}
export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false,
    readonly category: ProviderErrorCategory = retryable ? 'temporary' : 'protocol',
    readonly diagnostic?: ProviderDiagnostic) {super(message);}
}
export function providerTimeout(): ProviderError {
  return new ProviderError('模型请求超时', true, 'temporary', {status: 408, code: 'idle_timeout'});
}
export function isProviderTimeout(error: unknown): boolean {
  return error instanceof ProviderError && error.category === 'temporary' &&
    (error.diagnostic?.code === 'idle_timeout' || error.message === '模型请求超时');
}
export function isProviderInterruption(error: unknown): boolean {
  return isProviderTimeout(error) || error instanceof ProviderError && error.category === 'temporary' &&
    (error.diagnostic?.phase === 'connection' || error.diagnostic?.phase === 'stream');
}
const transportReasons: Record<string, string> = {
  UND_ERR_SOCKET: '连接被关闭', ECONNRESET: '连接被重置', EPIPE: '连接已断开',
  ENOTFOUND: '无法解析服务地址', EAI_AGAIN: '服务地址解析暂时失败', ECONNREFUSED: '连接被拒绝',
  ETIMEDOUT: '网络连接超时', UND_ERR_CONNECT_TIMEOUT: '建立连接超时',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时', UND_ERR_BODY_TIMEOUT: '等待响应数据超时',
};
/** fetch 将传输原因包在 cause 中；只保留公开码，避免异常回显带入请求资料。 */
function transportFailure(error: unknown, phase: 'connection' | 'stream', status?: number): ProviderError {
  let code: string | undefined;
  for (let depth = 0; depth < 6; depth++) {
    const parsed = z.object({code: z.unknown().optional(), cause: z.unknown().optional()}).safeParse(error);
    if (!parsed.success) break;
    if (typeof parsed.data.code === 'string' && Object.hasOwn(transportReasons, parsed.data.code)) {
      code = parsed.data.code; break;
    }
    error = parsed.data.cause;
  }
  const title = phase === 'stream' ? '模型流连接中断' : '模型连接失败';
  return new ProviderError(title + '：' + (code ? transportReasons[code] + '（' + code + '）' : '底层未提供可识别的错误码'),
    true, 'temporary', {phase, ...(status !== undefined ? {status} : {}), ...(code ? {code} : {})});
}
function idleDeadline(signal: AbortSignal, milliseconds: number) {
  const controller = new AbortController();
  const startedAt = performance.now();
  let lastProgressAt = startedAt, lastDataAt: number | undefined, receivedBytes = 0;
  let timer: ReturnType<typeof setTimeout>;
  const progress = () => {
    lastProgressAt = performance.now();
    clearTimeout(timer);
    if (!controller.signal.aborted && !signal.aborted) timer = setTimeout(() => controller.abort(), milliseconds).unref();
  };
  progress();
  return {signal: AbortSignal.any([signal, controller.signal]), progress,
    received(length: number) {lastDataAt = performance.now(); receivedBytes += length;},
    observation() {
      const now = performance.now();
      return {elapsedMs: Math.floor(now - startedAt), progressIdleMs: Math.floor(now - lastProgressAt), receivedBytes,
        ...(lastDataAt !== undefined ? {transportIdleMs: Math.floor(now - lastDataAt)} : {})};
    }, close: () => clearTimeout(timer)};
}
/** 已知公开错误保留 API 用语；未知回显使用结构化诊断，不带入整段响应正文。 */
export function providerFailure(status: number, payload?: unknown): ProviderError {
  const parsed = z.object({error: z.object({code: z.string().optional(), type: z.string().optional(),
    message: z.string().optional(), param: z.string().nullable().optional()}).optional()}).safeParse(payload);
  const code = parsed.success ? parsed.data.error?.code ?? parsed.data.error?.type : undefined;
  if (status === 401 || status === 403) return new ProviderError('模型认证或权限不可用', false, 'authentication');
  if (status === 402 || ['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'credit_balance_exhausted'].includes(code ?? '')) {
    const message = parsed.success ? parsed.data.error?.message?.trim() ?? '' : '';
    // 只保留完整匹配的公开余额提示，避免错误正文夹带请求或凭据。
    const reason = /^(?:Insufficient Balance|Insufficient credits|Insufficient quota|余额不足|额度不足)[.!。]?$/i.test(message)
      ? message + '（余额不足）' : '余额或额度不足';
    return new ProviderError('模型请求失败（HTTP ' + status + '）：' + reason + '；充值后继续，或使用 /model 切换模型。',
      false, 'quota', {status});
  }
  if (['authentication_error', 'permission_error'].includes(code ?? '')) return new ProviderError('模型认证或权限不可用', false, 'authentication');
  if (['model_not_found', 'model_not_exist', 'model_not_available'].includes(code ?? '')) return new ProviderError('所选模型不存在或不可用', false, 'model_missing');
  if (['rate_limit_error', 'overloaded_error'].includes(code ?? '')) return new ProviderError('模型服务暂时不可用', true, 'temporary');
  if ([408, 429, 500, 502, 503, 504, 529].includes(status)) return new ProviderError('模型服务暂时不可用', true, 'temporary');
  const error = parsed.success ? parsed.data.error : undefined, text = error?.message ?? '';
  const issue: ProtocolIssue | undefined = /reasoning_content/i.test(text) ? 'reasoning'
    : /tool_call_id|tool_use_id|tool_calls.*(?:follow|response|match)|tool.*(?:preceding|correspond)/i.test(text) ? 'tool_pairing'
    : /assistant.*(?:content|empty)|content.*tool_calls/i.test(text) ? 'empty_assistant'
    : ['invalid_request_error', 'invalid_parameter', 'invalid_json', 'invalid_message'].includes(code ?? '') ? 'invalid_field' : undefined;
  const descriptions: Record<ProtocolIssue, string> = {
    reasoning: '思考字段未满足接口要求', tool_pairing: '工具调用与结果未正确配对',
    empty_assistant: '助手消息正文为空或格式无效', invalid_field: '请求字段或消息格式无效',
  };
  const parameter = error?.param && /^(?:messages|tools)(?:\[\d{1,6}\]|\.\d{1,6})?(?:\.(?:content|role|reasoning_content|tool_calls|tool_call_id|function|arguments|parameters|name))*$/.test(error.param) ? error.param : undefined;
  const safeCode = ['invalid_request_error', 'invalid_parameter', 'invalid_json', 'invalid_message'].includes(code ?? '') ? code : undefined;
  return new ProviderError('模型请求失败（HTTP ' + status + '）' + (issue ? '：' + descriptions[issue] : '') +
    (parameter ? '；字段：' + parameter : ''), false, 'protocol',
    {status, ...(safeCode ? {code: safeCode} : {}), ...(parameter ? {parameter} : {}), ...(issue ? {issue} : {})});
}
async function errorPayload(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) return undefined;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {return undefined;}
  finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
type ObjectValue = Record<string, unknown>;
const usageSchema = z.object({
  input_tokens: z.number().optional(), output_tokens: z.number().optional(),
  prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(),
  prompt_cache_hit_tokens: z.number().optional(), cached_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional(),
  prompt_tokens_details: z.object({cached_tokens: z.number().optional()}).optional(),
});
const deltaSchema = z.object({
  type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(),
  signature: z.string().optional(), partial_json: z.string().optional(), stop_reason: z.string().nullable().optional(),
});
const eventSchema = z.object({
  type: z.string().optional(), index: z.number().int().nonnegative().optional(),
  error: z.unknown().optional(), usage: usageSchema.nullable().optional(),
  message: z.object({usage: usageSchema.optional()}).optional(), delta: deltaSchema.optional(),
  content_block: z.object({
    type: z.string(), id: z.string().optional(), name: z.string().optional(),
    text: z.string().optional(), thinking: z.string().optional(), signature: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(), id: z.string().optional(),
        function: z.object({name: z.string().optional(), arguments: z.string().optional()}).optional(),
      })).optional(),
    }).optional(),
  })).optional(),
});
type StreamEvent = z.infer<typeof eventSchema>;
/** 心跳和空帧不是模型进展；正文、思考、工具参数及协议收尾都能刷新期限。 */
function hasProgress(event: StreamEvent): boolean {
  if (['message_start', 'content_block_start', 'content_block_stop', 'message_stop'].includes(event.type ?? '')) return true;
  if (event.delta?.text || event.delta?.thinking || event.delta?.signature || event.delta?.partial_json || event.delta?.stop_reason) return true;
  if (event.usage && Object.values(event.usage).some(value => typeof value === 'number')) return true;
  return event.choices?.some(choice => !!choice.finish_reason || !!choice.delta &&
    (!!choice.delta.content || !!choice.delta.reasoning_content || !!choice.delta.reasoning ||
      !!choice.delta.tool_calls?.some(call => !!call.id || !!call.function?.name || !!call.function?.arguments))) ?? false;
}
export function openaiMessages(messages: readonly ModelMessage[], requiresReasoningContent = false, supportsVision = false, maxImages = 2): ObjectValue[] {
  const imageIndices = messages
    .map((msg, i) => ('images' in msg && msg.images?.length ? i : -1))
    .filter(i => i >= 0);
  const activeImageIndices = new Set(imageIndices.slice(-maxImages));

  return messages.map((message, i) => {
    const keepImage = activeImageIndices.has(i);
    if (message.role === 'tool') {
      if (supportsVision && message.images?.length && keepImage) {
        return {
          role: 'tool',
          tool_call_id: message.callId,
          content: [
            {type: 'text', text: message.text},
            ...message.images.map(img => ({type: 'image_url', image_url: {url: `data:${img.mimeType};base64,${img.data}`}})),
          ],
        };
      }
      return {role: 'tool', tool_call_id: message.callId, content: message.text};
    }
    if (message.role === 'user') {
      if (supportsVision && message.images?.length && keepImage) {
        return {
          role: 'user',
          content: [
            {type: 'text', text: message.text},
            ...message.images.map(img => ({type: 'image_url', image_url: {url: `data:${img.mimeType};base64,${img.data}`}})),
          ],
        };
      }
      return {role: 'user', content: message.text};
    }
    return {role: 'assistant', content: message.text || null,
      ...(message.reasoning || requiresReasoningContent ? {reasoning_content: message.reasoning ?? ''} : {}),
      ...(message.toolCalls?.length ? {tool_calls: message.toolCalls.map(call => ({
        id: call.id, type: 'function', function: {name: call.name, arguments: call.arguments},
      }))} : {})};
  });
}
export function anthropicMessages(messages: readonly ModelMessage[], maxImages = 2): ObjectValue[] {
  const imageIndices = messages
    .map((msg, i) => ('images' in msg && msg.images?.length ? i : -1))
    .filter(i => i >= 0);
  const activeImageIndices = new Set(imageIndices.slice(-maxImages));

  const result: {role: string; content: ObjectValue[]}[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const keepImage = activeImageIndices.has(i);
    const role = message.role === 'tool' ? 'user' : message.role;
    const content: ObjectValue[] = [];
    if (message.role === 'tool') {
      if (message.images?.length && keepImage) {
        const blocks: ObjectValue[] = [{type: 'text', text: message.text}];
        for (const img of message.images) {
          blocks.push({type: 'image', source: {type: 'base64', media_type: img.mimeType, data: img.data}});
        }
        content.push({type: 'tool_result', tool_use_id: message.callId, content: blocks, is_error: message.isError});
      } else {
        content.push({type: 'tool_result', tool_use_id: message.callId, content: message.text, is_error: message.isError});
      }
    } else if (message.role === 'assistant') {
      if (message.reasoning && message.signature) content.push({type: 'thinking', thinking: message.reasoning, signature: message.signature});
      if (message.text) content.push({type: 'text', text: message.text});
      for (const call of message.toolCalls ?? []) {
        let input: unknown;
        try {input = JSON.parse(call.arguments);} catch {input = {};}
        content.push({type: 'tool_use', id: call.id, name: call.name, input});
      }
    } else {
      if (message.images?.length && keepImage) {
        content.push({type: 'text', text: message.text});
        for (const img of message.images) {
          content.push({type: 'image', source: {type: 'base64', media_type: img.mimeType, data: img.data}});
        }
      } else {
        content.push({type: 'text', text: message.text});
      }
    }
    if (!content.length) continue;
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({role, content});
  }
  return result;
}
async function* events(response: Response, received: (length: number) => void): AsyncGenerator<StreamEvent> {
  if (!response.body) throw new ProviderError('模型没有返回响应内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.value?.length) received(chunk.value.length);
      buffer = (buffer + decoder.decode(chunk.value, {stream: !chunk.done})).replace(/\r\n/g, '\n');
      if (buffer.length > 4 * 1024 * 1024) throw new ProviderError('模型事件超过大小限制');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try {yield eventSchema.parse(JSON.parse(data));} catch {throw new ProviderError('模型流事件格式无效');}
      }
      if (chunk.done) {
        if (buffer.trim()) throw new ProviderError('模型事件未完整结束');
        return;
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw transportFailure(error, 'stream', response.status);
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
export function createProvider(settings: ModelSettings, fetcher: typeof fetch = fetch): Provider {
  return {async respond(request, onDelta, signal) {
    if (!settings.model) throw new ProviderError('尚未配置模型；使用 /model 名称或 --model 名称');
    const native = settings.kind === 'anthropic';
    const url = settings.baseUrl.replace(/\/$/, '') + (native ? '/messages' : '/chat/completions');
    const headers: Record<string, string> = {'content-type': 'application/json'};
    if (native) {
      headers['anthropic-version'] = '2023-06-01';
      if (settings.key) headers['x-api-key'] = settings.key;
    } else if (settings.key) headers.authorization = 'Bearer ' + settings.key;
    const tools = request.tools.map(tool => native
      ? {name: tool.name, description: tool.description, input_schema: tool.parameters}
      : {type: 'function', function: tool});
    const maxTokens = Math.min(settings.maxTokens, request.maxTokens ?? Infinity);
    const effort = request.thinking === false ? 'off' : settings.thinkingEffort ?? 'auto';
    const protocol = settings.thinkingProtocol;
    const thinking: ObjectValue = {};
    if (protocol) {
      if (effort !== 'auto' && request.thinking !== false && !settings.thinkingLevels?.includes(effort)) throw new ProviderError('模型不支持当前思考档位');
      if (protocol === 'anthropic-budget') {
        if (effort === 'off') thinking.thinking = {type: 'disabled'};
        else {
          const budget = Math.min(({low: 1024, medium: 4096, high: 8192, auto: 8192, max: 16384} as Record<string, number>)[effort] ?? 4096, maxTokens - 1);
          if (budget < 1024) throw new ProviderError('思考模式需要至少 1025 token 输出额度；提高 max_tokens 或关闭思考');
          thinking.thinking = {type: 'enabled', budget_tokens: budget};
        }
      } else if (protocol === 'anthropic-adaptive') {
        thinking.thinking = {type: effort === 'off' ? 'disabled' : 'adaptive'};
        if (effort !== 'off' && effort !== 'auto') thinking.output_config = {effort};
      } else if (protocol === 'deepseek') {
        thinking.thinking = {type: effort === 'off' ? 'disabled' : 'enabled'};
        if (effort !== 'off') thinking.reasoning_effort = effort === 'auto' ? 'low' : effort;
      } else thinking.reasoning_effort = effort === 'off' ? 'none' : effort;
    } else if (request.thinking === false && (native || settings.thinkingControl)) thinking.thinking = {type: 'disabled'};
    const supportsVision = request.supportsVision ?? true;
    const isStream = request.stream !== false;
    const body = native
      ? {model: settings.model, max_tokens: maxTokens, ...(thinking.thinking && effort !== 'off' ? {} : {temperature: settings.temperature}),
        ...(isStream ? {stream: true} : {}),
        system: request.system, messages: anthropicMessages(request.messages), tools, ...thinking}
      : {model: settings.model, max_tokens: maxTokens, temperature: settings.temperature,
        ...(isStream ? {stream: true, stream_options: {include_usage: true}} : {}),
        messages: [{role: 'system', content: request.system}, ...openaiMessages(request.messages, settings.thinkingControl, supportsVision)], tools,
        ...thinking};
    signal.throwIfAborted();
    const deadline = idleDeadline(signal, settings.timeoutMs), timed = deadline.signal;
    try {
      let response: Response;
      try {response = await fetcher(url, {method: 'POST', headers, body: JSON.stringify(body), signal: timed, redirect: 'error'});}
      catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        throw timed.aborted ? providerTimeout() : transportFailure(error, 'connection');
      }
      if (!response.ok) {
        const payload = await errorPayload(response);
        signal.throwIfAborted();
        if (timed.aborted) throw providerTimeout();
        throw providerFailure(response.status, payload);
      }
      let text = '', reasoning = '', signature = '';
      let stop: ModelTurn['stop'] = 'other';
      let usage: ModelTurn['usage'];
      const calls = new Map<number, ToolCall>();
      const append = (kind: Delta['kind'], value: unknown) => {
        if (typeof value !== 'string' || !value) return;
        if (kind === 'text') text += value; else reasoning += value;
        onDelta({kind, text: value});
      };
      const contentType = response.headers.get('content-type') || '';
      if (!isStream && !contentType.includes('text/event-stream')) {
        let payload: unknown;
        try {payload = await response.json();} catch {throw new ProviderError('模型返回的非流式响应格式无效');}
        const parsed = z.record(z.string(), z.unknown()).parse(payload);
        if (native) {
          const content = Array.isArray(parsed.content) ? parsed.content as Array<Record<string, unknown>> : [];
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') append('text', block.text);
            else if (block.type === 'thinking' && typeof block.thinking === 'string') {
              append('reasoning', block.thinking);
              if (typeof block.signature === 'string') signature = block.signature;
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              calls.set(calls.size, {
                id: typeof block.id === 'string' ? block.id : randomUUID(),
                name: block.name,
                arguments: block.input && typeof block.input === 'object' ? JSON.stringify(block.input) : '',
              });
            }
          }
          const reason = typeof parsed.stop_reason === 'string' ? parsed.stop_reason : undefined;
          stop = reason === 'tool_use' ? 'tools' : reason === 'max_tokens' ? 'length'
            : ['end_turn', 'stop_sequence'].includes(reason ?? '') ? 'complete' : 'other';
          if (parsed.usage && typeof parsed.usage === 'object') {
            const u = parsed.usage as Record<string, number>;
            usage = {input: u.input_tokens ?? 0, output: u.output_tokens ?? 0};
          }
        } else {
          const choices = Array.isArray(parsed.choices) ? parsed.choices as Array<Record<string, unknown>> : [];
          const first = choices[0];
          const msg = first?.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : undefined;
          if (msg) {
            if (typeof msg.content === 'string') append('text', msg.content);
            const r = msg.reasoning_content ?? msg.reasoning;
            if (typeof r === 'string') append('reasoning', r);
            if (Array.isArray(msg.tool_calls)) {
              for (let i = 0; i < msg.tool_calls.length; i++) {
                const tc = msg.tool_calls[i] as {id?: string; function?: {name?: string; arguments?: string}};
                calls.set(i, {
                  id: tc.id || randomUUID(),
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                });
              }
            }
          }
          const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason.toLowerCase() : undefined;
          stop = (finishReason === 'tool_calls' || finishReason === 'function_call' || calls.size > 0) ? 'tools'
            : (finishReason === 'length' || finishReason === 'max_tokens') ? 'length'
            : ['stop', 'end_turn', 'stop_sequence', 'eos', 'done'].includes(finishReason ?? '') ? 'complete' : 'other';
          if (parsed.usage && typeof parsed.usage === 'object') {
            const u = parsed.usage as Record<string, number>;
            usage = {input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0};
          }
        }
      } else {
        try {
          for await (const event of events(response, deadline.received)) {
          timed.throwIfAborted();
          if (hasProgress(event)) deadline.progress();
          if (calls.size > 128) throw new ProviderError('单次工具调用数量超过限制');
          if (native) {
            if (event.type === 'error') throw providerFailure(200, {error: event.error});
            if (event.type === 'message_start') {
              const value = event.message?.usage;
              usage = {input: (value?.input_tokens ?? 0) + (value?.cache_read_input_tokens ?? 0) + (value?.cache_creation_input_tokens ?? 0),
                output: 0, ...(value?.cache_read_input_tokens !== undefined ? {cacheRead: value.cache_read_input_tokens} : {}),
                ...(value?.cache_creation_input_tokens !== undefined ? {cacheWrite: value.cache_creation_input_tokens} : {})};
            }
            if (event.type === 'content_block_start') {
              const block = event.content_block;
              if (block?.type === 'tool_use' && event.index !== undefined) calls.set(event.index, {id: block.id ?? '', name: block.name ?? '', arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : ''});
              else if (block?.type === 'text') append('text', block.text);
              else if (block?.type === 'thinking') {append('reasoning', block.thinking); signature = block.signature ?? '';}
            }
            if (event.type === 'content_block_delta') {
              const delta = event.delta;
              if (delta?.type === 'text_delta') append('text', delta.text);
              if (delta?.type === 'thinking_delta') append('reasoning', delta.thinking);
              if (delta?.type === 'signature_delta') signature += delta.signature ?? '';
              if (delta?.type === 'input_json_delta') {
                const call = event.index === undefined ? undefined : calls.get(event.index);
                if (call) call.arguments += delta.partial_json ?? '';
              }
            }
            if (event.type === 'message_delta') {
              const reason = event.delta?.stop_reason;
              stop = reason === 'tool_use' ? 'tools' : reason === 'max_tokens' ? 'length'
                : ['end_turn', 'stop_sequence'].includes(reason ?? '') ? 'complete' : 'other';
              if (usage && typeof event.usage?.output_tokens === 'number') usage.output = event.usage.output_tokens;
            }
          } else {
            if (event.error) throw providerFailure(200, {error: event.error});
            const choice = event.choices?.[0];
            const delta = choice?.delta;
            append('text', delta?.content);
            append('reasoning', delta?.reasoning_content || delta?.reasoning);
            for (const item of delta?.tool_calls ?? []) {
              const call = calls.get(item.index) ?? {id: '', name: '', arguments: ''};
              if (item.id) call.id += item.id;
              if (item.function?.name) call.name += item.function.name;
              if (item.function?.arguments) call.arguments += item.function.arguments;
              calls.set(item.index, call);
            }
            if (choice?.finish_reason) {
              const fr = choice.finish_reason.toLowerCase();
              stop = (fr === 'tool_calls' || fr === 'function_call') ? 'tools'
                : (fr === 'length' || fr === 'max_tokens') ? 'length'
                : ['stop', 'end_turn', 'stop_sequence', 'eos', 'done'].includes(fr) ? 'complete' : 'other';
            }
            if (event.usage) {
              const cached = event.usage.prompt_tokens_details?.cached_tokens ?? event.usage.prompt_cache_hit_tokens ?? event.usage.cached_tokens;
              usage = {input: event.usage.prompt_tokens ?? 0, output: event.usage.completion_tokens ?? 0, ...(cached !== undefined ? {cacheRead: cached} : {})};
            }
          }
        }
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (timed.aborted) throw providerTimeout();
        throw error;
      }
    }
      const toolCalls = [...calls.values()];
      return {message: {role: 'assistant', text, ...(reasoning ? {reasoning} : {}),
        ...(signature ? {signature} : {}), ...(toolCalls.length ? {toolCalls} : {})}, stop,
        ...(usage ? {usage} : {})};
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof ProviderError && (error.diagnostic?.phase || isProviderTimeout(error))) {
        const observed = deadline.observation();
        const seconds = (ms: number) => (ms / 1000).toFixed(1) + 's';
        const detail = '传输诊断：请求运行 ' + seconds(observed.elapsedMs) + '；距上次模型进展 ' + seconds(observed.progressIdleMs) +
          '；' + (observed.transportIdleMs === undefined ? '尚未收到响应数据' : '距上次数据 ' + seconds(observed.transportIdleMs)) +
          '；接收 ' + observed.receivedBytes + ' 字节。';
        throw new ProviderError(error.message + '\n' + detail, error.retryable, error.category, {...error.diagnostic, ...observed});
      }
      throw error;
    } finally {deadline.close();}
  }};
}
