import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, rm, writeFile} from 'node:fs/promises';

/**
 * Returns the scratchpad directory path for the current session.
 * Path format: <tmpdir>/logox-scratchpad/<cwd-hash>/<sessionId>/
 * This isolates temporary files completely from the user's project directory.
 */
export function getScratchpadDir(cwd: string, sessionId: string): string {
  const cwdHash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return join(tmpdir(), 'logox-scratchpad', cwdHash, sessionId);
}

/**
 * Ensures the scratchpad directory exists on disk.
 */
export async function ensureScratchpadDir(cwd: string, sessionId: string): Promise<string> {
  const dir = getScratchpadDir(cwd, sessionId);
  await mkdir(dir, {recursive: true});
  return dir;
}

/**
 * Checks if a path is inside the scratchpad directory.
 */
export function isScratchpadPath(path: string, scratchpadDir: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const target = scratchpadDir.replaceAll('\\', '/').toLowerCase();
  return normalized === target || normalized.startsWith(target.endsWith('/') ? target : target + '/');
}

/**
 * Cleans up scratchpad directory.
 */
export async function cleanScratchpadDir(cwd: string, sessionId: string): Promise<void> {
  const dir = getScratchpadDir(cwd, sessionId);
  await rm(dir, {recursive: true, force: true}).catch(() => {});
}

/**
 * Persists large tool results (>32KB) to disk, matching Claude Code's <persisted-output> mechanism.
 */
export async function maybePersistLargeOutput(text: string, cwd: string, callId: string, sessionId?: string): Promise<string> {
  if (text.length <= 32768 || text.includes('<persisted-output>')) return text;
  try {
    const dir = sessionId ? join(getScratchpadDir(cwd, sessionId), 'tool-results') : join(cwd, '.logox', 'tool-results');
    await mkdir(dir, {recursive: true});
    const file = join(dir, `${callId || randomUUID()}.txt`);
    await writeFile(file, text, 'utf8');
    const preview = text.slice(0, 2048);
    const sizeKb = (text.length / 1024).toFixed(1);
    return `<persisted-output>\nOutput too large (${sizeKb}KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`;
  } catch {
    return text;
  }
}

/**
 * Formats system prompt instructions for using the scratchpad directory.
 * Modeled after Claude Code's getScratchpadInstructions().
 */
export function getScratchpadPromptSection(scratchpadDir: string): string {
  return `# Scratchpad Directory
Always use this directory for temporary probe scripts, calculations, and intermediate files instead of the project directory:
\`${scratchpadDir}\``;
}
