import { describe, it, expect } from 'vitest';
import { selectRelevantTools } from '../src/core/toolRouter.js';
import { Tool, ToolRegistry } from '../src/core/tool.js';

function makeRegistry(specs: Array<[string, string]>): ToolRegistry {
  const r = new ToolRegistry();
  for (const [name, description] of specs) {
    r.register(
      new Tool({
        name,
        description,
        parameters: [{ name: 'x', type: 'string', description: 'x' }],
      }),
    );
  }
  return r;
}

describe('selectRelevantTools', () => {
  it('short query returns the full set (no signal to filter)', () => {
    const r = makeRegistry(Array.from({ length: 20 }, (_, i) => [`tool_${i}`, `desc ${i}`]));
    const names = r.listNames();
    expect(new Set(selectRelevantTools(r, names, 'ok', { topK: 5 }))).toEqual(new Set(names));
  });

  it('small catalog returns full set', () => {
    const r = makeRegistry([
      ['a', 'alpha'],
      ['b', 'beta'],
    ]);
    const names = r.listNames();
    expect(new Set(selectRelevantTools(r, names, 'anything goes here', { topK: 12 }))).toEqual(
      new Set(names),
    );
  });

  it('caps at top_k for a large catalog', () => {
    const r = makeRegistry(Array.from({ length: 50 }, (_, i) => [`tool_${i}`, `desc ${i}`]));
    const names = r.listNames();
    expect(
      selectRelevantTools(r, names, 'find weather data', { topK: 10 }).length,
    ).toBeLessThanOrEqual(10);
  });

  it('relevant tools score higher (read_file for "read this config file")', () => {
    const r = makeRegistry([
      ['read_file', 'read a file from disk'],
      ['write_file', 'write content to a file'],
      ['send_email', 'send an email message'],
      ['fetch_url', 'fetch a web URL'],
      ['query_db', 'query the database'],
      ['compress', 'compress some data'],
      ['encrypt', 'encrypt a string'],
      ['decrypt', 'decrypt a string'],
      ['hash', 'compute hash'],
      ['compile', 'compile code'],
      ['parse', 'parse data'],
      ['validate', 'validate input'],
      ['ping', 'ping server'],
      ['trace', 'trace network'],
    ]);
    const selected = selectRelevantTools(r, r.listNames(), 'read this config file', { topK: 3 });
    expect(selected).toContain('read_file');
  });

  it('must-include tools are always present', () => {
    const r = makeRegistry(
      Array.from({ length: 20 }, (_, i) => [`random_${i}`, `unrelated tool ${i}`]),
    );
    r.register(new Tool({ name: 'special', description: 'x' }));
    const names = r.listNames();
    const selected = selectRelevantTools(r, names, 'find weather data report now', {
      topK: 3,
      mustInclude: new Set(['special']),
    });
    expect(selected).toContain('special');
  });
});
