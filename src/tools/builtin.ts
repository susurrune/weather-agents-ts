/** Built-in tool implementations — real Node.js handlers. Faithful port of 1280-line Python. */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  rmdirSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { URL } from 'node:url';

const execFileAsync = promisify(execFile);

import { TASK_DONE_SENTINEL } from '../core/constants.js';
import { Tool, ToolRegistry } from '../core/tool.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 50_000;
const MAX_SHELL_OUTPUT = 20_000;
const _MAX_SEARCH_OUTPUT = 10_000;

// Paths that write/delete tools should never touch.
const WRITE_PROTECT_EXACT = new Set(['/', '/*', '/.', '~', '~/', '.', '..', '*', '\\', '\\\\']);

const WRITE_PROTECT_ROOTS = [
  '/etc',
  '/boot',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr',
  '/opt',
  '/var',
  '/root',
  '/proc',
  '/sys',
  '/dev',
  '/private/etc',
  '/private/var',
  '/private/tmp', // macOS firmlinks
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'd:\\windows',
  'd:\\program files',
];

// Blocked shell commands for security.
const BLOCKED_COMMANDS = new Set([
  'rm',
  'rmdir',
  'del',
  'format',
  'mkfs',
  'fdisk',
  'dd',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'telinit',
  'systemctl',
  'service',
  'chmod',
  'chown',
  'sudo',
  'su',
  'passwd',
  'mount',
  'umount',
  'kill',
  'killall',
  'pkill',
  'wget',
  'curl',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'rsync',
  'tftp',
]);

// ── Path protection ───────────────────────────────────────────────────────────

/** Normalize any path to lowercase forward-slash form for platform-independent matching. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

const WRITE_PROTECT_EXACT_POSIX = new Set([...WRITE_PROTECT_EXACT].map(toPosix));
const WRITE_PROTECT_ROOTS_POSIX = WRITE_PROTECT_ROOTS.map(toPosix);

export function isProtectedPath(path: string): boolean {
  const expanded = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
  // Compare in forward-slash form so checks are identical on POSIX and Windows
  // (e.g. a Windows root like c:\windows still matches when this runs on Linux,
  // and bare "/" matches because we don't strip it down to "").
  const candidates = [toPosix(normalize(expanded))];
  try {
    candidates.push(toPosix(realpathSync.native(expanded)));
  } catch {
    /* path may not exist yet — lexical check still applies */
  }

  for (const cand of candidates) {
    const stripped = cand.replace(/\/+$/, '') || '/';
    if (WRITE_PROTECT_EXACT_POSIX.has(cand) || WRITE_PROTECT_EXACT_POSIX.has(stripped)) return true;
    // Drive root: "c:" or "c:/"
    if (/^[a-z]:\/?$/.test(stripped)) return true;
    for (const root of WRITE_PROTECT_ROOTS_POSIX) {
      if (stripped === root || stripped.startsWith(root + '/')) return true;
    }
  }
  return false;
}

function truncate(text: string, limit: number, label = 'output'): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n\n[... truncated, total ${text.length} chars of ${label}]`;
}

function expandPath(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p);
}

// ── SSRF guard ────────────────────────────────────────────────────────────────

const ALLOW_PRIVATE_NET = process.env.WA_ALLOW_PRIVATE_NET === '1';

export function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Error: invalid URL: ${url}`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Error: only http/https URLs allowed (got ${parsed.protocol.replace(':', '')})`;
  }
  if (ALLOW_PRIVATE_NET) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return `Error: Invalid URL: ${url}`;
  if (['localhost', 'ip6-localhost', 'metadata.google.internal'].includes(host)) {
    return `Error: refusing to reach internal host '${host}' (set WA_ALLOW_PRIVATE_NET=1 to override)`;
  }
  // IPv4 check — normalize first so decimal/hex/octal/short forms can't bypass
  // the private-range filter (2130706433, 0x7f000001, 127.1, 0177.0.0.1, 0 all
  // resolve to 127.x). Mirrors Python's inet_aton-based hardening.
  const octets = parseIpv4Octets(host);
  if (octets) {
    const [o1, o2] = octets;
    if (o1 === 0 || o1 === 127 || o1 === 10)
      return `Error: refusing to reach private/loopback IP ${host}`;
    if (o1 === 172 && o2 >= 16 && o2 <= 31)
      return `Error: refusing to reach private/loopback IP ${host}`;
    if (o1 === 192 && o2 === 168) return `Error: refusing to reach private/loopback IP ${host}`;
    if (o1 === 169 && o2 === 254) return `Error: refusing to reach link-local IP ${host}`;
    if (o1 >= 224) return `Error: refusing to reach multicast/reserved IP ${host}`;
  }
  // IPv6 loopback
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return `Error: refusing to reach IPv6 loopback`;
  return null;
}

/**
 * Parse `host` as an IPv4 address using inet_aton semantics — accepts dotted
 * quad plus the short / hex / octal / decimal forms a browser or libc would
 * resolve. Returns the 4 octets, or null if `host` isn't a numeric IPv4 form
 * (i.e. it's a real hostname).
 */
function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === '') return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // contains non-numeric → hostname, not an IP literal
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  let value: number;
  switch (nums.length) {
    case 1:
      if (nums[0]! > 0xffffffff) return null;
      value = nums[0]!;
      break;
    case 2:
      if (nums[0]! > 0xff || nums[1]! > 0xffffff) return null;
      value = nums[0]! * 2 ** 24 + nums[1]!;
      break;
    case 3:
      if (nums[0]! > 0xff || nums[1]! > 0xff || nums[2]! > 0xffff) return null;
      value = nums[0]! * 2 ** 24 + nums[1]! * 2 ** 16 + nums[2]!;
      break;
    default:
      if (nums.some((x) => x > 0xff)) return null;
      value = nums[0]! * 2 ** 24 + nums[1]! * 2 ** 16 + nums[2]! * 2 ** 8 + nums[3]!;
  }
  value = value >>> 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

// ── HTTP tools ────────────────────────────────────────────────────────────────

async function httpGet(url: string): Promise<string> {
  const err = validateUrl(url);
  if (err) return err;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'WeatherAgents/1.0' },
    });
    const body = await res.text();
    return `Status: ${res.status}\n${truncate(body, MAX_SHELL_OUTPUT, 'body')}`;
  } catch (e: any) {
    return `Error: ${e.message || String(e)}`;
  }
}

async function httpPost(url: string, data = ''): Promise<string> {
  const err = validateUrl(url);
  if (err) return err;
  try {
    const headers: Record<string, string> = { 'User-Agent': 'WeatherAgents/1.0' };
    if (data.trim().startsWith('{') || data.trim().startsWith('['))
      headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers,
      body: data,
    });
    const body = await res.text();
    return `Status: ${res.status}\n${truncate(body, MAX_SHELL_OUTPUT, 'body')}`;
  } catch (e: any) {
    return `Error: ${e.message || String(e)}`;
  }
}

// ── File tools ────────────────────────────────────────────────────────────────

async function _readFile(path: string, offset = 0, limit = 0): Promise<string> {
  const p = expandPath(path);
  try {
    const content = readFileSync(p, 'utf-8');
    if (offset || limit) {
      const lines = content.split('\n');
      const total = lines.length;
      const start = Math.max(0, offset);
      const end = limit > 0 ? start + limit : total;
      const window_ = lines.slice(start, end).join('\n');
      return `[lines ${start + 1}-${Math.min(end, total)} of ${total} in ${p}]\n${truncate(window_, MAX_FILE_BYTES, 'file')}`;
    }
    return truncate(content, MAX_FILE_BYTES, 'file');
  } catch (e: any) {
    if (e.code === 'ENOENT') return `Error: File not found: ${p}`;
    if (e.code === 'EACCES') return `Error: Permission denied: ${p}`;
    return `Error reading file: ${e.message}`;
  }
}

async function _writeFile(path: string, content: string): Promise<string> {
  // Check the raw (un-resolved) path: resolve() would prepend a drive letter
  // on Windows ("/etc/x" → "D:\etc\x"), defeating the "/etc" root match.
  if (isProtectedPath(path)) return `Error: refusing to write to protected path: ${path}`;
  const p = expandPath(path);
  const existed = existsSync(p);
  const oldSize = existed ? statSync(p).size : 0;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf-8');
    const suffix = existed ? ` (overwritten, was ${oldSize}B)` : '';
    return `Successfully wrote to ${p}${suffix}`;
  } catch (e: any) {
    if (e.code === 'EACCES') return `Error: Permission denied: ${p}`;
    return `Error writing file: ${e.message}`;
  }
}

async function _editFile(
  path: string,
  oldText: string,
  newText: string,
  count = 1,
): Promise<string> {
  if (isProtectedPath(path)) return `Error: refusing to edit protected path: ${path}`;
  const p = expandPath(path);
  try {
    let content = readFileSync(p, 'utf-8');
    if (!content.includes(oldText)) return `Error: Text not found in ${p}`;
    const parts = content.split(oldText);
    // split with limit
    let result = '';
    let replaced = 0;
    for (let i = 0; i < parts.length; i++) {
      result += parts[i]!;
      if (i < parts.length - 1 && replaced < count) {
        result += newText;
        replaced += 1;
      } else if (i < parts.length - 1) {
        result += oldText;
      }
    }
    writeFileSync(p, result, 'utf-8');
    return `Successfully edited ${p} (${replaced} occurrences)`;
  } catch (e: any) {
    if (e.code === 'ENOENT') return `Error: File not found: ${p}`;
    return `Error editing file: ${e.message}`;
  }
}

async function _listDirectory(path = '.', includeHidden = false): Promise<string> {
  const p = expandPath(path);
  try {
    const entries = readdirSync(p, { withFileTypes: true });
    const lines: string[] = [];
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith('.')) continue;
      const suffix = e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : '';
      lines.push(`${e.name}${suffix}`);
    }
    return lines.length ? `Contents of ${p}:\n${lines.join('\n')}` : `Directory ${p} is empty.`;
  } catch (e: any) {
    return `Error listing directory: ${e.message}`;
  }
}

async function _listRecursive(path = '.', maxDepth = 4): Promise<string> {
  const p = expandPath(path);
  const lines: string[] = [];
  try {
    function walk(dir: string, depth: number, prefix: string): void {
      if (depth > maxDepth) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]!;
          const isLast = i === entries.length - 1;
          const marker = isLast ? '└── ' : '├── ';
          lines.push(prefix + marker + e.name + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('node_modules')) {
            walk(join(dir, e.name), depth + 1, prefix + (isLast ? '    ' : '│   '));
          }
        }
      } catch {
        /* skip unreadable dirs */
      }
    }
    walk(p, 0, '');
    return lines.length ? `${p}\n${lines.join('\n')}` : `${p} (empty)`;
  } catch (e: any) {
    return `Error reading tree: ${e.message}`;
  }
}

async function _glob(pattern: string, directory = '.'): Promise<string> {
  const dir = expandPath(directory);
  try {
    const globToRegex = (glob: string): RegExp => {
      let re = '';
      for (let i = 0; i < glob.length; i++) {
        const ch = glob[i]!;
        if (ch === '*') re += '.*';
        else if (ch === '?') re += '.';
        else if (ch === '.') re += '\\.';
        else re += ch;
      }
      return new RegExp('^' + re + '$');
    };
    const rx = globToRegex(pattern);
    const results: string[] = [];
    const seen = new Set<string>(); // guards against symlink cycles
    function scan(d: string) {
      if (results.length >= 200) return;
      let real: string;
      try {
        real = realpathSync.native(d);
      } catch {
        real = d;
      }
      if (seen.has(real)) return;
      seen.add(real);
      try {
        const entries = readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          const full = join(d, e.name);
          if (rx.test(e.name)) results.push(full);
          // Skip dot-dirs, node_modules and .git — same exclusions as grep,
          // so a glob in a project root doesn't drown in dependency files.
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
            scan(full);
          }
        }
      } catch {
        /* skip unreadable dir */
      }
    }
    scan(dir);
    return results.length ? results.slice(0, 200).join('\n') : 'No files matched.';
  } catch (e: any) {
    return `Error globbing: ${e.message}`;
  }
}

async function _grep(pattern: string, directory = '.', caseSensitive = false): Promise<string> {
  const dir = expandPath(directory);
  const flags = caseSensitive ? '' : 'i';
  let rx: RegExp;
  try {
    rx = new RegExp(pattern, flags + 'g');
  } catch {
    return `Error: invalid regex: ${pattern}`;
  }
  const results: string[] = [];
  let matched = 0;
  function scan(d: string) {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('node_modules'))
          scan(full);
        else if (e.isFile()) {
          try {
            const content = readFileSync(full, 'utf-8');
            for (const line of content.split('\n')) {
              if (rx.test(line) && matched < 200) {
                results.push(`${full}: ${line.trim().slice(0, 120)}`);
                matched += 1;
              }
            }
          } catch {
            /* skip binary */
          }
        }
      }
    } catch {
      /* skip */
    }
  }
  scan(dir);
  return results.length ? results.join('\n') : 'No matches found.';
}

async function _moveFile(src: string, dst: string): Promise<string> {
  if (isProtectedPath(src) || isProtectedPath(dst))
    return 'Error: refusing to move to/from a protected path.';
  const s = expandPath(src);
  const d = expandPath(dst);
  try {
    mkdirSync(dirname(d), { recursive: true });
    renameSync(s, d);
    return `Successfully moved ${s} → ${d}`;
  } catch (e: any) {
    return `Error moving file: ${e.message}`;
  }
}

async function _copyFile(src: string, dst: string): Promise<string> {
  if (isProtectedPath(dst)) return 'Error: refusing to copy to a protected path.';
  const s = expandPath(src);
  const d = expandPath(dst);
  try {
    mkdirSync(dirname(d), { recursive: true });
    copyFileSync(s, d);
    return `Successfully copied ${s} → ${d}`;
  } catch (e: any) {
    return `Error copying file: ${e.message}`;
  }
}

async function _deleteFile(path: string): Promise<string> {
  if (isProtectedPath(path)) return 'Error: refusing to delete a protected path.';
  const p = expandPath(path);
  try {
    if (!existsSync(p)) return `Error: File not found: ${p}`;
    const s = statSync(p);
    if (s.isDirectory()) rmdirSync(p, { recursive: true });
    else unlinkSync(p);
    return `Successfully deleted ${p}`;
  } catch (e: any) {
    return `Error deleting file: ${e.message}`;
  }
}

// ── Shell exec ────────────────────────────────────────────────────────────────

async function _shellExec(command: string, timeout = 30, cwd = ''): Promise<string> {
  if (command.length > 4000) return 'Error: command too long (>4000 chars)';
  const args =
    command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((a) => a.replace(/^["']|["']$/g, '')) ??
    [];
  if (!args.length) return 'Empty command.';
  const base = basename(args[0]!)
    .replace(/\.exe$/i, '')
    .toLowerCase();
  if (BLOCKED_COMMANDS.has(base)) return `Blocked: '${base}' is not allowed for security reasons.`;
  for (const a of args.slice(1)) {
    if (/[;&|`$({]/.test(a)) return `Blocked: shell metacharacter in argument: '${a}'`;
  }
  const workDir = cwd ? expandPath(cwd) : undefined;
  if (cwd && !existsSync(workDir!)) return `Error: cwd is not a directory: ${cwd}`;
  try {
    // execFile (shell:false) execs the program directly with an argv array —
    // no shell, so redirects/globs/pipes in args are literal, not interpreted.
    // This matches Python's create_subprocess_exec and closes the redirect/
    // glob injection hole that execSync(string) had.
    const { stdout } = await execFileAsync(args[0]!, args.slice(1), {
      timeout: timeout * 1000,
      cwd: workDir,
      encoding: 'utf-8',
      maxBuffer: 2_000_000,
      shell: false,
    });
    return `[cwd: ${workDir || process.cwd()}]\n${truncate(stdout, MAX_SHELL_OUTPUT, 'stdout')}`;
  } catch (e: any) {
    if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT')
      return `Command timed out after ${timeout}s`;
    if (e.code === 'ENOENT') return `Command not found: ${args[0]}`;
    const stderr = e.stderr || e.message || '';
    const exit = typeof e.code === 'number' ? e.code : 1;
    return `[exit code: ${exit}]\n${truncate(String(stderr), 5000, 'stderr')}`;
  }
}

// ── Web search ────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

/** Decode HTML entities (named + decimal/hex numeric) in scraped result text. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

/** Parse DuckDuckGo HTML results (result__a / result__snippet), decoding the
 *  `uddg=` redirect wrapper DDG puts around result URLs. */
export function parseDdgHtml(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const rx =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(rx)) {
    if (out.length >= max) break;
    let url = m[1] ?? '';
    const title = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).trim();
    const snippet = decodeEntities((m[3] ?? '').replace(/<[^>]+>/g, '')).trim();
    if (url.includes('uddg=')) {
      try {
        const qs = new URLSearchParams(url.split('?')[1] ?? '');
        url = qs.get('uddg') ?? url;
      } catch {
        /* keep raw url */
      }
    }
    if (url.startsWith('//')) url = 'https:' + url;
    if (title) out.push({ title, url, snippet });
  }
  return out;
}

/** Parse Bing HTML results (b_algo blocks). Works where DuckDuckGo is blocked
 *  (e.g. mainland China), so it's our fallback backend. */
export function parseBingHtml(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const blockRx = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const b of html.matchAll(blockRx)) {
    if (out.length >= max) break;
    const block = b[1] ?? '';
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = a[1] ?? '';
    const title = decodeEntities((a[2] ?? '').replace(/<[^>]+>/g, '')).trim();
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = p ? decodeEntities(p[1]!.replace(/<[^>]+>/g, '')).trim() : '';
    if (title && url.startsWith('http')) out.push({ title, url, snippet });
  }
  return out;
}

async function _webSearch(query: string, numResults = 5): Promise<string> {
  const max = Math.min(numResults, 10);
  const errors: string[] = [];

  // Backend chain: DuckDuckGo (best outside CN) → Bing (reachable inside CN).
  // First non-empty result set wins; each backend has its own timeout so one
  // blocked engine can't stall the whole call.
  const backends: Array<{ name: string; run: () => Promise<SearchResult[]> }> = [
    {
      name: 'ddg-post',
      run: async () => {
        const res = await fetch('https://html.duckduckgo.com/html/', {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: {
            'User-Agent': SEARCH_UA,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `q=${encodeURIComponent(query)}`,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseDdgHtml(await res.text(), max);
      },
    },
    {
      name: 'bing',
      run: async () => {
        const res = await fetch(
          `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`,
          { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': SEARCH_UA } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseBingHtml(await res.text(), max);
      },
    },
  ];

  for (const b of backends) {
    try {
      const results = await b.run();
      if (results.length) {
        const parts = [`Search results for: ${query}\n`];
        results.forEach((r, i) => {
          parts.push(`${i + 1}. ${r.title}`);
          parts.push(`   ${r.url}`);
          if (r.snippet) parts.push(`   ${r.snippet.slice(0, 300)}`);
          parts.push('');
        });
        return parts.join('\n');
      }
      errors.push(`${b.name}: 0 results`);
    } catch (e: any) {
      errors.push(`${b.name}: ${e.message}`);
    }
  }

  return `No results found for '${query}' (${errors.join('; ')})`;
}

/** Current date/time across local + UTC, for the get_current_time tool. */
function _currentTime(): string {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const offMin = -d.getTimezoneOffset();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const off = `UTC${offMin >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return [
    `local:    ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${weekday}, ${tz}, ${off})`,
    `utc:      ${d.toISOString()}`,
    `unix_ms:  ${d.getTime()}`,
  ].join('\n');
}

async function _fetchWebPage(url: string, extractText = true): Promise<string> {
  const err = validateUrl(url);
  if (err) return err;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'WeatherAgents/1.0' },
    });
    const html = await res.text();
    if (!extractText) return truncate(html, 20000, 'html');
    // Strip HTML tags
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `Status: ${res.status}\n${truncate(text, 15000, 'text')}`;
  } catch (e: any) {
    return `Error fetching page: ${e.message}`;
  }
}

// ── Task control ──────────────────────────────────────────────────────────────

async function _taskDone(_summary = '') {
  return TASK_DONE_SENTINEL;
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerBuiltinTools(reg: ToolRegistry): void {
  // Wrap each handler to accept (args: Record<string, any>) — the ToolHandler signature.
  const tools = [
    new Tool({
      name: 'read_file',
      description: 'Read a file from the local filesystem.',
      parameters: [
        { name: 'path', type: 'string', description: 'Absolute path to the file', required: true },
        {
          name: 'offset',
          type: 'integer',
          description: 'Line number to start reading from',
          required: false,
          default: 0,
        },
        {
          name: 'limit',
          type: 'integer',
          description: 'Number of lines to read',
          required: false,
          default: 0,
        },
      ],
      handler: (a) => _readFile(String(a.path), Number(a.offset) || 0, Number(a.limit) || 0),
    }),
    new Tool({
      name: 'write_file',
      description: 'Write a file to the local filesystem.',
      parameters: [
        { name: 'path', type: 'string', description: 'Absolute path to the file', required: true },
        { name: 'content', type: 'string', description: 'Content to write', required: true },
      ],
      handler: (a) => _writeFile(String(a.path), String(a.content)),
      dangerous: true,
    }),
    new Tool({
      name: 'edit_file',
      description: 'Replace text in a file.',
      parameters: [
        { name: 'path', type: 'string', description: 'Absolute path to the file', required: true },
        { name: 'old_text', type: 'string', description: 'Text to replace', required: true },
        { name: 'new_text', type: 'string', description: 'Replacement text', required: true },
        {
          name: 'count',
          type: 'integer',
          description: 'Number of occurrences',
          required: false,
          default: 1,
        },
      ],
      handler: (a) =>
        _editFile(String(a.path), String(a.old_text), String(a.new_text), Number(a.count) || 1),
      dangerous: true,
    }),
    new Tool({
      name: 'list_directory',
      description: 'List files and directories.',
      parameters: [
        {
          name: 'path',
          type: 'string',
          description: 'Directory path',
          required: false,
          default: '.',
        },
        {
          name: 'include_hidden',
          type: 'boolean',
          description: 'Include hidden files',
          required: false,
          default: false,
        },
      ],
      handler: (a) => _listDirectory(String(a.path ?? '.'), Boolean(a.include_hidden)),
    }),
    new Tool({
      name: 'tree',
      description: 'Recursive directory tree.',
      parameters: [
        {
          name: 'directory',
          type: 'string',
          description: 'Root directory',
          required: false,
          default: '.',
        },
      ],
      handler: (a) => _listRecursive(String(a.directory ?? '.'), Number(a.max_depth) || 4),
    }),
    new Tool({
      name: 'file_search',
      description: 'Glob-pattern file search.',
      parameters: [
        {
          name: 'pattern',
          type: 'string',
          description: 'Glob pattern (e.g. *.ts)',
          required: true,
        },
        {
          name: 'directory',
          type: 'string',
          description: 'Directory to search',
          required: false,
          default: '.',
        },
      ],
      handler: (a) => _glob(String(a.pattern), String(a.directory ?? '.')),
    }),
    new Tool({
      name: 'grep',
      description: 'Search file contents with regex.',
      parameters: [
        { name: 'pattern', type: 'string', description: 'Regex pattern', required: true },
        {
          name: 'directory',
          type: 'string',
          description: 'Directory to search',
          required: false,
          default: '.',
        },
        {
          name: 'case_sensitive',
          type: 'boolean',
          description: 'Case sensitive',
          required: false,
          default: false,
        },
      ],
      handler: (a) =>
        _grep(String(a.pattern), String(a.directory ?? '.'), Boolean(a.case_sensitive)),
    }),
    new Tool({
      name: 'shell_exec',
      description: 'Execute a shell command safely (no pipelines/redirects).',
      parameters: [
        { name: 'command', type: 'string', description: 'Command to execute', required: true },
        {
          name: 'timeout',
          type: 'integer',
          description: 'Timeout in seconds',
          required: false,
          default: 30,
        },
        {
          name: 'cwd',
          type: 'string',
          description: 'Working directory',
          required: false,
          default: '',
        },
      ],
      handler: (a) => _shellExec(String(a.command), Number(a.timeout) || 30, String(a.cwd ?? '')),
      cacheable: false,
      dangerous: true,
    }),
    new Tool({
      name: 'http_get',
      description: 'Fetch a URL via GET.',
      parameters: [{ name: 'url', type: 'string', description: 'URL to fetch', required: true }],
      handler: (a) => httpGet(String(a.url)),
      cacheable: false,
    }),
    new Tool({
      name: 'http_post',
      description: 'POST data to a URL.',
      parameters: [
        { name: 'url', type: 'string', description: 'URL', required: true },
        { name: 'data', type: 'string', description: 'POST body', required: false, default: '' },
      ],
      handler: (a) => httpPost(String(a.url), String(a.data ?? '')),
      cacheable: false,
    }),
    new Tool({
      name: 'web_search',
      description: 'Search the web via DuckDuckGo (no API key needed).',
      parameters: [
        { name: 'query', type: 'string', description: 'Search query', required: true },
        {
          name: 'num_results',
          type: 'integer',
          description: 'Max results',
          required: false,
          default: 5,
        },
      ],
      handler: (a) => _webSearch(String(a.query), Number(a.num_results) || 5),
      cacheable: false,
    }),
    new Tool({
      name: 'get_current_time',
      description:
        'Get the current real-world date and time (local + UTC). Call this for anything time-sensitive instead of relying on training-cutoff knowledge.',
      parameters: [],
      handler: () => Promise.resolve(_currentTime()),
      cacheable: false,
    }),
    new Tool({
      name: 'fetch_page',
      description: 'Fetch and extract text from a web page.',
      parameters: [
        { name: 'url', type: 'string', description: 'URL to fetch', required: true },
        {
          name: 'extract_text',
          type: 'boolean',
          description: 'Extract visible text from HTML?',
          required: false,
          default: true,
        },
      ],
      handler: (a) => _fetchWebPage(String(a.url), a.extract_text !== false),
      cacheable: false,
    }),
    new Tool({
      name: 'task_done',
      description: 'Signal task completion.',
      parameters: [
        {
          name: 'summary',
          type: 'string',
          description: 'Completion summary',
          required: false,
          default: '',
        },
      ],
      handler: (a) => _taskDone(String(a.summary ?? '')),
      cacheable: false,
    }),
    new Tool({
      name: 'move_file',
      description: 'Move/rename a file.',
      parameters: [
        { name: 'src', type: 'string', description: 'Source path', required: true },
        { name: 'dst', type: 'string', description: 'Destination path', required: true },
      ],
      handler: (a) => _moveFile(String(a.src), String(a.dst)),
      dangerous: true,
    }),
    new Tool({
      name: 'copy_file',
      description: 'Copy a file.',
      parameters: [
        { name: 'src', type: 'string', description: 'Source path', required: true },
        { name: 'dst', type: 'string', description: 'Destination path', required: true },
      ],
      handler: (a) => _copyFile(String(a.src), String(a.dst)),
      dangerous: true,
    }),
    new Tool({
      name: 'delete_file',
      description: 'Delete a file or directory.',
      parameters: [{ name: 'path', type: 'string', description: 'Path to delete', required: true }],
      handler: (a) => _deleteFile(String(a.path)),
      dangerous: true,
    }),
    new Tool({
      name: 'get_cwd',
      description: 'Get the current working directory.',
      parameters: [],
      handler: async () => process.cwd(),
    }),
  ];
  for (const t of tools) reg.register(t);
}
