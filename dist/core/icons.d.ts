/**
 * Agent icon system — dynamic status indicators.
 *
 * Static decorative icons are removed. Each agent is identified by its
 * display name with color styling. During processing, the agent
 * spinners (defined in cli/main.ts AGENT_SPINNERS) provide dynamic status.
 */
export declare const AGENT_COLOR_MAP: Record<string, string>;
export declare const AGENT_COLORS: Record<string, string>;
export declare const AGENT_EMOJI: Record<string, string>;
/** Return the filesystem path to an agent's SVG icon file. */
export declare function svgPath(name: string): string;
/**
 * Return the plain-text icon for an agent.
 *
 * Used in dashboards, prompts, logs, and any UI where SVG can't render.
 * The glyphs are deliberately chosen from Unicode blocks that render
 * as monochrome text on virtually every terminal — NOT from "Symbols
 * and Pictographs" which would force colored emoji presentation.
 *
 *   fog  ≋  three wavy lines — drifting mist
 *   rain ╱  slanted line — falling raindrop
 *   frost ✱  pointed asterisk — frost crystal
 *   snow ❉  balloon-spoked star — snowflake
 *   dew  ∘  ring — dewdrop
 *   fair ☼  sun with rays — clear sky
 */
export declare function iconText(name: string): string;
