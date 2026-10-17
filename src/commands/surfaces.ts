import {randomUUID} from 'node:crypto';
import {immutable} from '../runtime/contracts.js';
import type {CommandSurface, CommandTab, CommandToggle, CommandResult, PickerItem} from '../runtime/command-surface.js';
export type PickerSpec = Pick<Extract<CommandSurface, {kind: 'picker'}>, 'title' | 'description' | 'current'> & {
  readonly effort?: string;
  readonly effortLevels?: readonly string[];
};
export interface PickerActions {readonly deleteLabel: string; onDelete(id: string): void | Promise<void>}
export interface PageActions {
  onSaveToggles(tabId: string, items: readonly CommandToggle[]): CommandResult | Promise<CommandResult>;
  onTabAction?(tabId: string, action: string): CommandResult | Promise<CommandResult>;
}
/** 拥有命令界面生命周期；回调与查询取消信号留在业务层。 */
export class CommandSurfaces {
  private state: CommandSurface | null = null;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private select: ((id: string, effort?: string) => CommandResult | Promise<CommandResult>) | undefined;
  private pickerActions: PickerActions | undefined;
  private pageActions: PageActions | undefined;
  getSnapshot = (): CommandSurface | null => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  constructor(private readonly onDone: (result: CommandResult) => void) {}
  private publish(state: CommandSurface | null): void {this.state = immutable(state); for (const listener of this.listeners) listener();}
  private assertIdle(): void {if (this.state) throw new Error('Please close current command surface first');}
  openPage(title: string, tabs: readonly CommandTab[], initialTab: string, actions?: PageActions): void {
    this.assertIdle();
    if (!tabs.length || !tabs.some(tab => tab.id === initialTab)) throw new Error('Page missing valid tab');
    this.pageActions = actions;
    this.publish({id: randomUUID(), kind: 'page', title, tabs, initialTab});
  }
  async saveToggles(surfaceId: string, tabId: string, items: readonly CommandToggle[]): Promise<void> {
    const state = this.state, actions = this.pageActions;
    if (state?.kind !== 'page' || state.id !== surfaceId || state.saving || !actions) return;
    const tab = state.tabs.find(tab => tab.id === tabId);
    if (!tab?.toggles || items.length !== tab.toggles.length || new Set(items.map(item => item.id)).size !== items.length ||
      items.some(item => !tab.toggles!.some(original => original.id === item.id))) return;
    this.publish({...state, saving: true, error: ''});
    try {
      const result = await actions.onSaveToggles(tabId, immutable([...items]));
      if (this.state?.id === surfaceId) {this.dismiss(); this.onDone(result);}
    } catch (error) {
      if (this.state?.id === surfaceId) this.publish({...state, saving: false, error: error instanceof Error ? error.message : 'Save failed'});
    }
  }
  async triggerTabAction(surfaceId: string, tabId: string, action: string): Promise<void> {
    const state = this.state, actions = this.pageActions;
    if (state?.kind !== 'page' || state.id !== surfaceId || state.saving || !actions?.onTabAction) return;
    try {
      const result = await actions.onTabAction(tabId, action);
      if (result?.message) this.onDone(result);
    } catch (error) {
      if (this.state?.id === surfaceId) this.publish({...state, error: error instanceof Error ? error.message : 'Operation failed'});
    }
  }
  updatePage(tabs: readonly CommandTab[]): void {if (this.state?.kind === 'page') this.publish({...this.state, tabs});}
  async openPicker(spec: PickerSpec, load: (signal: AbortSignal) => Promise<{items: readonly PickerItem[]; warning?: string}>,
    select: (id: string, effort?: string) => CommandResult | Promise<CommandResult>, actions?: PickerActions): Promise<void> {
    this.assertIdle();
    const id = randomUUID(), controller = new AbortController();
    this.controller = controller; this.select = select; this.pickerActions = actions;
    this.publish({id, kind: 'picker', ...spec, items: [], status: 'loading', error: '', ...(actions ? {deleteLabel: actions.deleteLabel} : {})});
    try {
      const result = await load(controller.signal);
      if (this.state?.id === id && this.state.kind === 'picker' && !controller.signal.aborted)
        this.publish({...this.state, items: result.items, status: 'ready', error: result.warning ?? ''});
    } catch (error) {
      if (this.state?.id === id && this.state.kind === 'picker' && !controller.signal.aborted)
        this.publish({...this.state, status: 'ready', error: error instanceof Error ? error.message : 'Query failed'});
    }
  }
  async replacePicker(...args: Parameters<CommandSurfaces['openPicker']>): Promise<void> {
    this.dismiss(); await this.openPicker(...args);
  }
  async deleteItem(surfaceId: string, itemId: string): Promise<void> {
    const state = this.state, actions = this.pickerActions;
    if (state?.kind !== 'picker' || state.id !== surfaceId || state.status !== 'ready' || !actions) return;
    if (!state.items.some(item => item.id === itemId && item.deletable)) return;
    this.publish({...state, status: 'saving', error: ''});
    try {await actions.onDelete(itemId); if (this.state?.id === surfaceId) this.publish({...state, status: 'ready'});}
    catch (error) {if (this.state?.id === surfaceId) this.publish({...state, error: error instanceof Error ? error.message : 'Delete failed'});}
  }
  async choose(surfaceId: string, itemId: string, effort?: string): Promise<void> {
    const state = this.state;
    if (!state || state.kind !== 'picker' || state.id !== surfaceId || state.status !== 'ready' || !this.select) return;
    const item = state.items.find(item => item.id === itemId);
    if (!item || item.disabled) return;
    const select = this.select;
    this.publish({...state, status: 'saving', error: ''});
    try {
      const result = await select(itemId, effort);
      if (this.state?.id === surfaceId) {this.dismiss(); this.onDone(result);}
    } catch (error) {
      if (this.state?.id === surfaceId) this.publish({...state, error: error instanceof Error ? error.message : 'Operation failed'});
    }
  }
  cancel(): void {if (this.state?.kind === 'page' ? !this.state.saving : this.state?.kind !== 'picker' || this.state.status !== 'saving') this.dismiss();}
  private dismiss(): void {this.controller?.abort(); this.controller = undefined; this.select = undefined; this.pickerActions = undefined; this.pageActions = undefined; this.publish(null);}
  close(): void {this.dismiss();}
}
