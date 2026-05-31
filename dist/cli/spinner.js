/**
 * Terminal spinner for the interactive REPL — the animated "thinking…" /
 * tool-progress indicator. Mirrors the Python Rich console.status spinner
 * (per-agent themes from AGENT_SPINNERS).
 *
 * No-op on a non-TTY stream (piped output / tests) so we never emit escape
 * codes or carriage returns into captured output.
 */
import chalk from 'chalk';
import { AGENT_COLORS } from '../core/icons.js';
// Per-agent frame sets (named after the Rich spinner themes they replace).
const FRAMES = {
    dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    line: ['-', '\\', '|', '/'],
    star: ['✶', '✸', '✹', '✺', '✹', '✷'],
    dots2: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
    bounce: ['⠁', '⠂', '⠄', '⠂'],
    arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
};
const AGENT_SPINNER = {
    fog: 'dots',
    rain: 'line',
    frost: 'star',
    snow: 'dots2',
    dew: 'bounce',
    fair: 'arc',
};
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
export class Spinner {
    frames;
    paint;
    label;
    i = 0;
    timer = null;
    tty;
    t0 = Date.now();
    constructor(agentName, label) {
        this.frames = FRAMES[AGENT_SPINNER[agentName] ?? 'dots'] ?? FRAMES.dots;
        this.paint = styler(AGENT_COLORS[agentName] ?? 'white');
        this.label = label;
        this.tty = Boolean(process.stdout.isTTY);
    }
    get active() {
        return this.timer !== null;
    }
    /** Update the spinner caption (e.g. switch from "thinking" to a tool action). */
    setLabel(label) {
        this.label = label;
        if (this.tty && this.active)
            this.render();
    }
    start() {
        if (!this.tty || this.timer)
            return;
        process.stdout.write('\x1B[?25l'); // hide cursor
        this.render();
        this.timer = setInterval(() => {
            this.i = (this.i + 1) % this.frames.length;
            this.render();
        }, 90);
        // Don't keep the event loop alive solely for the spinner.
        this.timer.unref?.();
    }
    /** Stop and erase the spinner line (cursor returns to column 0). */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.tty) {
            process.stdout.write('\r\x1B[K\x1B[?25h'); // clear line + show cursor
        }
    }
    render() {
        const frame = this.paint(this.frames[this.i] ?? '');
        const secs = ((Date.now() - this.t0) / 1000).toFixed(1);
        process.stdout.write(`\r\x1B[K${frame} ${chalk.dim(this.label)} ${chalk.dim(`(${secs}s)`)}`);
    }
}
