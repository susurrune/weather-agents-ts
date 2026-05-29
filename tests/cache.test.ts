import { describe, it, expect } from 'vitest';
import { LLMCache } from '../src/core/cache.js';

const msgs = (text: string) => [{ role: 'user', content: text }];

describe('LLMCache', () => {
  it('returns null on miss', () => {
    const c = new LLMCache();
    expect(c.get('gpt', msgs('hi'))).toBeNull();
  });

  it('round-trips a set/get', () => {
    const c = new LLMCache();
    c.set('gpt', msgs('hi'), 'a sufficiently long response');
    expect(c.get('gpt', msgs('hi'))).toBe('a sufficiently long response');
  });

  it('refuses to cache very short responses', () => {
    const c = new LLMCache();
    c.set('gpt', msgs('hi'), 'short');
    expect(c.get('gpt', msgs('hi'))).toBeNull();
  });

  it('expires entries past TTL', async () => {
    const c = new LLMCache(128, 0.05);
    c.set('gpt', msgs('hi'), 'a long enough response here');
    await new Promise((r) => setTimeout(r, 70));
    expect(c.get('gpt', msgs('hi'))).toBeNull();
  });

  it('evicts the least-recently-used entry past max size', () => {
    const c = new LLMCache(2, 60);
    c.set('gpt', msgs('one'), 'response number one');
    c.set('gpt', msgs('two'), 'response number two');
    // touch "one" so it becomes most-recently-used
    c.get('gpt', msgs('one'));
    c.set('gpt', msgs('three'), 'response number three');
    expect(c.get('gpt', msgs('two'))).toBeNull(); // evicted
    expect(c.get('gpt', msgs('one'))).toBe('response number one');
    expect(c.get('gpt', msgs('three'))).toBe('response number three');
  });

  it('key is insensitive to object key order (stable stringify)', () => {
    const c = new LLMCache();
    c.set('gpt', [{ role: 'user', content: 'hi' }], 'a long enough response');
    // same logical message, keys in different declaration order
    const got = c.get('gpt', [{ content: 'hi', role: 'user' } as Record<string, unknown>]);
    expect(got).toBe('a long enough response');
  });
});
