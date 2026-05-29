import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseAgent, Task, TaskState, type ChatStreamEvent } from '../src/core/agent.js';
import { defaultAppConfig, type MemoryConfig, type AppConfig } from '../src/core/config.js';
import { MessageBus } from '../src/core/bus.js';
import { ToolRegistry, Tool } from '../src/core/tool.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-agent-'));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function cfg(overrides: Partial<MemoryConfig> = {}): AppConfig {
  const c = defaultAppConfig();
  c.memory = { ...c.memory, ...overrides, dbPath: join(dir, 'memory.db') };
  return c;
}

/** A simple stub agent to exercise the BaseAgent constructor + init. */
class StubAgent extends BaseAgent {
  static override agentName = 'stub';
  static override agentDisplayName = 'Stub';
  static override agentEmoji = '?';
  static override agentSpecialty = 'testing';
  static override agentSystemPrompt = 'You are a stub agent for testing.';
}

describe('Task', () => {
  it('validates state transitions', () => {
    const t = new Task({ id: '1', description: 'd' });
    expect(t.status).toBe(TaskState.PENDING);
    t.transitionTo(TaskState.RUNNING);
    expect(t.status).toBe(TaskState.RUNNING);
    expect(() => t.transitionTo(TaskState.PENDING)).toThrow('Invalid task state transition');
  });

  it('allDeps merges depends_on and parent_id', () => {
    const t = new Task({ id: '1', description: 'd', dependsOn: ['2'], parentId: '3' });
    expect(t.allDeps).toEqual(['2', '3']);
  });
});

describe('BaseAgent.init', () => {
  it('builds the system prompt and creates a session', async () => {
    const config = cfg();
    const toolReg = new ToolRegistry();
    const bus = new MessageBus();
    const llm = { complete: async () => ({ content: '' }) } as any;
    const agent = new StubAgent(config, llm, bus, toolReg);
    await agent.init();
    expect(agent.memory.getActiveSession()).not.toBeNull();
    expect(agent.getAvailableSkills()).toEqual([]);
    // system prompt should be present in short_term
    const sysMsgs = agent.memory.shortTerm.filter((m) => m.role === 'system');
    expect(sysMsgs.length).toBeGreaterThanOrEqual(1);
    expect(sysMsgs[0]!.content).toContain('testing');
    await agent.close();
  });
});

describe('BaseAgent skill lifecycle', () => {
  it('list_skills and use_skill are registered', async () => {
    const agent = new StubAgent(
      cfg(),
      { complete: async () => ({ content: '' }) } as any,
      new MessageBus(),
      new ToolRegistry(),
    );
    await agent.init();
    expect(agent.toolRegistry.get('list_skills')).not.toBeNull();
    expect(agent.toolRegistry.get('use_skill')).not.toBeNull();
    expect(agent.toolRegistry.get('extend_rounds')).not.toBeNull();
    await agent.close();
  });
});

describe('BaseAgent auto-activate skills', () => {
  it('activates skills whose triggers match the message', async () => {
    const config = cfg();
    const toolReg = new ToolRegistry();
    const bus = new MessageBus();
    const agent = new StubAgent(
      config,
      { complete: async () => ({ content: '' }) } as any,
      bus,
      toolReg,
    );
    await agent.init();
    // Inject a skill with triggers via the registry
    const { Skill } = await import('../src/core/skill.js');
    agent.skillRegistry.register(
      new Skill({
        name: 't1',
        description: 'trigger test',
        triggers: ['deck', 'slides'],
        systemPrompt: 'skill prompt',
      }),
    );
    // Manually load skills (normally done in init but we've already inited)
    (agent as any).loadSkills();
    const activated = (agent as any).autoActivateSkills('can you make a deck');
    expect(activated).toContain('t1');
    expect(agent.getActiveSkills()).toContain('t1');
    await agent.close();
  });
});

describe('BaseAgent chatOneshot', () => {
  it('returns the LLM response content directly', async () => {
    const llm = {
      complete: async () => ({
        content: 'oneshot answer',
        toolCalls: [],
        model: 'mock',
        usage: {},
        cost: 0,
        reasoningContent: null,
        truncated: false,
      }),
    } as any;
    const agent = new StubAgent(cfg(), llm, new MessageBus(), new ToolRegistry());
    await agent.init();
    const result = await agent.chatOneshot('what is the weather');
    expect(result).toBe('oneshot answer');
    await agent.close();
  });
});

describe('BaseAgent chat', () => {
  it('runs chat_oneshot then persists the assistant response', async () => {
    const llm = {
      complete: async () => ({
        content: 'Hello!',
        toolCalls: [],
        model: 'mock',
        usage: {},
        cost: 0,
        reasoningContent: null,
        truncated: false,
      }),
    } as any;
    const agent = new StubAgent(cfg(), llm, new MessageBus(), new ToolRegistry());
    await agent.init();
    const result = await agent.chat('hi');
    expect(result).toBe('Hello!');
    const msgs = agent.memory.getMessages();
    expect(msgs.at(-1)!.role).toBe('assistant');
    expect(msgs.at(-1)!.content).toBe('Hello!');
    await agent.close();
  });
});

describe('BaseAgent compact', () => {
  it('refuses to compact a small context', async () => {
    const agent = new StubAgent(
      cfg(),
      { complete: async () => ({ content: '' }) } as any,
      new MessageBus(),
      new ToolRegistry(),
    );
    await agent.init();
    agent.memory.addMessage('user', 'hi');
    agent.memory.addMessage('assistant', 'hey');
    const result = await agent.compact(2);
    expect(result).toContain('already compact');
    await agent.close();
  });
});

describe('BaseAgent executeTask', () => {
  it('restores short_term after task isolation', async () => {
    const llm = {
      complete: async () => ({
        content: 'done',
        toolCalls: [],
        model: 'mock',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        cost: 0,
        reasoningContent: null,
        truncated: false,
      }),
    } as any;
    const agent = new StubAgent(cfg(), llm, new MessageBus(), new ToolRegistry());
    await agent.init();
    agent.memory.addMessage('user', 'chat msg');
    const preChat = agent.memory.shortTerm.length;
    const result = await agent.executeTask(new Task({ id: 't1', description: 'do something' }));
    expect(result.success).toBe(true);
    // short_term should be restored — chat msg is back
    expect(agent.memory.shortTerm.length).toBe(preChat);
    expect(agent.memory.shortTerm.find((m) => m.content === 'chat msg')).toBeDefined();
    await agent.close();
  });
});

describe('BaseAgent requestHelp', () => {
  it('publishes an AGENT_REQUEST and receives AGENT_RESPONSE', async () => {
    const bus = new MessageBus();
    const fog = new StubAgent(
      cfg(),
      {
        complete: async () => ({
          content: 'help from fog',
          toolCalls: [],
          model: 'm',
          usage: {},
          cost: 0,
          reasoningContent: null,
          truncated: false,
        }),
      } as any,
      bus,
      new ToolRegistry(),
    );
    const rain = new StubAgent(
      cfg(),
      {
        complete: async () => ({
          content: '',
          toolCalls: [],
          model: 'm',
          usage: {},
          cost: 0,
          reasoningContent: null,
          truncated: false,
        }),
      } as any,
      bus,
      new ToolRegistry(),
    );
    await fog.init();
    await rain.init();

    // Subscribe rain to its own bus events
    bus.subscribe('rain', async (e) => {
      if (e.type === 'agent_request' && (e as any).data) {
        const data = (e as any).data;
        await bus.publish({
          type: 'agent_response',
          source: 'rain',
          target: data.source,
          data: { correlation_id: data.correlation_id, content: 'help from rain', success: true },
          timestamp: new Date(),
        } as any);
      }
    });

    const result = await fog.requestHelp('rain', 'please help');
    expect(result).toBe('help from rain');
    await fog.close();
    await rain.close();
  });
});

describe('BaseAgent chatStream', () => {
  it('streams content and tool call events to completion', async () => {
    const llm = {
      streamWithTools: async function* () {
        yield {
          type: 'content',
          text: 'Let me ',
          toolCall: null,
          usage: null,
          reasoningContent: null,
        } as any;
        yield {
          type: 'content',
          text: 'check.',
          toolCall: null,
          usage: null,
          reasoningContent: null,
        } as any;
        yield {
          type: 'tool_call',
          text: '',
          toolCall: {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
          usage: null,
          reasoningContent: null,
        } as any;
        yield {
          type: 'done',
          text: '',
          toolCall: null,
          usage: { prompt_tokens: 5, completion_tokens: 3 },
          reasoningContent: null,
        } as any;
      },
    } as any;
    const toolReg = new ToolRegistry();
    toolReg.register(
      new Tool({
        name: 'read_file',
        description: 'Read a file',
        parameters: [{ name: 'path', type: 'string', description: 'path' }],
        handler: async () => 'file contents',
      }),
    );
    const agent = new StubAgent(cfg(), llm, new MessageBus(), toolReg);
    await agent.init();

    const events: ChatStreamEvent[] = [];
    for await (const ev of agent.chatStream('show me the file')) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('content');
    expect(types).toContain('tool_done');
    expect(types).toContain('done');
    await agent.close();
  });
});
