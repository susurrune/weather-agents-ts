import { describe, it, expect } from 'vitest';
import {
  defaultAppConfig,
  loadModelCatalog,
  loadProviderCatalog,
  getProviderEnvVar,
  resolveProviderAlias,
  getModelContextWindow,
  formatModelsForDisplay,
  setConfig,
  AGENT_NAMES,
} from '../src/core/config.js';

describe('defaultAppConfig', () => {
  it('has the documented defaults', () => {
    const c = defaultAppConfig();
    expect(c.llm.defaultModel).toBe('deepseek/deepseek-v4-flash');
    expect(c.llm.maxTokens).toBe(16384);
    expect(c.llm.temperature).toBe(0.7);
    expect(c.cli.defaultAgent).toBe('fog');
    expect(c.web.port).toBe(8765);
    expect(Object.keys(c.agents).sort()).toEqual([...AGENT_NAMES].sort());
    expect(c.agents.fog.specialty).toBe('探索研究');
    expect(c.agents.fog.maxToolRounds).toBe(20);
  });
});

describe('model catalog (bundled models.yaml)', () => {
  it('loads a non-empty catalog with named entries', () => {
    const catalog = loadModelCatalog();
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
    const firstProvider = Object.values(catalog)[0]!;
    expect(firstProvider.length).toBeGreaterThan(0);
    expect(typeof firstProvider[0]!.name).toBe('string');
  });

  it('returns 128000 for unknown models', () => {
    expect(getModelContextWindow('totally-unknown-model-xyz')).toBe(128000);
  });

  it('strips a provider prefix when resolving context window', () => {
    // unknown base name still falls back to 128000 (exercises the "/" branch)
    expect(getModelContextWindow('someprovider/unknown-model')).toBe(128000);
  });

  it('formats the catalog without throwing', () => {
    expect(typeof formatModelsForDisplay(loadModelCatalog())).toBe('string');
  });
});

describe('provider catalog', () => {
  it('exposes known providers with env vars', () => {
    const cat = loadProviderCatalog();
    expect(Object.keys(cat).length).toBeGreaterThan(0);
    expect(getProviderEnvVar('openai')).toMatch(/API_KEY$/);
  });

  it('falls back to <PROVIDER>_API_KEY for unknown providers', () => {
    expect(getProviderEnvVar('made-up')).toBe('MADE_UP_API_KEY');
  });

  it('resolves an unknown alias to its lowercased self', () => {
    expect(resolveProviderAlias('OpenAI')).toBe('openai');
    expect(resolveProviderAlias('not-a-provider')).toBe('not-a-provider');
  });
});

describe('setConfig validation (failure paths do not write)', () => {
  it('rejects out-of-range temperature', () => {
    expect(setConfig('temperature', '3.0')[0]).toBe(false);
    expect(setConfig('temperature', 'abc')[0]).toBe(false);
  });

  it('rejects out-of-range max_tokens and timeout', () => {
    expect(setConfig('max_tokens', '0')[0]).toBe(false);
    expect(setConfig('timeout', '99999')[0]).toBe(false);
  });

  it('rejects unknown agents and keys', () => {
    expect(setConfig('model.wizard', 'x')[0]).toBe(false);
    expect(setConfig('cli.default_agent', 'wizard')[0]).toBe(false);
    expect(setConfig('totally.unknown', 'x')[0]).toBe(false);
  });
});
