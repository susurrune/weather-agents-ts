/**
 * Interactive-mode welcome screen — faithful port of the Python Rich panel
 * (_build_welcome_art / _print_welcome). Rendered with chalk + box-drawing
 * characters since there is no Rich equivalent in Node.
 */
import chalk from 'chalk';
import { AGENT_CLASSES } from '../core/factory.js';
import { AGENT_COLORS, AGENT_EMOJI } from '../core/icons.js';
const ROLE = {
    fog: 'research',
    rain: 'codegen',
    frost: 'review',
    snow: 'planning',
    dew: 'devops',
    fair: 'companion',
};
const INNER = 66; // panel inner width (between the borders)
const COL = 11; // per-agent column width
/** Map a Rich color name (or hex) to a chalk styler. */
function styler(color) {
    switch (color) {
        case 'blue':
            return chalk.blue;
        case 'cyan':
            return chalk.cyan;
        case 'green':
            return chalk.green;
        case 'bright_white':
            return chalk.whiteBright;
        default:
            return color.startsWith('#') ? chalk.hex(color) : chalk.white;
    }
}
/** Visual width counting CJK / full-width code points as 2 columns. */
function vwidth(s) {
    let w = 0;
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        const wide = (cp >= 0x1100 && cp <= 0x115f) ||
            (cp >= 0x2e80 && cp <= 0xa4cf) ||
            (cp >= 0xac00 && cp <= 0xd7a3) ||
            (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0xff00 && cp <= 0xff60) ||
            (cp >= 0xffe0 && cp <= 0xffe6) ||
            (cp >= 0x1f300 && cp <= 0x1faff);
        w += wide ? 2 : 1;
    }
    return w;
}
/** Center `text` (visual width `vw`) in a field of `width`. */
function center(text, width, vw = vwidth(text)) {
    if (vw >= width)
        return text;
    const total = width - vw;
    const left = Math.floor(total / 2);
    return ' '.repeat(left) + text + ' '.repeat(total - left);
}
/** Wrap one inner line of plain visual width `vw` in the rounded border. */
function boxLine(rendered, vw) {
    const pad = Math.max(0, INNER - vw);
    return chalk.dim('│ ') + rendered + ' '.repeat(pad) + chalk.dim(' │');
}
function buildArt() {
    const dim = chalk.dim;
    const star1 = '        ·  ✦  ·       · ✦  ·  ✦       ✦  ·  ✦  ·';
    const star2 = '     ✦        ✦    ✦         ✦    ·         ✦';
    const title = '≈  W E A T H E R   A G E N T S  ≈';
    const star3 = '     ·        ·    ·         ·    ✦         ·';
    const star4 = '        ✦  ·  ✦       ✦ ·  ✦  ·       ·  ✦  ·';
    const titleRendered = chalk.cyan.bold('≈') +
        chalk.bold.white('  W E A T H E R   A G E N T S  ') +
        chalk.cyan.bold('≈');
    return [
        boxLine(dim(center(star1, INNER)), INNER),
        boxLine(dim(center(star2, INNER)), INNER),
        boxLine(center(titleRendered, INNER, vwidth(title)), INNER),
        boxLine(dim(center(star3, INNER)), INNER),
        boxLine(dim(center(star4, INNER)), INNER),
    ];
}
/** Print the full welcome panel (start of interactive mode and on /clear). */
export function printWelcome(model, activeAgent, workspacePath = '') {
    const names = Object.keys(AGENT_CLASSES);
    const out = [];
    out.push(chalk.dim('╭' + '─'.repeat(INNER + 2) + '╮'));
    out.push(boxLine('', 0));
    for (const line of buildArt())
        out.push(line);
    out.push(boxLine('', 0));
    // Agent row: three stacked lines (name / role / status) across 6 columns.
    const line1 = [];
    const line2 = [];
    const line3 = [];
    for (const name of names) {
        const cls = AGENT_CLASSES[name];
        const color = AGENT_COLORS[name] ?? 'white';
        const paint = styler(color);
        const active = name === activeAgent;
        const display = cls.agentDisplayName || name;
        const role = ROLE[name] ?? '';
        const dot = active ? '●' : '○';
        const statusTxt = active ? 'active' : 'standby';
        line1.push(center(paint.bold(display), COL, vwidth(display)));
        line2.push(center(chalk.dim.italic(role), COL, vwidth(role)));
        const status = `${dot} ${statusTxt}`;
        line3.push(center(active ? paint.bold(status) : chalk.dim(status), COL, vwidth(status)));
    }
    const rowWidth = COL * names.length;
    const indent = Math.max(0, Math.floor((INNER - rowWidth) / 2));
    const pad = ' '.repeat(indent);
    out.push(boxLine(pad + line1.join(''), indent + rowWidth));
    out.push(boxLine(pad + line2.join(''), indent + rowWidth));
    out.push(boxLine(pad + line3.join(''), indent + rowWidth));
    out.push(boxLine('', 0));
    // Meta: model · workspace
    const shortWs = workspacePath && workspacePath.length > 40 ? '…' + workspacePath.slice(-38) : workspacePath;
    const metaPlain = `model  ${model}   ·   workspace  ${shortWs || '(none)'}`;
    const metaRendered = chalk.dim('model  ') +
        chalk.cyan.bold(model) +
        chalk.dim('   ·   workspace  ') +
        (shortWs ? chalk.white(shortWs) : chalk.dim('(none)'));
    out.push(boxLine(center(metaRendered, INNER, vwidth(metaPlain)), INNER));
    out.push(boxLine('', 0));
    // Tip
    const tipPlain = 'Type  /  for commands  ·  /help  for reference';
    const tipRendered = chalk.dim('Type  ') +
        chalk.cyan.bold('/') +
        chalk.dim('  for commands  ·  ') +
        chalk.cyan.bold('/help') +
        chalk.dim('  for reference');
    out.push(boxLine(center(tipRendered, INNER, vwidth(tipPlain)), INNER));
    out.push(boxLine('', 0));
    out.push(chalk.dim('╰' + '─'.repeat(INNER + 2) + '╯'));
    console.log('\n' + out.join('\n') + '\n');
}
/** Short one-line banner used after an in-REPL agent switch. */
export function agentBanner(name) {
    const color = AGENT_COLORS[name] ?? 'white';
    const cls = AGENT_CLASSES[name];
    const emoji = AGENT_EMOJI[name] ?? '';
    return (styler(color).bold(`${emoji} ${cls?.agentDisplayName ?? name}`) +
        chalk.dim(`  ${ROLE[name] ?? ''}  ·  /help for commands`));
}
