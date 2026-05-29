import { describe, it, expect, beforeEach } from 'vitest';
import { Tool, ToolRegistry, RESULT_STORE } from '../src/core/tool.js';
import { setMiddlewareChain } from '../src/core/middleware.js';

beforeEach(() => {
  RESULT_STORE.clear();
  setMiddlewareChain(null);
});

describe('Tool.execute', () => {
  it('runs the handler and returns its result', async () => {
    const t = new Tool({
      name: 'echo1',
      description: 'echo',
      parameters: [{ name: 'text', type: 'string', description: 't' }],
      handler: async (a) => `got:${a.text}`,
    });
    expect(await t.execute({ text: 'hi' })).toBe('got:hi');
  });

  it('reports a missing required argument with the signature', async () => {
    const t = new Tool({
      name: 'echo2',
      description: 'echo',
      parameters: [{ name: 'text', type: 'string', description: 't' }],
      handler: async () => 'never',
    });
    const out = await t.execute({});
    expect(out).toContain("missing required argument 'text'");
    expect(out).toContain('text:string');
  });

  it('rejects a wrong-typed argument', async () => {
    const t = new Tool({
      name: 'num1',
      description: 'n',
      parameters: [{ name: 'count', type: 'integer', description: 'c' }],
      handler: async () => 'never',
    });
    const out = await t.execute({ count: 'not-a-number' });
    expect(out).toContain("argument 'count' has wrong type");
  });

  it('accepts string-coerced numbers (lenient schema check)', async () => {
    const t = new Tool({
      name: 'num2',
      description: 'n',
      parameters: [{ name: 'count', type: 'integer', description: 'c' }],
      handler: async (a) => `n=${a.count}`,
    });
    expect(await t.execute({ count: '42' })).toBe('n=42');
  });

  it('caches results for read-only tools', async () => {
    let calls = 0;
    const t = new Tool({
      name: 'cacheme',
      description: 'c',
      parameters: [{ name: 'x', type: 'string', description: 'x' }],
      handler: async (a) => {
        calls += 1;
        return `r:${a.x}`;
      },
    });
    expect(await t.execute({ x: 'a' })).toBe('r:a');
    expect(await t.execute({ x: 'a' })).toBe('r:a');
    expect(calls).toBe(1); // second call served from cache
  });

  it('does not cache dangerous tools', async () => {
    let calls = 0;
    const t = new Tool({
      name: 'danger',
      description: 'd',
      dangerous: true,
      parameters: [{ name: 'x', type: 'string', description: 'x' }],
      handler: async () => {
        calls += 1;
        return 'a long enough result';
      },
    });
    await t.execute({ x: 'a' });
    await t.execute({ x: 'a' });
    expect(calls).toBe(2);
  });

  it('builds an OpenAI function schema', () => {
    const t = new Tool({
      name: 'mk',
      description: 'make',
      parameters: [
        { name: 'a', type: 'string', description: 'A' },
        { name: 'b', type: 'number', description: 'B', required: false, default: 1 },
      ],
    });
    const s = t.toFunctionSchema();
    expect(s.function.name).toBe('mk');
    expect(s.function.parameters.required).toEqual(['a']);
    expect(s.function.parameters.properties.b?.default).toBe(1);
  });
});

describe('ToolRegistry', () => {
  it('registers, gets, lists and unregisters', () => {
    const r = new ToolRegistry();
    const t = new Tool({ name: 'x', description: 'x' });
    r.register(t);
    expect(r.get('x')).toBe(t);
    expect(r.listNames()).toEqual(['x']);
    expect(r.unregister('x')).toBe(true);
    expect(r.unregister('x')).toBe(false);
    expect(r.get('x')).toBeNull();
  });

  it('merges another registry', () => {
    const a = new ToolRegistry();
    const b = new ToolRegistry();
    a.register(new Tool({ name: 'a', description: '' }));
    b.register(new Tool({ name: 'b', description: '' }));
    a.merge(b);
    expect(a.listNames().sort()).toEqual(['a', 'b']);
  });
});
