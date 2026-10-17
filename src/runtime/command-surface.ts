/** 命令界面只传公开数据；认证与业务回调不进入快照。 */
export interface PickerItem {readonly id: string; readonly label: string; readonly description?: string | undefined; readonly disabled?: boolean | undefined; readonly deletable?: boolean | undefined; readonly color?: string | undefined; readonly effort?: string | undefined; readonly effortLevels?: readonly string[] | undefined}
export interface CommandToggle {readonly id: string; readonly label?: string; readonly enabled: boolean}
export interface CommandTab {readonly id: string; readonly title: string; readonly lines: readonly string[]; readonly toggles?: readonly CommandToggle[]; readonly color?: string}
export type CommandSurface =
  | {readonly id: string; readonly kind: 'picker'; readonly title: string; readonly description: string;
      readonly items: readonly PickerItem[]; readonly current: string; readonly status: 'loading' | 'ready' | 'saving'; readonly error: string; readonly deleteLabel?: string;
      readonly effort?: string; readonly effortLevels?: readonly string[]}
  | {readonly id: string; readonly kind: 'page'; readonly title: string; readonly tabs: readonly CommandTab[]; readonly initialTab: string;
      readonly saving?: boolean; readonly error?: string};
export interface CommandResult {readonly message?: string}
