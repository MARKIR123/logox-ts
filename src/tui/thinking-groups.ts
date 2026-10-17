import type {Message, Step} from '../runtime/contracts.js';
import {estimateText} from '../context/budget.js';

export interface ThinkingRequest {
  readonly id: string;
  readonly step: Step;
  readonly tokens: number;
}

const tokenCache = new WeakMap<Message, number>();

/** One request owns one clock and one readable card, with WeakMap memoization to eliminate render-loop token estimation overhead. */
export function thinkingRequests(messages: readonly Message[]): ReadonlyMap<string, ThinkingRequest> {
  const result = new Map<string, ThinkingRequest>();
  for (const message of messages) {
    if (message.kind !== 'thinking') continue;
    let tokens = tokenCache.get(message);
    if (tokens === undefined) {
      tokens = estimateText(message.text);
      tokenCache.set(message, tokens);
    }
    result.set(message.id, {
      id: message.id,
      step: message.step ?? {title: 'Thinking', state: 'completed', elapsedMs: 0},
      tokens,
    });
  }
  return result;
}
