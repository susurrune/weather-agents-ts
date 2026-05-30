import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import {
  detectBestWorkspaceRoot,
  resolveWorkspacePath,
  initWorkspace,
  formatBytes,
} from '../src/core/workspace.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-ws-'));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(512)).toBe('512.0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

describe('resolveWorkspacePath', () => {
  it('"auto" resolves to a detected absolute root', () => {
    const p = resolveWorkspacePath('auto');
    expect(isAbsolute(p)).toBe(true);
    expect(p).toBe(detectBestWorkspaceRoot());
  });
  it('explicit path is resolved absolute', () => {
    const p = resolveWorkspacePath(dir);
    expect(isAbsolute(p)).toBe(true);
  });
});

describe('initWorkspace', () => {
  it('creates the files/output/temp tree + .workspace marker (idempotent)', () => {
    const root = join(dir, 'ws');
    initWorkspace(root);
    for (const sub of ['files', 'output', 'temp']) {
      expect(existsSync(join(root, sub))).toBe(true);
    }
    expect(existsSync(join(root, '.workspace'))).toBe(true);
    // second call must not throw
    expect(() => initWorkspace(root)).not.toThrow();
  });
});
