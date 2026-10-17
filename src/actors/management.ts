import {readFile} from 'node:fs/promises';
import type {ProviderRegistry} from '../providers/registry.js';
import type {CommandSurfaces} from '../commands/surfaces.js';
import type {CommandTab} from '../runtime/command-surface.js';
import {immutable} from '../runtime/contracts.js';
import {ActorCatalog, assertActorPath} from './catalog.js';
import {actorModelSchema, parseActor, serializeActor, type ActorModel} from './definitions.js';
import type {ContextPolicy} from '../config/config.js';
import {detectEffortLevels} from '../config/model-grouping.js';

export interface ActorWriteReview {readonly path: string; readonly content: string; readonly previous: string | undefined; readonly operation: 'craft_actor'}
export interface CraftResult {readonly status: 'saved' | 'denied'; readonly path: string; readonly revision: number}
export class ActorManagement {
  constructor(readonly catalog: ActorCatalog, private readonly registry: Pick<ProviderRegistry, 'modelCatalog'>,
    private readonly requireIdle: () => void = () => {}, private readonly policy?: (ownerId: string) => ContextPolicy) {}
  tab(): CommandTab {
    return immutable({id: 'actors', title: 'Ensemble', lines: this.catalog.list().flatMap(actor => {
      const policy = this.policy?.(actor.id) ?? actor.context;
      return [
        '── ' + actor.symbol + ' ' + actor.name + ' (' + actor.title + ') ' + '─'.repeat(30),
        'Description: ' + actor.description,
        'Designated model: ' + (actor.defaultModel ? actor.defaultModel.provider + '/' + actor.defaultModel.model : 'Inherits session model (switch via /model ' + actor.id + ')'),
        'Context retention: ' + policy.keep_recent_rounds + ' rounds / ' + policy.keep_recent_tools + ' tools',
        'Context policy: ' + JSON.stringify(policy),
        'Skills: ' + (actor.skills.join(', ') || 'Declared on-demand'),
        'Persona prompt: ' + actor.prompt.slice(0, 150).replace(/\n/g, ' ') + '...',
        '',
      ];
    })});
  }
  private async previous(id: string): Promise<string | undefined> {
    const path = this.catalog.projectPath(id); await assertActorPath(path);
    try {return await readFile(path, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
  }
  async saveDefaultModel(id: string, model: ActorModel | undefined, signal: AbortSignal): Promise<string> {
    this.requireIdle();
    if (id === 'logox') throw new Error('Logox 使用当前会话模型，请通过 /model 设置');
    const actor = this.catalog.find(id); if (!actor) throw new Error('角色不存在');
    if (model) {
      const selected = actorModelSchema.parse(model); model = selected;
      const result = await this.registry.modelCatalog(signal); signal.throwIfAborted();
      if (!result.models.some(item => item.provider === selected.provider && item.id === selected.model)) throw new Error('模型不在当前可用目录中');
    }
    const previous = await this.previous(id); signal.throwIfAborted();
    this.requireIdle();
    const {defaultModel: _old, ...rest} = previous === undefined ? actor : parseActor(previous);
    const path = await this.catalog.writeProject(id, serializeActor({...rest, ...(model ? {defaultModel: model} : {})}), previous);
    const state = await this.catalog.reload(); if (state.issues.length) throw new Error('文件已保存，热载失败：' + state.issues.map(item => item.reason).join('；'));
    return path;
  }
  async openDefaultModel(id: string, surfaces: CommandSurfaces): Promise<void> {
    const actor = this.catalog.find(id); if (!actor) throw new Error('角色不存在');
    const choices = new Map<string, ActorModel | undefined>([['inherit', undefined]]);
    await surfaces.openPicker({title: actor.name + ' 默认模型', description: '确认只改变此角色，取消不保存',
      current: actor.defaultModel ? JSON.stringify(actor.defaultModel) : 'inherit'}, async signal => {
      const result = await this.registry.modelCatalog(signal);
      for (const item of result.models) choices.set(JSON.stringify({provider: item.provider, model: item.id}), {provider: item.provider, model: item.id});
      const items = [
        {id: 'inherit', label: '继承当前会话模型'},
        ...result.models.map(item => {
          const choiceId = JSON.stringify({provider: item.provider, model: item.id});
          const levels = detectEffortLevels(item.id, item.provider);
          return {
            id: choiceId,
            label: item.provider + ' / ' + item.id,
            effort: levels.includes('high') ? 'high' : (levels[0] ?? 'auto'),
            effortLevels: levels.length > 1 ? levels : undefined,
          };
        }),
      ];
      return {items, warning: result.issues.join('；')};
    }, async choice => {
      if (!choices.has(choice)) throw new Error('模型选项无效');
      await this.saveDefaultModel(id, choices.get(choice), new AbortController().signal);
      return {message: actor.name + ' 默认模型已保存'};
    });
  }
  async craftActor(content: string, approve: (review: ActorWriteReview) => Promise<boolean>, signal: AbortSignal): Promise<CraftResult> {
    const actor = parseActor(content), path = this.catalog.projectPath(actor.id), previous = await this.previous(actor.id);
    const accepted = await approve(immutable({path, content, previous, operation: 'craft_actor'})); signal.throwIfAborted();
    if (!accepted) return {status: 'denied', path, revision: this.catalog.snapshot().revision};
    await this.catalog.writeProject(actor.id, content, previous);
    const state = await this.catalog.reload(); if (state.issues.length) throw new Error('文件已保存，热载失败：' + state.issues.map(item => item.reason).join('；'));
    return {status: 'saved', path, revision: state.revision};
  }
}
