/**
 * Terminal spinner for the interactive REPL — the animated "thinking…" /
 * tool-progress indicator. Mirrors the Python Rich console.status spinner
 * (per-agent themes from AGENT_SPINNERS).
 *
 * No-op on a non-TTY stream (piped output / tests) so we never emit escape
 * codes or carriage returns into captured output.
 */
export declare class Spinner {
    private frames;
    private paint;
    private label;
    private i;
    private timer;
    private readonly tty;
    private readonly t0;
    constructor(agentName: string, label: string);
    get active(): boolean;
    /** Update the spinner caption (e.g. switch from "thinking" to a tool action). */
    setLabel(label: string): void;
    start(): void;
    /** Stop and erase the spinner line (cursor returns to column 0).
     *  Idempotent: only clears the line when the spinner was actually running,
     *  so calling stop() again (e.g. on each content chunk) never erases the
     *  text we've already streamed. */
    stop(): void;
    private render;
}
