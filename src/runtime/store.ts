import {randomUUID} from 'node:crypto';
import {Activities} from './activities.js';
import {Interactions} from './interactions.js';
import {immutable, type Message, type RuntimeSnapshot} from './contracts.js';

export class RuntimeStore {
  private readonly listeners = new Set<() => void>();
  private readonly messages: Message[] = [];
  private snapshot: RuntimeSnapshot = immutable({revision: 0, activities: [], interactions: [], messages: []});
  private publishTimer: ReturnType<typeof setTimeout> | undefined;

  readonly activities = new Activities(() => this.publish());
  readonly interactions = new Interactions(() => this.publish());
  readonly getSnapshot = (): RuntimeSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  flush(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
      for (const listener of this.listeners) listener();
    }
  }

  message(sessionId: string, ownerId: string, role: Message['role'], text: string, origin: Pick<Message, 'activityId' | 'source' | 'kind' | 'time' | 'inputKind' | 'step'> = {}): string {
    const id = randomUUID();
    this.messages.push(immutable({id, sessionId, ownerId, role, text, time: Date.now(), ...origin}));
    this.publish();
    return id;
  }
  system(event: {id: string; sessionId: string; ownerId: string; text: string; time: number; activityId?: string | undefined}): void {
    if (this.messages.some(message => message.id === event.id)) return;
    const {id, sessionId, ownerId, text, time, activityId} = event;
    this.messages.push(immutable({id, sessionId, ownerId, text, time, role: 'system' as const,
      ...(activityId ? {activityId} : {})}));
    this.messages.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    this.publish();
  }
  appendMessage(id: string, text: string): void {
    const index = this.messages.findIndex(message => message.id === id);
    const message = this.messages[index];
    if (!message) throw new Error('Message not found: ' + id);
    this.messages[index] = immutable({...message, text: message.text + text});
    this.snapshot = immutable({
      revision: this.snapshot.revision + 1,
      activities: [...this.activities.list()],
      interactions: [...this.interactions.list()],
      messages: [...this.messages],
    });
    if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => {
        this.publishTimer = undefined;
        for (const listener of this.listeners) listener();
      }, 40);
      this.publishTimer.unref?.();
    }
  }
  updateMessage(id: string, patch: Partial<Pick<Message, 'text' | 'step'>>): void {
    const index = this.messages.findIndex(message => message.id === id);
    const message = this.messages[index];
    if (!message) throw new Error('Message not found: ' + id);
    this.messages[index] = immutable({...message, ...patch}); this.publish();
  }
  clearTimeline(sessionId: string): void {
    this.activities.clearSession(sessionId);
    for (let index = this.messages.length - 1; index >= 0; index--) if (this.messages[index]?.sessionId === sessionId) this.messages.splice(index, 1);
    this.publish();
  }
  private publish(): void {
    this.flush();
    this.snapshot = immutable({
      revision: this.snapshot.revision + 1,
      activities: [...this.activities.list()],
      interactions: [...this.interactions.list()],
      messages: [...this.messages],
    });
    for (const listener of this.listeners) listener();
  }
}
