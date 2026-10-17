import type {Activity, Step} from './contracts.js';
import {randomUUID} from 'node:crypto';
import type {ToolCall} from './messages.js';
import {RuntimeStore} from './store.js';

export function stepElapsed(step: Step, now = Date.now()): number {
  return step.elapsedMs + (step.state === 'running' && step.runningSince !== undefined ? Math.max(0, now - step.runningSince) : 0);
}
export function toolTitle(call: ToolCall): string {
  try {
    const args: unknown = JSON.parse(call.arguments);
    if (args && typeof args === 'object') {
      for (const key of ['path', 'command', 'tool', 'ownerId', 'name']) {
        const value: unknown = Reflect.get(args, key);
        if (typeof value === 'string') return call.name + ' ' + value.replace(/\s+/g, ' ').slice(0, 90);
      }
    }
  } catch {}
  return call.name;
}

/** Runtime owns each request/call clock. Rendering samples it without publishing timer ticks. */
export class Steps {
  private readonly ids = new Set<string>();
  private readonly stepsCache = new Map<string, Step>();
  private groupId: string | undefined;
  private groupThinking: string | undefined;
  constructor(private readonly store: RuntimeStore, private readonly identity: {sessionId: string; ownerId: string; activityId: string},
    private readonly now: () => number = Date.now, private readonly currentStage: () => Step['stage'] = () => undefined) {}
  phase(phase: NonNullable<Activity['phase']>): void {
    const activity = this.store.activities.get(this.identity.sessionId, this.identity.activityId);
    if (activity && !['completed', 'failed', 'cancelled'].includes(activity.status)) this.store.activities.update(this.identity.sessionId, this.identity.activityId, {phase});
  }
  thinking(): string {
    this.phase('model');
    this.endGroup('completed');
    this.groupId = randomUUID();
    this.groupThinking = this.create('thinking', {title: 'Thinking', groupId: this.groupId, state: 'running', elapsedMs: 0, runningSince: this.now()}, '');
    return this.groupThinking;
  }
  endGroup(state: 'completed' | 'failed' | 'cancelled'): void {
    if (this.groupThinking) this.store.updateMessage(this.groupThinking, {step: {...this.get(this.groupThinking), groupState: state}});
    this.groupId = undefined; this.groupThinking = undefined;
  }
  tool(call: ToolCall): string {
    return this.create('tool', {title: toolTitle(call), callId: call.id, ...(this.groupId ? {groupId: this.groupId} : {}), state: 'queued', elapsedMs: 0}, call.name + '\n' + call.arguments);
  }
  private create(kind: 'thinking' | 'tool', step: Step, text: string): string {
    const stage = this.currentStage();
    if (stage) step = {...step, stage};
    const id = this.store.message(this.identity.sessionId, this.identity.ownerId, kind === 'tool' ? 'notice' : 'assistant', text,
      {activityId: this.identity.activityId, kind, step});
    this.ids.add(id);
    this.stepsCache.set(id, step);
    return id;
  }
  get(id: string): Step {
    const fromStore = this.store.getSnapshot().messages.find(message => message.id === id)?.step;
    if (fromStore) {
      this.stepsCache.set(id, fromStore);
      return fromStore;
    }
    const cached = this.stepsCache.get(id);
    if (cached) return cached;
    throw new Error('Step not found: ' + id);
  }
  start(id: string): void {
    const step = this.get(id);
    if (['completed', 'failed', 'cancelled', 'running'].includes(step.state)) return;
    this.phase('tool');
    const updated = {...step, state: 'running' as const, runningSince: this.now(), waiting: undefined};
    this.stepsCache.set(id, updated);
    this.store.updateMessage(id, {step: updated});
  }
  wait(id: string, reason: string): () => void {
    const previous = this.get(id);
    if (['completed', 'failed', 'cancelled'].includes(previous.state)) return () => {};
    const {runningSince: _, ...step} = previous;
    this.store.updateMessage(id, {step: {...step, state: 'waiting', elapsedMs: stepElapsed(previous, this.now()), waiting: reason}});
    const r = reason.toLowerCase();
    this.phase(reason.includes('许可') || reason.includes('审批') || r.includes('approval') || r.includes('permission') ? 'approval'
      : reason.includes('重试') || r.includes('retry') ? 'retry'
      : 'question');
    let restored = false;
    return () => {
      if (restored || this.get(id).state !== 'waiting') return;
      restored = true;
      this.store.updateMessage(id, {step: {...this.get(id), state: previous.state, waiting: undefined,
        ...(previous.state === 'running' ? {runningSince: this.now()} : {})}});
      this.phase(previous.state === 'running' && step.title === 'Thinking' ? 'model' : 'tool');
    };
  }
  finish(id: string, state: 'completed' | 'failed' | 'cancelled', text?: string, disposition?: Step['disposition']): Step {
    const previous = this.get(id), {runningSince: _, waiting: __, ...rest} = previous;
    const step: Step = {...rest, state, elapsedMs: stepElapsed(previous, this.now()), ...(disposition ? {disposition} : {})};
    this.stepsCache.set(id, step);
    try {
      this.store.updateMessage(id, {step, ...(text !== undefined ? {text} : {})});
    } catch {}
    return step;
  }
  close(state: 'completed' | 'failed' | 'cancelled'): void {
    for (const id of this.ids) if (!['completed', 'failed', 'cancelled'].includes(this.get(id).state)) this.finish(id, state);
    this.endGroup(state);
  }
}
