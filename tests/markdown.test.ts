import { describe, it, expect } from 'vitest';
import { formatMarkdownLine, renderInline } from '../src/cli/markdown.js';

// chalk auto-disables color in the (non-TTY) test env, so output is plain text —
// we assert the markdown *markers* are gone and structure is applied.

describe('renderInline', () => {
  it('strips bold/italic/code markers', () => {
    expect(renderInline('a **b** c')).toBe('a b c');
    expect(renderInline('a *b* c')).toBe('a b c');
    expect(renderInline('a `b` c')).toBe('a b c');
    expect(renderInline('a __b__ c')).toBe('a b c');
  });
  it('does not interpret markers inside code spans', () => {
    expect(renderInline('`a*b*c`')).toBe('a*b*c');
  });
  it('renders links as text + url', () => {
    expect(renderInline('see [docs](https://x.com)')).toBe('see docs (https://x.com)');
  });
});

describe('formatMarkdownLine', () => {
  it('blank lines collapse to empty', () => {
    expect(formatMarkdownLine('   ')).toBe('');
  });
  it('headings drop the # and indent', () => {
    expect(formatMarkdownLine('## Title')).toBe('  Title');
  });
  it('unordered list → bullet', () => {
    expect(formatMarkdownLine('- item')).toBe('  • item');
  });
  it('ordered list keeps the number', () => {
    expect(formatMarkdownLine('1. first')).toBe('  1. first');
  });
  it('blockquote gets a bar', () => {
    expect(formatMarkdownLine('> quoted')).toBe('  ▏ quoted');
  });
  it('horizontal rule becomes a hairline', () => {
    expect(formatMarkdownLine('---')).toMatch(/─{10,}/);
  });
  it('plain text is indented with inline styling applied', () => {
    expect(formatMarkdownLine('hello **world**')).toBe('  hello world');
  });
});
