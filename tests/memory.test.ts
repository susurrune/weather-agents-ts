import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/core/memory.js';
import type { MemoryConfig } from '../src/core/config.js';

let dir: string;

function cfg(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    dbPath: join(dir, 'memory.db'),
    shortTermLimit: 50,
    maxPersistedMessages: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-mem-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Memory short-term + sessions', () => {
  it('persists messages within a session and reloads them', async () => {
    const a = new Memory(cfg(), 'fog');
    await a.initDb();
    await a.createSession('test');
    a.addMessage('user', 'hello');
    a.addMessage('assistant', 'hi there');
    expect(a.getMessages().map((m) => m.content)).toEqual(['hello', 'hi there']);
    await a.close();

    // Fresh instance on the same db file resumes the latest session.
    const b = new Memory(cfg(), 'fog');
    await b.initDb();
    const sid = await b.resumeLatestSession();
    expect(sid).not.toBeNull();
    expect(b.getMessages().map((m) => m.content)).toEqual(['hello', 'hi there']);
    await b.close();
  });

  it('trims short-term beyond the limit but keeps system messages', async () => {
    const m = new Memory(cfg({ shortTermLimit: 5 }), 'rain');
    await m.initDb();
    await m.createSession();
    m.addMessage('system', 'you are rain');
    for (let i = 0; i < 10; i++) m.addMessage('user', `msg ${i}`);
    const msgs = m.getMessages();
    expect(msgs[0]!.role).toBe('system');
    expect(msgs.length).toBeLessThanOrEqual(5);
    expect(msgs.at(-1)!.content).toBe('msg 9');
    await m.close();
  });

  it('clearShortTerm wipes the active session but keeps system', async () => {
    const m = new Memory(cfg(), 'frost');
    await m.initDb();
    await m.createSession();
    m.addMessage('system', 'sys');
    m.addMessage('user', 'q');
    await m.clearShortTerm();
    expect(m.getMessages().map((x) => x.role)).toEqual(['system']);
    await m.close();
  });
});

describe('Memory tool-call invariant', () => {
  it('keeps matched assistant+tool pairs and drops orphans', async () => {
    const m = new Memory(cfg(), 'snow');
    await m.initDb();
    await m.createSession();
    m.addMessage('assistant', '', { toolCalls: [{ id: 'call_1', type: 'function' }] });
    m.addMessage('tool', 'result', { toolCallId: 'call_1' });
    // orphan tool message with no preceding assistant id
    m.addMessage('tool', 'orphan', { toolCallId: 'missing' });
    m.pruneToolMessages();
    const roles = m.getMessages().map((x) => x.role);
    expect(roles).toEqual(['assistant', 'tool']);
    await m.close();
  });
});

describe('Memory long-term', () => {
  it('remember / recall / forget round-trips', async () => {
    const m = new Memory(cfg(), 'dew');
    await m.initDb();
    await m.remember('deploy_cmd', 'kubectl apply', 'ops');
    const hits = await m.recall({ key: 'deploy' });
    expect(hits[0]!.value).toBe('kubectl apply');
    expect(hits[0]!.category).toBe('ops');
    await m.forget('deploy_cmd');
    expect(await m.recall({ key: 'deploy' })).toEqual([]);
    await m.close();
  });

  it('recallForInjection finds facts by token overlap', async () => {
    const m = new Memory(cfg(), 'fair');
    await m.initDb();
    await m.remember('fastapi_note', 'FastAPI is async', 'tech');
    await m.remember('weather', 'sunny', 'misc');
    const facts = await m.recallForInjection('how does FastAPI work', 3);
    expect(facts.some((f) => f.key === 'fastapi_note')).toBe(true);
    await m.close();
  });

  it('getMemoryStats groups by category', async () => {
    const m = new Memory(cfg(), 'fog');
    await m.initDb();
    await m.remember('a', '1', 'x');
    await m.remember('b', '2', 'x');
    await m.remember('c', '3', 'y');
    const stats = await m.getMemoryStats();
    expect(stats.total).toBe(3);
    expect(stats.categories.x).toBe(2);
    await m.close();
  });
});

describe('Memory working memory', () => {
  it('set/get/clear persists across instances', async () => {
    const a = new Memory(cfg(), 'rain');
    await a.initDb();
    a.setWorking('task', { step: 1 });
    expect(a.getWorking('task')).toEqual({ step: 1 });
    expect(a.getWorking('missing', 'default')).toBe('default');
    await a.close();

    const b = new Memory(cfg(), 'rain');
    await b.initDb();
    expect(b.getWorking('task')).toEqual({ step: 1 });
    b.clearWorking();
    expect(b.getWorking('task')).toBeNull();
    await b.close();
  });
});

describe('Memory helpers', () => {
  it('truncateAtTimestampGap cuts at a large gap', () => {
    const rows = [
      { created_at: '2026-05-29 12:00:30' },
      { created_at: '2026-05-29 12:00:20' },
      { created_at: '2026-05-29 06:00:00' }, // 6h gap -> dropped
      { created_at: '2026-05-29 05:59:50' },
    ];
    const kept = Memory.truncateAtTimestampGap(rows as any, 14400);
    expect(kept.length).toBe(2);
  });

  it('formatFactsBlock renders a markdown block', () => {
    const block = Memory.formatFactsBlock([{ key: 'k', value: 'v' }]);
    expect(block).toContain('## 相关记忆');
    expect(block).toContain('- **k**: v');
    expect(Memory.formatFactsBlock([])).toBe('');
  });

  it('tokenizeForRecall prioritizes ASCII then CJK n-grams', () => {
    const toks = Memory.tokenizeForRecall('use FastAPI 部署');
    expect(toks).toContain('FastAPI');
    expect(toks).toContain('部署');
  });

  it('estimates tokens with CJK weighting', async () => {
    const m = new Memory(cfg(), 'fog');
    await m.initDb();
    await m.createSession();
    m.addMessage('user', '你好');
    const usage = m.getContextWindowUsage();
    expect(usage.message_count).toBe(1);
    expect(usage.estimated_tokens).toBe(4); // 2 CJK * 2
    await m.close();
  });
});
