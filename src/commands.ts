export const commandCatalog = [
  {name: 'help', usage: '/help', description: 'View available commands and keybindings', argument: 'none'},
  {name: 'login', usage: '/login [provider]', description: 'Log in and save provider API key', argument: 'loginProvider'},
  {name: 'provider', usage: '/provider [name|check] [model]', description: 'Switch or test provider (/provider to choose, /provider check to test connection)', argument: 'provider'},
  {name: 'model', usage: '/model [actor]', description: 'Open model picker (defaults to active window, or specify an actor)', argument: 'model'},
  {name: 'status', usage: '/status', description: 'View model, usage, permissions, and session status', argument: 'none'},
  {name: 'config', usage: '/config', description: 'View current active configuration', argument: 'none'},
  {name: 'cast', usage: '/cast task', description: 'Dispatch task across actor ensemble', argument: 'text'},
  {name: 'actors', usage: '/actors [model actor]', description: 'View actor responsibilities, compaction settings, and default models', argument: 'none'},
  {name: 'compact', usage: '/compact', description: 'Compact current role context while preserving ledgers', argument: 'none'},
  {name: 'new', usage: '/new', description: 'Create and switch to a new session', argument: 'none'},
  {name: 'resume', usage: '/resume [session-id]', description: 'Select or resume a session from history', argument: 'none'},
  {name: 'clear', usage: '/clear', description: 'Clear conversation screen while preserving model context and files', argument: 'none'},
  {name: 'rewind', usage: '/rewind', description: 'Select turn to rewind conversation and file edits', argument: 'none'},
  {name: 'undo', usage: '/undo', description: 'Undo file changes made in the latest turn', argument: 'none'},
  {name: 'permissions', usage: '/permissions', description: 'Open permissions page to view and toggle mode or manage rules', argument: 'none'},
  {name: 'reload', usage: '/reload', description: 'Reload personas, guidelines, skills, and template commands', argument: 'none'},
  {name: 'skills', usage: '/skills', description: 'View available skill names, descriptions, and file paths', argument: 'none'},
  {name: 'ensemble', usage: '/ensemble', description: 'View and inspect ensemble actor roster and personas', argument: 'none'},
] as const;

/** Public names only; TUI does not read auth or make remote requests during typing. */
export interface CommandContext {
  readonly providers: readonly string[];
  readonly loginProviders: readonly string[];
  readonly models: readonly string[];
  readonly actors?: readonly string[];
  readonly customCommands?: readonly {name: string; description: string}[];
}
export const emptyCommandContext: CommandContext = {providers: [], loginProviders: [], models: []};
export function commandHelp(): string {
  return commandCatalog.map(command => command.usage + ': ' + command.description).join('\n');
}
