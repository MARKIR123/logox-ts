import stringWidth from 'string-width';
import type {StageStatus} from '../runtime/stage-status.js';
import {defaultStatusbar, type StatusbarId, type StatusbarModule} from '../config/statusbar-preferences.js';
import {permissionModes} from '../runtime/permission-mode.js';

function translateState(state: string): string {
  switch (state) {
    case '就绪': return 'ready';
    case '运行中': return 'running';
    case '排队中': case '排队': return 'queued';
    case '待回答': case '等待回答': return 'waiting';
    case '已暂停': return 'paused';
    case '已完成': return 'completed';
    case '失败': return 'failed';
    case '已停止': case '已取消': return 'cancelled';
    default: return state;
  }
}

function moduleText(id: StatusbarId, status: StageStatus): string {
  switch (id) {
    case 'role': return status.name;
    case 'model': return status.model ? status.model.provider + '/' + status.model.model : 'No model';
    case 'effort': return 'Thinking ' + (status.effort ?? 'unsupported');
    case 'permission': return 'Permission ' + (status.permission ?? 'none');
    case 'context': return status.context ? 'Context ' + Math.round(status.context.tokens / Math.max(1, status.context.window) * 100) + '%' : 'Context N/A';
    case 'state': return translateState(status.state);
    case 'tokens': return 'Tokens ' + (status.tokens === undefined ? 'N/A' : status.tokens.toLocaleString('en-US'));
    case 'cost': return status.cost === undefined ? 'Cost N/A' : 'Cost ' + (status.costCurrency ? status.costCurrency + ' ' : '') + status.cost.toFixed(4);
    case 'session': return 'Session ' + (status.session ?? 'unsaved');
    case 'project': return status.project ?? 'Project N/A';
  }
}

/** 模块顺序同时决定窄屏优先级，整项收起，不截出半个字段。 */
export function statusbarText(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar): string {
  return statusbarParts(status, width, modules).map(part => part.text).join(' · ');
}
export function statusbarParts(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar): {text: string; color?: string}[] {
  const parts: {text: string; color?: string}[] = [];
  for (const module of modules) {
    if (!module.enabled) continue;
    const part = moduleText(module.id, status);
    if (stringWidth([...parts.map(item => item.text), part].join(' · ')) > width) break;
    const mode = status.permission;
    const color = module.id === 'permission' && mode && Object.hasOwn(permissionModes, mode) ? permissionModes[mode as keyof typeof permissionModes].color : undefined;
    parts.push({text: part, ...(color ? {color} : {})});
  }
  return parts;
}
