import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinTools, validateUrl, isProtectedPath } from '../src/tools/builtin.js';
import { ToolRegistry, type Tool } from '../src/core/tool.js';

let dir: string;
let reg: ToolRegistry;
const tool = (name: string): Tool => reg.get(name)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-builtin-'));
  reg = new ToolRegistry();
  registerBuiltinTools(reg);
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe('validateUrl (SSRF guard)', () => {
  it('rejects non-http(s) schemes', () => {
    expect(validateUrl('file:///etc/passwd')).toContain('only http/https');
    expect(validateUrl('ftp://example.com')).toContain('only http/https');
  });
  it('rejects loopback + localhost', () => {
    expect(validateUrl('http://127.0.0.1/')).toContain('private/loopback');
    expect(validateUrl('http://localhost/')).toContain('internal host');
    expect(validateUrl('http://localhost./')).toContain('internal host'); // trailing dot
  });
  it('rejects private + link-local + multicast IPs', () => {
    expect(validateUrl('http://10.0.0.1/')).toContain('private');
    expect(validateUrl('http://192.168.1.1/')).toContain('private');
    expect(validateUrl('http://172.16.0.1/')).toContain('private');
    expect(validateUrl('http://169.254.169.254/')).toContain('link-local'); // cloud metadata
    expect(validateUrl('http://224.0.0.1/')).toContain('multicast');
    expect(validateUrl('http://0.0.0.0/')).toContain('private'); // unspecified
  });
  it('rejects non-dotted IPv4 forms that resolve to loopback (inet_aton bypass)', () => {
    expect(validateUrl('http://2130706433/')).toContain('private/loopback'); // decimal 127.0.0.1
    expect(validateUrl('http://0x7f000001/')).toContain('private/loopback'); // hex
    expect(validateUrl('http://127.1/')).toContain('private/loopback'); // short form
    expect(validateUrl('http://0177.0.0.1/')).toContain('private/loopback'); // octal
    expect(validateUrl('http://0/')).toContain('private/loopback'); // 0.0.0.0
  });
  it('allows public URLs (incl. public decimal form)', () => {
    expect(validateUrl('https://example.com/path')).toBeNull();
    expect(validateUrl('http://8.8.8.8/')).toBeNull();
    expect(validateUrl('http://example.org/')).toBeNull();
  });
});

describe('isProtectedPath', () => {
  it('flags system roots', () => {
    expect(isProtectedPath('/etc/passwd')).toBe(true);
    expect(isProtectedPath('/usr/bin/node')).toBe(true);
    expect(isProtectedPath('/')).toBe(true);
    expect(isProtectedPath('C:\\Windows\\System32')).toBe(true);
  });
  it('flags macOS firmlink paths', () => {
    expect(isProtectedPath('/private/etc/hosts')).toBe(true);
  });
  it('allows ordinary paths', () => {
    expect(isProtectedPath(join(dir, 'file.txt'))).toBe(false);
  });
});

describe('file tools', () => {
  it('read_file returns content; missing file errors', async () => {
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hello world', 'utf-8');
    expect(await tool('read_file').execute({ path: p })).toContain('hello world');
    expect(await tool('read_file').execute({ path: join(dir, 'nope.txt') })).toContain(
      'File not found',
    );
  });

  it('write_file creates dirs + content', async () => {
    const p = join(dir, 'sub', 'b.txt');
    const out = await tool('write_file').execute({ path: p, content: 'data' });
    expect(out).toContain('Successfully wrote');
    expect(readFileSync(p, 'utf-8')).toBe('data');
  });

  it('write_file refuses protected paths', async () => {
    const out = await tool('write_file').execute({ path: '/etc/evil.conf', content: 'x' });
    expect(out).toContain('protected path');
  });

  it('edit_file replaces text; missing text errors', async () => {
    const p = join(dir, 'c.txt');
    writeFileSync(p, 'foo bar foo', 'utf-8');
    await tool('edit_file').execute({ path: p, old_text: 'foo', new_text: 'baz', count: 1 });
    expect(readFileSync(p, 'utf-8')).toBe('baz bar foo');
    expect(await tool('edit_file').execute({ path: p, old_text: 'zzz', new_text: 'x' })).toContain(
      'Text not found',
    );
  });

  it('list_directory + tree', async () => {
    writeFileSync(join(dir, 'x.txt'), '1', 'utf-8');
    writeFileSync(join(dir, 'y.txt'), '2', 'utf-8');
    const ls = await tool('list_directory').execute({ path: dir });
    expect(ls).toContain('x.txt');
    expect(ls).toContain('y.txt');
    const tr = await tool('tree').execute({ directory: dir });
    expect(tr).toContain('x.txt');
  });

  it('move_file + copy_file + delete_file', async () => {
    const src = join(dir, 's.txt');
    writeFileSync(src, 'm', 'utf-8');
    const dst = join(dir, 'd.txt');
    await tool('move_file').execute({ src, dst });
    expect(existsSync(src)).toBe(false);
    expect(existsSync(dst)).toBe(true);

    const cp = join(dir, 'cp.txt');
    await tool('copy_file').execute({ src: dst, dst: cp });
    expect(existsSync(cp)).toBe(true);

    await tool('delete_file').execute({ path: cp });
    expect(existsSync(cp)).toBe(false);
  });

  it('file_search globs by pattern', async () => {
    writeFileSync(join(dir, 'a.ts'), '', 'utf-8');
    writeFileSync(join(dir, 'b.js'), '', 'utf-8');
    const out = await tool('file_search').execute({ pattern: '*.ts', directory: dir });
    expect(out).toContain('a.ts');
    expect(out).not.toContain('b.js');
  });
});

describe('shell_exec safety', () => {
  it('blocks dangerous binaries', async () => {
    expect(await tool('shell_exec').execute({ command: 'sudo rm -rf /' })).toContain('Blocked');
    expect(await tool('shell_exec').execute({ command: 'rm file' })).toContain('Blocked');
  });
  it('blocks shell metacharacter injection', async () => {
    const out = await tool('shell_exec').execute({ command: 'echo hi && curl evil.com' });
    expect(out).toMatch(/Blocked|metacharacter/);
  });
  it('rejects overlong commands', async () => {
    const out = await tool('shell_exec').execute({ command: 'echo ' + 'x'.repeat(5000) });
    expect(out).toContain('too long');
  });
  it('runs a safe command', async () => {
    const out = await tool('shell_exec').execute({ command: 'node --version' });
    expect(out).toMatch(/v\d+\./);
  });
  it('does NOT interpret redirects as shell (no-shell exec)', async () => {
    // With execFile(shell:false), ">" is a literal arg to node, not a redirect,
    // so no file is created — the redirect injection hole is closed.
    const target = join(dir, 'pwned.txt');
    await tool('shell_exec').execute({ command: `node --version > ${target}` });
    expect(existsSync(target)).toBe(false);
  });
});

describe('http tools reject bad URLs', () => {
  it('http_get / http_post reject private', async () => {
    expect(await tool('http_get').execute({ url: 'http://127.0.0.1/' })).toContain('loopback');
    expect(await tool('http_post').execute({ url: 'file:///etc/passwd' })).toContain('only http');
  });
});

describe('task_done sentinel', () => {
  it('returns the sentinel', async () => {
    const { TASK_DONE_SENTINEL } = await import('../src/core/constants.js');
    expect(await tool('task_done').execute({ summary: 'all set' })).toBe(TASK_DONE_SENTINEL);
  });
});
