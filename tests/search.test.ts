import { describe, it, expect } from 'vitest';
import { decodeEntities, parseDdgHtml, parseBingHtml } from '../src/tools/builtin.js';

describe('decodeEntities', () => {
  it('decodes named, decimal, and hex entities', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('Sam&#183;Altman')).toBe('Sam·Altman');
    expect(decodeEntities('x&#x27;y')).toBe("x'y");
    expect(decodeEntities('a&ensp;b')).toBe('a b');
    expect(decodeEntities('&ldquo;hi&rdquo;')).toBe('“hi”');
  });
  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('&unknownthing;')).toBe('&unknownthing;');
  });
});

describe('parseDdgHtml', () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First &amp; Title</a>
      <a class="result__snippet">Snippet <b>one</b> here.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://plain.example.org/p">Second</a>
      <a class="result__snippet">Body two.</a>
    </div>`;
  it('extracts title/url/snippet and decodes the uddg redirect', () => {
    const r = parseDdgHtml(html, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      title: 'First & Title',
      url: 'https://example.com/a',
      snippet: 'Snippet one here.',
    });
    expect(r[1]!.url).toBe('https://plain.example.org/p');
  });
  it('respects the max cap', () => {
    expect(parseDdgHtml(html, 1)).toHaveLength(1);
  });
});

describe('parseBingHtml', () => {
  const html = `
    <li class="b_algo">
      <h2 class=""><a target="_blank" href="https://news.example.com/x" h="ID=SERP">Big &#183; News</a></h2>
      <div class="b_caption"><p class="b_lineclamp2">Oct 9, 2025&ensp;·&ensp;summary text.</p></div>
    </li>
    <li class="b_algo">
      <h2><a href="https://two.example.com/">Second result</a></h2>
      <div class="b_caption"><p>second snippet</p></div>
    </li>`;
  it('extracts results from b_algo blocks with attributes on h2/li', () => {
    const r = parseBingHtml(html, 5);
    expect(r).toHaveLength(2);
    expect(r[0]!.title).toBe('Big · News');
    expect(r[0]!.url).toBe('https://news.example.com/x');
    expect(r[0]!.snippet).toContain('summary text');
    expect(r[1]!.url).toBe('https://two.example.com/');
  });
  it('skips blocks without an http link', () => {
    expect(parseBingHtml('<li class="b_algo"><h2><a href="/relative">x</a></h2></li>', 5)).toEqual(
      [],
    );
  });
});
