/** Pipeline templates — predefined multi-agent DAGs. Rule-only match (<1µs). */
import { Task } from './agent.js';

export interface PipelineStep {
  id: string;
  agent: string;
  descriptionTemplate: string;
  dependsOn: string[];
}

export interface Pipeline {
  name: string;
  triggers: string[];
  steps: PipelineStep[];
  requireRegex: string[];
}

const PIPELINES: Pipeline[] = [
  {
    name: 'code_review',
    triggers: ['审查代码', '代码审查', 'code review', 'review my code', '审计安全', '安全审计'],
    steps: [{ id: '1', agent: 'frost', descriptionTemplate: '审查代码: {goal}', dependsOn: [] }],
    requireRegex: [],
  },
  {
    name: 'research_then_write',
    triggers: [
      '调研后写',
      'research and write',
      '先调研再写',
      'research then write',
      '调研后生成',
      '调研并撰写',
    ],
    steps: [
      { id: '1', agent: 'fog', descriptionTemplate: '调研: {goal}', dependsOn: [] },
      {
        id: '2',
        agent: 'rain',
        descriptionTemplate: '基于 fog 的调研结果,撰写: {goal}',
        dependsOn: ['1'],
      },
    ],
    requireRegex: [],
  },
  {
    name: 'write_then_review',
    triggers: [
      '写代码并审查',
      'write and review',
      '生成并审查',
      '写后审查',
      '先写再查',
      'code then review',
    ],
    steps: [
      { id: '1', agent: 'rain', descriptionTemplate: '生成: {goal}', dependsOn: [] },
      {
        id: '2',
        agent: 'frost',
        descriptionTemplate: '审查 rain 的输出: {goal}',
        dependsOn: ['1'],
      },
    ],
    requireRegex: [],
  },
  {
    name: 'full_pipeline',
    triggers: ['完整流程', 'full pipeline', '全流程', '一条龙', 'end to end'],
    steps: [
      { id: '1', agent: 'fog', descriptionTemplate: '调研: {goal}', dependsOn: [] },
      { id: '2', agent: 'rain', descriptionTemplate: '基于调研生成: {goal}', dependsOn: ['1'] },
      { id: '3', agent: 'frost', descriptionTemplate: '审查输出: {goal}', dependsOn: ['2'] },
    ],
    requireRegex: [],
  },
];

// Compiled regex cache keyed by pipeline identity.
const REGEX_CACHE = new Map<Pipeline, RegExp[]>();

function compiledRegex(p: Pipeline): RegExp[] {
  let c = REGEX_CACHE.get(p);
  if (!c) {
    c = p.requireRegex.map((rx) => new RegExp(rx, 'i'));
    REGEX_CACHE.set(p, c);
  }
  return c;
}

/** Return the first matching pipeline, or null. Case-insensitive substring + regex. */
export function matchPipeline(goal: string): Pipeline | null {
  if (!goal) return null;
  const lower = goal.toLowerCase();
  for (const p of PIPELINES) {
    if (!p.triggers.some((t) => lower.includes(t.toLowerCase()))) continue;
    if (p.requireRegex.length && !compiledRegex(p).some((rx) => rx.test(lower))) continue;
    return p;
  }
  return null;
}

/** Materialize a pipeline into runtime Task objects (full DAG). */
export function buildTasksFromPipeline(pipeline: Pipeline, goal: string): Task[] {
  const tasks: Task[] = [];
  for (const step of pipeline.steps) {
    const parentId = step.dependsOn[0] ?? null;
    tasks.push(
      new Task({
        id: step.id,
        description: step.descriptionTemplate.replace(/\{goal\}/g, goal),
        assignedTo: step.agent,
        parentId,
        dependsOn: [...step.dependsOn],
      }),
    );
  }
  return tasks;
}
