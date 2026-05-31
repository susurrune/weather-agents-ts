/**
 * Interactive-mode welcome screen — faithful port of the Python Rich panel
 * (_build_welcome_art / _print_welcome). Rendered with chalk + box-drawing
 * characters since there is no Rich equivalent in Node.
 */
/** Print the full welcome panel (start of interactive mode and on /clear).
 *  Width tracks the live terminal size so the panel fits the window. */
export declare function printWelcome(model: string, activeAgent: string, workspacePath?: string): void;
/** Short one-line banner used after an in-REPL agent switch. */
export declare function agentBanner(name: string): string;
