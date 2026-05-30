import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isThinContent, runOrchestration } from '../src/core/factory.js';
import { matchPipeline } from '../src/core/pipelines.js';
import { BaseAgent, type TaskResult, Task } from '../src/core/agent.js';
import { defaultAppConfig, type AppConfig, type MemoryConfig } from '../src/core/config.js';
import { MessageBus } from '../src/core/bus.js';
import { ToolRegistry } from '../src/core/tool.js';
import { SnowAgent } from '../src/agents/snow.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-factory-'));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function cfg(): AppConfig {
  const c = defaultAppConfig();
  (c.memory as MemoryConfig).dbPath = join(dir, 'memory.db');
  return c;
}

describe('isThinContent', () => {
  it('flags empty / whitespace', () => {
    expect(isThinContent('')).toBe(true);
    expect(isThinContent('   ')).toBe(true);
  });
  it('flags placeholder acks', () => {
    expect(isThinContent('done')).toBe(true);
    expect(isThinContent('已完成。')).toBe(true);
    expect(isThinContent('OK!')).toBe(true);
  });
  it('flags truncation / error markers', () => {
    expect(isThinContent('[truncated] ran out of rounds')).toBe(true);
    expect(isThinContent('[error: boom]')).toBe(true);
  });
  it('flags short status reports without deliverable markers', () => {
    expect(isThinContent('调研工作已完成，包括 5 个数据库。')).toBe(true);
  });
  it('accepts real deliverables', () => {
    expect(isThinContent('Here is the code:\n```js\nconst x = 1;\n```')).toBe(false);
    expect(isThinContent('a'.repeat(500))).toBe(false);
    expect(isThinContent('调研完成，详见 https://example.com/report')).toBe(false);
  });
});

/** A snow stub that returns a fixed plan and judges achieved. */
class StubSnow extends SnowAgent {
  plan: Task[] = [];
  override async orchestrate(): Promise<Task[]> {
    return this.plan;
  }
  // chatOneshot is used by the summarizer/judge
  override async chatOneshot(): Promise<string> {
    return '{"achieved": true, "missing": ""}';
  }
}

class StubWorker extends BaseAgent {
  static override agentName = 'rain';
  static override agentDisplayName = 'Rain';
  static override agentSpecialty = 'gen';
  static override agentSystemPrompt = 'worker';
  override async executeTask(task: Task): Promise<TaskResult> {
    return { success: true, content: `output for ${task.id}: ` + 'x'.repeat(450), data: {} };
  }
}

describe('runOrchestration', () => {
  it('executes a single-task plan and returns its content as summary', async () => {
    const bus = new MessageBus();
    const c = cfg();
    const snow = new StubSnow(
      c,
      { complete: async () => ({ content: '' }) } as any,
      bus,
      new ToolRegistry(),
    );
    const rain = new StubWorker(
      c,
      { complete: async () => ({ content: '' }) } as any,
      bus,
      new ToolRegistry(),
    );
    await snow.init();
    await rain.init();
    snow.plan = [new Task({ id: '1', description: 'do it', assignedTo: 'rain' })];

    const { results, summary } = await runOrchestration(
      'build a thing',
      { snow, rain } as any,
      snow,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    expect(summary).toContain('output for 1');
    await snow.close();
    await rain.close();
  });

  it('executes a DAG respecting dependencies', async () => {
    const bus = new MessageBus();
    const c = cfg();
    const order: string[] = [];
    class OrderedWorker extends BaseAgent {
      static override agentName = 'rain';
      static override agentDisplayName = 'Rain';
      static override agentSpecialty = 'gen';
      static override agentSystemPrompt = 'w';
      override async executeTask(task: Task): Promise<TaskResult> {
        order.push(task.id);
        return { success: true, content: `r${task.id} ` + 'y'.repeat(450), data: {} };
      }
    }
    const snow = new StubSnow(
      c,
      { complete: async () => ({ content: '' }) } as any,
      bus,
      new ToolRegistry(),
    );
    const rain = new OrderedWorker(
      c,
      { complete: async () => ({ content: '' }) } as any,
      bus,
      new ToolRegistry(),
    );
    await snow.init();
    await rain.init();
    snow.plan = [
      new Task({ id: '1', description: 'first', assignedTo: 'rain' }),
      new Task({ id: '2', description: 'second', assignedTo: 'rain', dependsOn: ['1'] }),
    ];
    const { results } = await runOrchestration('two steps', { snow, rain } as any, snow);
    expect(results.map((r) => r.id)).toEqual(['1', '2']);
    expect(order).toEqual(['1', '2']); // dependency order respected
    await snow.close();
    await rain.close();
  });
});

describe('matchPipeline (integration with orchestration)', () => {
  it('code_review goal matches the frost pipeline', () => {
    const p = matchPipeline('帮我做代码审查');
    expect(p?.name).toBe('code_review');
    expect(p?.steps[0]?.agent).toBe('frost');
  });
  it('non-matching goal returns null', () => {
    expect(matchPipeline('随便聊聊')).toBeNull();
  });
});
