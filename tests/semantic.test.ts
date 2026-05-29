import { describe, it, expect } from 'vitest';
import { SemanticScorer, getScorer } from '../src/core/semantic.js';

describe('SemanticScorer', () => {
  it('scores identical strings as 1', () => {
    const s = new SemanticScorer();
    expect(s.similarity('deploy to prod', 'deploy to prod')).toBeCloseTo(1.0, 5);
  });

  it('scores empty input as 0', () => {
    const s = new SemanticScorer();
    expect(s.similarity('', 'x')).toBe(0);
    expect(s.similarity('x', '')).toBe(0);
  });

  it('finds partial overlap between related terms', () => {
    const s = new SemanticScorer();
    const score = s.similarity('deploy', 'deployment');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('ranks candidates by similarity and filters by minScore', () => {
    const s = new SemanticScorer();
    const ranked = s.rank('database connection', [
      { key: 'db_conn', value: 'database connection string' },
      { key: 'weather', value: 'sunny tomorrow' },
    ]);
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0]![1].key).toBe('db_conn');
  });

  it('scores the key field too (more discriminative)', () => {
    const s = new SemanticScorer();
    const ranked = s.rank(
      'release_command',
      [{ key: 'release_command', value: 'unrelated text' }],
      {
        minScore: 0.1,
      },
    );
    expect(ranked.length).toBe(1);
  });

  it('getScorer returns a singleton', () => {
    expect(getScorer()).toBe(getScorer());
  });
});
