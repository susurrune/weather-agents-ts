/**
 * Agent icon system — dynamic status indicators.
 *
 * Static decorative icons are removed. Each agent is identified by its
 * display name with color styling. During processing, the agent
 * spinners (defined in cli/main.ts AGENT_SPINNERS) provide dynamic status.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const _here = dirname(fileURLToPath(import.meta.url));
// src/core -> package root /assets/icons
const _ICONS_DIR = join(_here, '..', '..', 'assets', 'icons');
export const AGENT_COLOR_MAP = {
    fog: 'bright_white',
    rain: 'blue',
    frost: 'cyan',
    snow: 'bright_white',
    dew: 'green',
    fair: '#FFD700',
};
// Public alias — use this, not the raw map, for stable API.
export const AGENT_COLORS = AGENT_COLOR_MAP;
// Agent icon glyph map — used for tests and any map-based lookup.
export const AGENT_EMOJI = {
    fog: '≋',
    rain: '╱',
    frost: '✱',
    snow: '❉',
    dew: '∘',
    fair: '☼',
};
/** Return the filesystem path to an agent's SVG icon file. */
export function svgPath(name) {
    return join(_ICONS_DIR, `${name}.svg`);
}
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
export function iconText(name) {
    return AGENT_EMOJI[name] ?? name;
}
//# sourceMappingURL=icons.js.map