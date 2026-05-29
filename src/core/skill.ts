/**
 * Skill system — Anthropic-compatible composable capability modules.
 *
 * Skills use Markdown + YAML frontmatter format, matching the Claude Code
 * skill specification. When activated, a skill injects its system prompt
 * and can register custom handler tools into the agent.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import yaml from 'js-yaml';

// Tuning for lazy skill loading. Bodies up to LITE_THRESHOLD chars get inlined
// as-is; larger bodies are summarized down to LITE_MAX_CHARS (~title + first H2).
const SKILL_BODY_LITE_THRESHOLD = 2000;
const SKILL_BODY_LITE_MAX_CHARS = 1500;

/** A handler that registers custom tools when the skill is activated. */
export type SkillHandler = (agent: unknown, toolRegistry: unknown) => void;

export interface SkillInit {
  name: string;
  description: string;
  systemPrompt?: string;
  requiredTools?: string[];
  tools?: unknown[];
  handler?: SkillHandler | null;
  model?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  triggers?: string[];
  resourceDir?: string | null;
  license?: string | null;
  allowedTools?: string[] | null;
  sourcePath?: string | null;
  bodyTruncated?: boolean;
  metadata?: Record<string, unknown>;
}

/** A composable capability module for an agent (Anthropic/Claude Code format). */
export class Skill {
  name: string;
  description: string;
  systemPrompt: string;
  requiredTools: string[];
  tools: unknown[];
  handler: SkillHandler | null;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  triggers: string[];
  resourceDir: string | null;
  license: string | null;
  allowedTools: string[] | null;
  sourcePath: string | null;
  bodyTruncated: boolean;
  metadata: Record<string, unknown>;

  constructor(init: SkillInit) {
    this.name = init.name;
    this.description = init.description;
    this.systemPrompt = init.systemPrompt ?? '';
    this.requiredTools = init.requiredTools ?? [];
    this.tools = init.tools ?? [];
    this.handler = init.handler ?? null;
    this.model = init.model ?? null;
    this.temperature = init.temperature ?? null;
    this.maxTokens = init.maxTokens ?? null;
    this.triggers = init.triggers ?? [];
    this.resourceDir = init.resourceDir ?? null;
    this.license = init.license ?? null;
    this.allowedTools = init.allowedTools ?? null;
    this.sourcePath = init.sourcePath ?? null;
    this.bodyTruncated = init.bodyTruncated ?? false;
    this.metadata = init.metadata ?? {};
  }

  /** Load a skill from a Markdown file with YAML frontmatter. */
  static fromMarkdown(path: string): Skill | null {
    const text = readFileSync(path, 'utf-8');
    const [fm, body] = parseFrontmatter(text);
    if (!fm) {
      return null;
    }

    const stem = basename(path, extname(path));
    const name = typeof fm.name === 'string' ? fm.name : stem;
    const description = typeof fm.description === 'string' ? fm.description : '';
    const toolsRaw = fm.tools;
    const requiredTools = Array.isArray(toolsRaw)
      ? toolsRaw.filter((t): t is string => typeof t === 'string')
      : [];

    const model = typeof fm.model === 'string' ? fm.model : null;
    const temperature = typeof fm.temperature === 'number' ? fm.temperature : null;
    const maxTokens = Number.isInteger(fm.max_tokens) ? (fm.max_tokens as number) : null;

    const triggersRaw = fm.triggers;
    let triggers = Array.isArray(triggersRaw)
      ? triggersRaw.filter((t): t is string => typeof t === 'string')
      : [];
    // Auto-derive triggers from the description when frontmatter omits them.
    // Manual `triggers:` always wins so authored intent isn't overridden.
    if (triggers.length === 0 && description) {
      triggers = deriveTriggersFromDescription(description);
    }

    const licenseRaw = fm.license;
    const license = typeof licenseRaw === 'string' && licenseRaw.trim() ? licenseRaw.trim() : null;

    const allowedRaw = fm['allowed-tools'] ?? fm.allowed_tools;
    let allowedTools: string[] | null = null;
    if (Array.isArray(allowedRaw)) {
      const list = allowedRaw.filter((t): t is string => typeof t === 'string');
      allowedTools = list.length ? list : null;
    } else if (typeof allowedRaw === 'string' && allowedRaw.trim()) {
      const list = allowedRaw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t);
      allowedTools = list.length ? list : null;
    }
    if (allowedTools) {
      allowedTools = allowedTools.map(normalizeClaudeToolName);
      // Dedupe preserving order — Bash(ls *) + Bash(rm *) both map to run_bash.
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const t of allowedTools) {
        if (!seen.has(t)) {
          seen.add(t);
          deduped.push(t);
        }
      }
      allowedTools = deduped;
    }

    const knownKeys = new Set([
      'name',
      'description',
      'tools',
      'model',
      'temperature',
      'max_tokens',
      'triggers',
      'license',
      'allowed-tools',
      'allowed_tools',
    ]);
    const extraMetadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (!knownKeys.has(k) && !k.startsWith('_')) {
        extraMetadata[k] = v;
      }
    }

    // Lazy-load very large skill bodies (inject head only; LLM fetches the rest).
    let bodyStripped = body.trim();
    let bodyTruncated = false;
    if (bodyStripped.length > SKILL_BODY_LITE_THRESHOLD) {
      bodyStripped = extractSkillHead(bodyStripped, SKILL_BODY_LITE_MAX_CHARS);
      bodyTruncated = true;
    }

    return new Skill({
      name,
      description,
      systemPrompt: bodyStripped,
      requiredTools,
      model,
      temperature,
      maxTokens,
      triggers,
      license,
      allowedTools,
      sourcePath: path,
      bodyTruncated,
      metadata: extraMetadata,
    });
  }
}

// Claude Code → wa tool-name aliases.
const CLAUDE_TOOL_ALIASES: Record<string, string> = {
  read: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
  multiedit: 'edit_file',
  delete: 'delete_file',
  bash: 'run_bash',
  shell: 'run_bash',
  grep: 'grep',
  glob: 'file_search',
  search: 'code_search',
  websearch: 'web_search',
  webfetch: 'fetch_page',
  ls: 'list_directory',
  tree: 'tree',
  fetch: 'http_get',
  taskdone: 'task_done',
};
const CLAUDE_TOOL_TARGETS = new Set(Object.values(CLAUDE_TOOL_ALIASES));

/** Translate a Claude Code tool name into wa's registry name. */
function normalizeClaudeToolName(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  // Strip permission scoping: `Bash(ls *)` -> `Bash`.
  const paren = s.indexOf('(');
  if (paren > 0) {
    s = s.slice(0, paren).trim();
  }
  if (CLAUDE_TOOL_TARGETS.has(s)) {
    return s;
  }
  return CLAUDE_TOOL_ALIASES[s.toLowerCase()] ?? s;
}

/** Return the head of a SKILL.md body — title + first major section. */
function extractSkillHead(body: string, maxChars: number): string {
  const out: string[] = [];
  let charCount = 0;
  let h2Count = 0;
  for (const line of body.split('\n')) {
    const isH2 = line.startsWith('## ') && !line.startsWith('### ');
    if (isH2) {
      h2Count += 1;
      if (h2Count > 1) break;
    }
    if (out.length && charCount + line.length + 1 > maxChars) break;
    out.push(line);
    charCount += line.length + 1;
  }
  return out.join('\n').replace(/\s+$/, '');
}

// Patterns for auto-deriving triggers from skill descriptions.
const TRIGGER_QUOTED = /["'“‘]([^"'”’\n]{1,40})["'”’]/g;
const TRIGGER_EXT = /(?<![A-Za-z0-9])\.[A-Za-z0-9]{2,6}\b/g;
const TRIGGER_STRIP = ' \t,.;:!?，。、；：！？';

function rstrip(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end -= 1;
  return s.slice(0, end);
}

/** Pull candidate trigger phrases out of a skill description. */
function deriveTriggersFromDescription(description: string): string[] {
  const raw: string[] = [];
  for (const m of description.matchAll(TRIGGER_QUOTED)) {
    if (m[1] !== undefined) raw.push(m[1]);
  }
  for (const m of description.matchAll(TRIGGER_EXT)) {
    raw.push(m[0]);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw) {
    // Only strip TRAILING punctuation; leading dots are meaningful (`.pptx`).
    const cleaned = rstrip(token, TRIGGER_STRIP).replace(/^[ \t]+/, '');
    if (!cleaned || cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 12) break;
  }
  return out;
}

/** Parse YAML frontmatter from markdown text. Returns [frontmatter|null, body]. */
function parseFrontmatter(text: string): [Record<string, any> | null, string] {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)/.exec(text);
  if (!match) {
    return [null, text];
  }
  try {
    const fm = (yaml.load(match[1]!) as Record<string, any>) || {};
    return [fm, match[2] ?? ''];
  } catch {
    return [null, text];
  }
}

/** Central registry for all available skills. */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  getSkills(names?: string[] | null): Skill[] {
    if (names === undefined || names === null) {
      return [...this.skills.values()];
    }
    const out: Skill[] = [];
    for (const n of names) {
      const s = this.skills.get(n);
      if (s) out.push(s);
    }
    return out;
  }

  listNames(): string[] {
    return [...this.skills.keys()];
  }

  merge(other: SkillRegistry): void {
    for (const [name, skill] of other.skills.entries()) {
      this.skills.set(name, skill);
    }
  }

  /**
   * Load all .md skill files from a directory (Anthropic format).
   * Skips files starting with _ or . (private/disabled skills).
   */
  loadSkillsFromDirectory(directory: string): Skill[] {
    const loaded: Skill[] = [];
    const dirPath = directory.startsWith('~') ? join(homedir(), directory.slice(1)) : directory;
    try {
      if (!statSync(dirPath).isDirectory()) return loaded;
    } catch {
      return loaded;
    }

    const files = readdirSync(dirPath)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
      .sort();
    for (const f of files) {
      const skill = Skill.fromMarkdown(join(dirPath, f));
      if (skill) {
        skill.resourceDir = dirPath;
        this.register(skill);
        loaded.push(skill);
      }
    }
    return loaded;
  }
}

// Global skill registry
export const globalSkillRegistry = new SkillRegistry();
