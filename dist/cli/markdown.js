/**
 * Lightweight Markdown → ANSI renderer for streamed agent replies.
 *
 * Works line-by-line so it composes with token streaming: the caller buffers
 * text and hands us one complete line at a time. Inline spans (bold, italic,
 * code, links) are styled within a line; block prefixes (headings, lists,
 * quotes, rules) restyle the whole line.
 */
import chalk from 'chalk';
/** Style inline spans: `code`, **bold**, *italic*, [text](url). */
export function renderInline(text) {
    // Split on `code` spans and only style the non-code segments, so markdown
    // markers inside code aren't interpreted. Segments are always within a line.
    const parts = text.split(/(`[^`]+`)/g);
    return parts
        .map((seg) => {
        if (seg.length >= 2 && seg.startsWith('`') && seg.endsWith('`')) {
            return chalk.cyan(seg.slice(1, -1));
        }
        return seg
            .replace(/\*\*([^*]+)\*\*/g, (_, b) => chalk.bold(b))
            .replace(/__([^_]+)__/g, (_, b) => chalk.bold(b))
            .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (_, pre, i) => `${pre}${chalk.italic(i)}`)
            .replace(/(^|[^_])_([^_]+)_(?!_)/g, (_, pre, i) => `${pre}${chalk.italic(i)}`)
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `${chalk.underline(t)} ${chalk.dim(`(${u})`)}`);
    })
        .join('');
}
/** Format one complete Markdown line into an ANSI-styled, 2-space-indented line. */
export function formatMarkdownLine(line) {
    const body = line.replace(/\r$/, '').trimEnd();
    if (body.trim() === '')
        return '';
    // Horizontal rule → a dim hairline.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(body)) {
        return chalk.dim('  ' + '─'.repeat(40));
    }
    // Heading (#..######) → bold, brighter for higher levels.
    const h = body.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
        const level = h[1].length;
        const txt = renderInline(h[2]);
        return level <= 2 ? chalk.bold.cyan(`  ${txt}`) : chalk.bold(`  ${txt}`);
    }
    // Blockquote → dim with a bar.
    const q = body.match(/^>\s?(.*)$/);
    if (q)
        return chalk.dim(`  ▏ ${renderInline(q[1])}`);
    // Unordered list item (preserve nesting indent).
    const ul = body.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul)
        return `  ${ul[1]}${chalk.cyan('•')} ${renderInline(ul[2])}`;
    // Ordered list item.
    const ol = body.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ol)
        return `  ${ol[1]}${chalk.cyan(`${ol[2]}.`)} ${renderInline(ol[3])}`;
    return `  ${renderInline(body)}`;
}
