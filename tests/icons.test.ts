import { describe, it, expect } from 'vitest';
import { AGENT_COLORS, AGENT_EMOJI, iconText, svgPath } from '../src/core/icons.js';

describe('icons', () => {
  it('every agent has a color and a glyph', () => {
    for (const name of ['fog', 'rain', 'frost', 'snow', 'dew', 'fair']) {
      expect(AGENT_COLORS[name]).toBeTruthy();
      expect(AGENT_EMOJI[name]).toBeTruthy();
    }
  });

  it('iconText returns the glyph for known agents, the name for unknown', () => {
    expect(iconText('fog')).toBe('≋');
    expect(iconText('snow')).toBe('❉');
    expect(iconText('nonexistent')).toBe('nonexistent');
  });

  it('svgPath builds an .svg path for an agent', () => {
    expect(svgPath('fog')).toMatch(/fog\.svg$/);
  });
});
