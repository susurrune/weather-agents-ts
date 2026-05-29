import { describe, it, expect } from 'vitest';
import {
  parseTaskPlan,
  parseFacts,
  parseSchema,
  TaskPlanSchema,
  SchemaValidationError,
} from '../src/core/schemas.js';

describe('parseTaskPlan', () => {
  it('parses a clean JSON plan', () => {
    const plan = parseTaskPlan(
      JSON.stringify({
        goal: 'build it',
        steps: [{ id: 1, description: 'research', agent: 'fog' }],
      }),
    );
    expect(plan?.goal).toBe('build it');
    expect(plan?.steps[0]?.agent).toBe('fog');
    expect(plan?.steps[0]?.priority).toBe('medium'); // default
    expect(plan?.steps[0]?.depends_on).toEqual([]); // default
  });

  it('strips markdown fences', () => {
    const plan = parseTaskPlan('```json\n{"goal":"x","steps":[]}\n```');
    expect(plan?.goal).toBe('x');
  });

  it('extracts JSON embedded in prose', () => {
    const plan = parseTaskPlan('Here is the plan: {"goal":"y","steps":[]} — done.');
    expect(plan?.goal).toBe('y');
  });

  it('repairs trailing commas and unquoted keys', () => {
    const plan = parseTaskPlan('{goal: "z", steps: [],}');
    expect(plan?.goal).toBe('z');
  });

  it('falls back to "rain" for invalid agent names', () => {
    const plan = parseTaskPlan(
      JSON.stringify({ goal: 'g', steps: [{ id: 1, description: 'd', agent: 'wizard' }] }),
    );
    expect(plan?.steps[0]?.agent).toBe('rain');
  });

  it('returns null on unparseable garbage', () => {
    expect(parseTaskPlan('not json at all')).toBeNull();
    expect(parseTaskPlan('')).toBeNull();
  });
});

describe('parseFacts', () => {
  it('parses facts with default category', () => {
    const res = parseFacts(JSON.stringify({ facts: [{ key: 'name', value: 'Ada' }] }));
    expect(res?.facts[0]?.key).toBe('name');
    expect(res?.facts[0]?.category).toBe('auto_extracted');
  });

  it('defaults to empty facts list', () => {
    const res = parseFacts(JSON.stringify({}));
    expect(res?.facts).toEqual([]);
  });
});

describe('parseSchema', () => {
  it('throws SchemaValidationError on missing required field', () => {
    expect(() => parseSchema('{"steps":[]}', TaskPlanSchema)).toThrow(SchemaValidationError);
  });
});
