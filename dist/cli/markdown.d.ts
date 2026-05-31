/**
 * Lightweight Markdown → ANSI renderer for streamed agent replies.
 *
 * Works line-by-line so it composes with token streaming: the caller buffers
 * text and hands us one complete line at a time. Inline spans (bold, italic,
 * code, links) are styled within a line; block prefixes (headings, lists,
 * quotes, rules) restyle the whole line.
 */
/** Style inline spans: `code`, **bold**, *italic*, [text](url). */
export declare function renderInline(text: string): string;
/** Format one complete Markdown line into an ANSI-styled, 2-space-indented line. */
export declare function formatMarkdownLine(line: string): string;
