import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Skill, SkillRegistry } from '../src/core/skill.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-skill-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSkill(filename: string, content: string): string {
  const p = join(dir, filename);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('Skill.fromMarkdown', () => {
  it('parses frontmatter + body', () => {
    const p = writeSkill(
      'basic.md',
      `---
name: code_reviewer
description: Reviews code for bugs
tools:
  - read_file
  - grep
model: claude-opus-4-7
temperature: 0.3
---

## Skill: Code Reviewer
Body text here.`,
    );
    const s = Skill.fromMarkdown(p)!;
    expect(s.name).toBe('code_reviewer');
    expect(s.description).toBe('Reviews code for bugs');
    expect(s.requiredTools).toEqual(['read_file', 'grep']);
    expect(s.model).toBe('claude-opus-4-7');
    expect(s.temperature).toBe(0.3);
    expect(s.systemPrompt).toContain('Code Reviewer');
  });

  it('returns null when there is no frontmatter', () => {
    const p = writeSkill('nofm.md', '# Just markdown, no frontmatter');
    expect(Skill.fromMarkdown(p)).toBeNull();
  });

  it('derives triggers from quoted tokens and extensions in the description', () => {
    const p = writeSkill(
      'pptx.md',
      `---
name: pptx
description: Use when the user mentions "deck," "slides," or a .pptx file.
---

## PPTX
body`,
    );
    const s = Skill.fromMarkdown(p)!;
    expect(s.triggers).toContain('deck');
    expect(s.triggers).toContain('slides');
    expect(s.triggers).toContain('.pptx');
  });

  it('normalizes Claude Code allowed-tools to wa names', () => {
    const p = writeSkill(
      'allowed.md',
      `---
name: t
description: d
allowed-tools:
  - Bash(ls *)
  - Bash(rm *)
  - Read
  - Write
---

## T
body`,
    );
    const s = Skill.fromMarkdown(p)!;
    // Bash(...) dedupes to a single run_bash; Read/Write map to file tools.
    expect(s.allowedTools).toEqual(['run_bash', 'read_file', 'write_file']);
  });

  it('preserves unknown frontmatter keys in metadata', () => {
    const p = writeSkill(
      'meta.md',
      `---
name: m
description: d
version: 1.2.3
homepage: https://example.com
---

## M
body`,
    );
    const s = Skill.fromMarkdown(p)!;
    expect(s.metadata.version).toBe('1.2.3');
    expect(s.metadata.homepage).toBe('https://example.com');
  });

  it('truncates large bodies and flags bodyTruncated', () => {
    const big = '## Head\nintro\n\n' + '## Section\n' + 'x'.repeat(5000);
    const p = writeSkill(
      'big.md',
      `---
name: big
description: d
---

${big}`,
    );
    const s = Skill.fromMarkdown(p)!;
    expect(s.bodyTruncated).toBe(true);
    expect(s.systemPrompt.length).toBeLessThan(2000);
  });
});

describe('SkillRegistry', () => {
  it('registers, gets, lists, merges', () => {
    const a = new SkillRegistry();
    const b = new SkillRegistry();
    a.register(new Skill({ name: 'a', description: '' }));
    b.register(new Skill({ name: 'b', description: '' }));
    expect(a.get('a')?.name).toBe('a');
    expect(a.get('missing')).toBeNull();
    a.merge(b);
    expect(a.listNames().sort()).toEqual(['a', 'b']);
  });

  it('loads skills from a directory, skipping _/. files', () => {
    const sub = mkdtempSync(join(tmpdir(), 'wa-skills-dir-'));
    writeFileSync(
      join(sub, 'good.md'),
      '---\nname: good\ndescription: d\n---\n\n## Good\nbody',
      'utf-8',
    );
    writeFileSync(
      join(sub, '_hidden.md'),
      '---\nname: hidden\ndescription: d\n---\n\nbody',
      'utf-8',
    );
    const reg = new SkillRegistry();
    const loaded = reg.loadSkillsFromDirectory(sub);
    expect(loaded.map((s) => s.name)).toEqual(['good']);
    expect(reg.get('good')?.resourceDir).toBe(sub);
    rmSync(sub, { recursive: true, force: true });
  });
});
