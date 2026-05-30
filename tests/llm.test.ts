import { describe, it, expect } from 'vitest';
import {
  LLMClient,
  splitProvider,
  isAnthropicModel,
  estimateTokens,
  estimateCost,
  isTransientError,
  formatUserFacingError,
  toCoreMessages,
  type CompletionBackend,
  type CompletionRequest,
  type RawCompletion,
  type RawStreamChunk,
} from '../src/core/llm.js';
import { defaultAppConfig } from '../src/core/config.js';
import { ToolRegistry } from '../src/core/tool.js';

function client(backend: CompletionBackend, costLimit: number | null = null): LLMClient {
  return new LLMClient(defaultAppConfig(), new ToolRegistry(), { backend, costLimit });
}

// A deterministic fake backend (mirrors the Python litellm mock).
class FakeBackend implements CompletionBackend {
  calls = 0;
  constructor(
    private readonly onComplete: (req: CompletionRequest) => RawCompletion,
    private readonly chunks: RawStreamChunk[] = [],
  ) {}
  async complete(req: CompletionRequest): Promise<RawCompletion> {
    this.calls += 1;
    return this.onComplete(req);
  }
  async *stream(): AsyncIterable<RawStreamChunk> {
    for (const c of this.chunks) yield c;
  }
}

const raw = (over: Partial<RawCompletion> = {}): RawCompletion => ({
  content: 'hello from the model',
  toolCalls: [],
  reasoningContent: null,
  promptTokens: 100,
  completionTokens: 50,
  model: '',
  ...over,
});

describe('pure helpers', () => {
  it('splitProvider', () => {
    expect(splitProvider('deepseek/deepseek-v4-flash')).toEqual(['deepseek', 'deepseek-v4-flash']);
    expect(splitProvider('gpt-4o-mini')).toEqual([null, 'gpt-4o-mini']);
    expect(splitProvider('unknownvendor/x')).toEqual([null, 'unknownvendor/x']);
  });

  it('isAnthropicModel', () => {
    expect(isAnthropicModel('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicModel('claude-haiku-4-5')).toBe(true);
    expect(isAnthropicModel('gpt-4o')).toBe(false);
  });

  it('estimateTokens weights CJK heavier', () => {
    expect(estimateTokens('你好')).toBe(4);
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('estimateCost uses the cost map', () => {
    expect(estimateCost('gpt-4o', 1000, 1000)).toBeCloseTo(0.0025 + 0.01, 6);
    expect(estimateCost('unknown-model', 1000, 0)).toBeCloseTo(0.001, 6);
  });

  it('isTransientError', () => {
    expect(isTransientError({ statusCode: 429 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError(new Error('nope'))).toBe(false);
  });

  it('formatUserFacingError classifies common cases', () => {
    expect(formatUserFacingError('gpt-4o', new Error('Invalid api_key'))).toContain('API key');
    expect(formatUserFacingError('gpt-4o', new Error('rate limit hit'))).toContain('速率受限');
    expect(formatUserFacingError('gpt-4o', new Error('request timeout'))).toContain('超时');
  });
});

describe('LLMClient.complete', () => {
  it('returns content and tracks usage + cost', async () => {
    const backend = new FakeBackend(() => raw());
    const c = client(backend);
    const res = await c.complete([{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('hello from the model');
    expect(res.usage.prompt_tokens).toBe(100);
    expect(c.getTotalCost()).toBeGreaterThan(0);
    expect(c.getUsageStats().default!.calls).toBe(1);
  });

  it('falls back to the next model when the primary fails', async () => {
    const backend = new FakeBackend((req) => {
      if (req.model.includes('deepseek')) throw new Error('primary down');
      return raw({ content: `ok from ${req.model}`, model: req.model });
    });
    const c = client(backend);
    const res = await c.complete([{ role: 'user', content: 'hi' }], {
      overrides: { model: 'deepseek/deepseek-v4-flash' },
    });
    expect(res.content).toBe('ok from gpt-4.1-mini');
    expect(res.model).toBe('gpt-4.1-mini');
  });

  it('returns a formatted error when every model fails', async () => {
    const backend = new FakeBackend(() => {
      throw new Error('Invalid api_key provided');
    });
    const c = client(backend);
    const res = await c.complete([{ role: 'user', content: 'hi' }], {
      overrides: { model: 'gpt-4o' },
    });
    expect(res.content).toContain('API key');
  });

  it('serves a cache hit without calling the backend twice', async () => {
    const backend = new FakeBackend(() => raw({ content: 'a sufficiently long cached answer' }));
    const c = client(backend);
    const msgs = [{ role: 'user', content: 'same question' }];
    await c.complete(msgs);
    await c.complete(msgs);
    expect(backend.calls).toBe(1);
  });

  it('throws when the budget is exhausted', async () => {
    const backend = new FakeBackend(() => raw());
    const c = client(backend, 0);
    await expect(c.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('Cost limit');
  });
});

describe('LLMClient.streamWithTools', () => {
  it('emits content, then tool_call, then done', async () => {
    const backend = new FakeBackend(
      () => raw(),
      [
        { kind: 'content', text: 'Let me ' },
        { kind: 'content', text: 'check.' },
        {
          kind: 'tool_call',
          toolCall: {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        },
        { kind: 'usage', promptTokens: 20, completionTokens: 10 },
      ],
    );
    const c = client(backend);
    const events = [];
    for await (const ev of c.streamWithTools([{ role: 'user', content: 'go' }])) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    expect(types).toEqual(['content', 'content', 'tool_call', 'done']);
    expect(events.find((e) => e.type === 'tool_call')!.toolCall!.function.name).toBe('read_file');
    expect(events.at(-1)!.usage!.prompt_tokens).toBe(20);
  });
});

describe('toCoreMessages (OpenAI → AI SDK CoreMessage)', () => {
  it('passes system/user through as plain content', () => {
    const out = toCoreMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('plain assistant message stays a string', () => {
    expect(toCoreMessages([{ role: 'assistant', content: 'ok' }])).toEqual([
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('assistant tool_calls become tool-call parts (args parsed)', () => {
    const out = toCoreMessages([
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
    ]);
    expect(out[0]!.role).toBe('assistant');
    const parts = out[0]!.content as any[];
    expect(parts[0]).toEqual({ type: 'text', text: 'let me check' });
    expect(parts[1]).toEqual({
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'read_file',
      args: { path: 'a' },
    });
  });

  it('tool result becomes a tool-result part with toolName recovered by id', () => {
    const out = toCoreMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'file body', tool_call_id: 'c1' },
    ]);
    const toolMsg = out[1]!;
    expect(toolMsg.role).toBe('tool');
    expect((toolMsg.content as any[])[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'c1',
      toolName: 'read_file',
      result: 'file body',
    });
  });

  it('handles malformed tool_call arguments without throwing', () => {
    const out = toCoreMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 't', arguments: 'not json' } },
        ],
      },
    ]);
    expect((out[0]!.content as any[])[0].args).toEqual({});
  });
});

describe('LLMClient.stream', () => {
  it('yields plain text chunks', async () => {
    const backend = new FakeBackend(
      () => raw(),
      [
        { kind: 'content', text: 'a' },
        { kind: 'content', text: 'b' },
      ],
    );
    const c = client(backend);
    let out = '';
    for await (const chunk of c.stream([{ role: 'user', content: 'hi' }])) out += chunk;
    expect(out).toBe('ab');
  });
});
