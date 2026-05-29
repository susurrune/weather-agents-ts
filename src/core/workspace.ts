/**
 * Workspace auto-detection and lifecycle management.
 *
 * - First launch: auto-select best drive, create workspace/
 * - Windows multi-drive: skip C:, pick drive with most free space
 * - Windows single drive (C: only): use C:\workspace
 * - Unix: use ~/workspace
 * - User can override via config workspace.path
 */

import { existsSync, mkdirSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKSPACE_SUBDIRS = ['files', 'output', 'temp'];

export interface DriveInfo {
  letter: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
}

function getDriveList(): DriveInfo[] {
  const drives: DriveInfo[] = [];
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;
      if (!existsSync(root)) continue;
      try {
        const s = statfsSync(root);
        drives.push({
          letter,
          path: root,
          totalBytes: Number(s.blocks) * Number(s.bsize),
          freeBytes: Number(s.bavail) * Number(s.bsize),
        });
      } catch {
        continue;
      }
    }
  } else {
    try {
      const s = statfsSync('/');
      drives.push({
        letter: '',
        path: '/',
        totalBytes: Number(s.blocks) * Number(s.bsize),
        freeBytes: Number(s.bavail) * Number(s.bsize),
      });
    } catch {
      /* none */
    }
  }
  return drives;
}

/** Pick the best drive for the workspace directory. */
export function detectBestWorkspaceRoot(): string {
  const drives = getDriveList();
  if (process.platform === 'win32') {
    let candidates = drives.filter((d) => d.letter.toUpperCase() !== 'C');
    if (candidates.length === 0) candidates = drives;
    candidates.sort((a, b) => b.freeBytes - a.freeBytes);
    const best = candidates[0];
    return best ? join(best.path, 'workspace') : join(homedir(), 'workspace');
  }
  return join(homedir(), 'workspace');
}

/** Resolve workspace path from config ("auto" → detect; else expand ~ and resolve). */
export function resolveWorkspacePath(configValue: string): string {
  if (configValue.toLowerCase() === 'auto') {
    return detectBestWorkspaceRoot();
  }
  const expanded = configValue.startsWith('~')
    ? join(homedir(), configValue.slice(1))
    : configValue;
  return resolve(expanded);
}

/** Create the workspace directory tree on first use. Idempotent. */
export function initWorkspace(root: string): string {
  mkdirSync(root, { recursive: true });
  for (const sub of WORKSPACE_SUBDIRS) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  const marker = join(root, '.workspace');
  if (!existsSync(marker)) {
    writeFileSync(
      marker,
      `# Weather Agents workspace — created automatically\npath: ${root}\n`,
      'utf-8',
    );
  }
  return root;
}

/** Human-readable byte count (e.g. 128.5 GB). */
export function formatBytes(n: number): string {
  let val = n;
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (Math.abs(val) < 1024.0) return `${val.toFixed(1)} ${unit}`;
    val /= 1024.0;
  }
  return `${val.toFixed(1)} PB`;
}
