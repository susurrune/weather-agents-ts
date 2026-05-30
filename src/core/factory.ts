/** Factory: create the system context (agents + bus + tools) and orchestrate tasks. */

import { MessageBus } from './bus.js';
import { type AppConfig, loadConfig } from './config.js';
import { LLMClient } from './llm.js';
import { ToolRegistry } from './tool.js';
import { SkillRegistry } from './skill.js';
import { type BaseAgent } from './agent.js';
import { classify, pickAgentForKey, type Mode } from './router.js';
import { matchPipeline, buildTasksFromPipeline } from './pipelines.js';
import { getLogger } from './logger.js';
import { Task, TaskState } from './agent.js';
import { sleep } from './util.js';
import { createDelegateTool } from '../tools/delegate.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import { registerAllSkills } from '../skills/loader.js';

import { FogAgent } from '../agents/fog.js';
import { RainAgent } from '../agents/rain.js';
import { FrostAgent } from '../agents/frost.js';
import { SnowAgent } from '../agents/snow.js';
import { DewAgent } from '../agents/dew.js';
import { FairAgent } from '../agents/fair.js';

const log = getLogger('factory');

const AGENT_CLASSES: Record<string, typeof FogAgent> = {
  fog: FogAgent,
  rain: RainAgent,
  frost: FrostAgent,
  snow: SnowAgent,
  dew: DewAgent,
  fair: FairAgent,
} as any;

export { AGENT_CLASSES };

export interface SystemContext {
  config: AppConfig;
  bus: MessageBus;
  llm: LLMClient;
  agentMap: Record<string, BaseAgent>;
  toolRegistry: ToolRegistry;
  workspacePath: string;
}

/**
 * Create the full system context: config, bus, LLM, tool/skill registries,
 * per-agent tool registries (cloned + delegate_to), and all six agents.
 */
export function createSystemContext(): SystemContext {
  const config = loadConfig();
  const bus = new MessageBus();
  const baseToolRegistry = new ToolRegistry();
  const baseSkillRegistry = new SkillRegistry();
  registerBuiltinTools(baseToolRegistry);
  registerAllSkills(baseSkillRegistry);
  const llm = new LLMClient(config, baseToolRegistry);

  const agents: Record<string, BaseAgent> = {};
  for (const [name, cls] of Object.entries(AGENT_CLASSES)) {
    const agentReg = new ToolRegistry();
    agentReg.merge(baseToolRegistry);
    const agentSkills = new SkillRegistry();
    agentSkills.merge(baseSkillRegistry);

    const agent = new (cls as any)(config, llm, bus, agentReg, agentSkills);
    agentReg.register(createDelegateTool(agents as any, agent));
    agents[name] = agent;
  }

  return {
    config,
    bus,
    llm,
    agentMap: agents,
    toolRegistry: baseToolRegistry,
    workspacePath: config.workspace.path,
  };
}

// ── Orchestration engine ─────────────────────────────────────────────────

export interface TaskExecutionResult {
  id: string;
  agent: string;
  description: string;
  success: boolean;
  content: string;
}

// Placeholder phrases the LLM emits when it gives up without producing real work.
const PLACEHOLDER_PATTERNS = new Set([
  'done',
  'ok',
  'completed',
  'task completed',
  'task done',
  'task finished',
  'finished',
  '已完成',
  '完成了',
  '好的',
  '好了',
  'ok!',
]);

const STATUS_REPORT_KEYWORDS = [
  '已完成',
  '完成了',
  '已成功',
  '已经完成',
  '工作已',
  '任务已',
  'task complete',
  'task is complete',
  'i have completed',
  "i've completed",
  'successfully completed',
  'finished the',
  'i finished',
  '已经写好',
  '已经写完',
  '已经做好',
  '写完了',
  '做完了',
];

const DELIVERABLE_MARKERS = [
  '```',
  'http://',
  'https://',
  '|',
  '## ',
  '###',
  '- [ ]',
  '1.',
  '/',
  '\\',
];

/** True if `content` is too thin to count as a real deliverable. */
export function isThinContent(content: string): boolean {
  if (!content) return true;
  const stripped = content.trim();
  if (!stripped) return true;
  const lowered = stripped.toLowerCase();
  if (lowered.startsWith('[truncated]') || lowered.startsWith('[error:')) return true;
  const bare = lowered.replace(/[.!?。！？ ]+$/, '').trim();
  if (PLACEHOLDER_PATTERNS.has(bare)) return true;
  return (
    stripped.length <= 200 &&
    STATUS_REPORT_KEYWORDS.some((kw) => lowered.includes(kw)) &&
    !DELIVERABLE_MARKERS.some((m) => stripped.includes(m))
  );
}

const RESULT_FAILURE_MARKERS = [
  '[truncated]',
  '[stuck]',
  '[Error',
  'Error:',
  '未能完成',
  '无法完成',
  '[cycle detected]',
  '[CircuitBreakerOpen]',
];

/** Cheap heuristic: are these multi-task results clearly done? */
function looksObviouslyComplete(results: TaskExecutionResult[]): boolean {
  if (!results.length) return false;
  for (const r of results) {
    if (!r.success) return false;
    const body = (r.content || '').trim();
    if (body.length < 400) return false;
    if (RESULT_FAILURE_MARKERS.some((m) => body.includes(m))) return false;
  }
  return true;
}

/** Run agent.executeTask with bounded retries on failure / thin content. */
async function executeWithRetry(
  agent: BaseAgent,
  task: Task,
  maxAttempts: number,
): Promise<{ success: boolean; content: string; truncated?: boolean }> {
  let lastResult: { success: boolean; content: string; truncated?: boolean } | null = null;
  let lastErr: unknown = null;
  const originalDescription = task.description;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await agent.executeTask(task);
      const content = result.content || '';
      const truncated = (result as any).truncated === true;
      const ok = result.success && !isThinContent(content);
      if (ok && !truncated) {
        task.description = originalDescription;
        return { success: true, content };
      }
      lastResult = { success: result.success, content, truncated };
      if (attempt < maxAttempts) {
        const reason = truncated
          ? 'previous attempt was truncated mid-tool-loop'
          : 'previous attempt was empty or a placeholder ack';
        task.description = `${originalDescription}\n\n[retry ${attempt + 1}/${maxAttempts}] ${reason}. You MUST produce the actual deliverable this time — do not respond with 'done', '完成', or any acknowledgement-only reply.`;
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < maxAttempts) await sleep(Math.min(0.5 * 2 ** (attempt - 1), 2.0) * 1000);
  }
  task.description = originalDescription;
  if (lastResult) return lastResult;
  return { success: false, content: `All ${maxAttempts} attempts threw: ${String(lastErr)}` };
}

/** Drain `pending` in topological waves, populating `results` in place. */
async function executePending(
  pending: Task[],
  agentMap: Record<string, BaseAgent>,
  results: TaskExecutionResult[],
  resultsById: Map<string, TaskExecutionResult>,
  fullContentsById: Map<string, string>,
  completed: Set<string>,
  resultTruncate: number,
  maxTaskRetries: number,
): Promise<void> {
  while (pending.length) {
    const ready = pending.filter((t) => t.allDeps.every((dep) => completed.has(dep)));
    if (!ready.length) {
      for (const t of pending) {
        const missing = t.allDeps.filter((d) => !completed.has(d));
        t.transitionTo(TaskState.FAILED);
        const r: TaskExecutionResult = {
          id: t.id,
          agent: t.assignedTo || '',
          description: t.description,
          success: false,
          content: `[dependency missing] task ${t.id} requires ${JSON.stringify(missing)} which never completed`,
        };
        results.push(r);
        resultsById.set(r.id, r);
        completed.add(r.id);
      }
      pending.length = 0;
      return;
    }

    for (const t of ready) t.transitionTo(TaskState.RUNNING);

    const executeOne = async (t: Task): Promise<TaskExecutionResult> => {
      const agent = agentMap[t.assignedTo!];
      if (!agent) {
        return {
          id: t.id,
          agent: t.assignedTo || '',
          description: t.description,
          success: false,
          content: `Agent '${t.assignedTo}' not found`,
        };
      }

      let description = t.description;
      const upstreamSections: string[] = [];
      for (const depId of t.allDeps) {
        const parent = resultsById.get(depId);
        if (parent) {
          const full = fullContentsById.get(depId) ?? parent.content ?? '';
          if (isThinContent(full)) {
            upstreamSections.push(
              `## 上游产出缺失 (task ${parent.id} · ${parent.agent})\n⚠ 上游任务声称完成但未产出实际内容。请勿基于占位回复继续——你应自己补齐上游内容，或明确报告无法基于空上游完成本任务。\n\n原始回复：\n${full}`,
            );
          } else {
            upstreamSections.push(`## 上游产出 (task ${parent.id} · ${parent.agent})\n${full}`);
          }
        }
      }
      if (upstreamSections.length)
        description = `${t.description}\n\n${upstreamSections.join('\n\n')}`;

      const aTask = new Task({
        id: t.id,
        description,
        assignedTo: t.assignedTo,
        parentId: t.parentId,
        metadata: t.metadata,
      });
      const result = await executeWithRetry(agent, aTask, maxTaskRetries);
      t.transitionTo(result.success ? TaskState.COMPLETED : TaskState.FAILED);

      const full = result.content || '';
      fullContentsById.set(t.id, full);
      const tr = full.length > resultTruncate ? full.slice(0, resultTruncate) : full;
      return {
        id: t.id,
        agent: t.assignedTo || '',
        description: t.description,
        success: result.success,
        content: tr,
      };
    };

    const batch = await Promise.all(ready.map(executeOne));
    for (const r of batch) {
      results.push(r);
      resultsById.set(r.id, r);
      completed.add(r.id);
    }
    for (const t of ready) pending.splice(pending.indexOf(t), 1);
  }
}

/** Ask snow whether the goal was met. Returns [achieved, missing]. Conservative on failure. */
async function judgeGoalAchievement(
  snow: BaseAgent,
  goal: string,
  results: TaskExecutionResult[],
): Promise<[boolean, string]> {
  const bullets = results
    .map((r) => {
      const status = r.success ? '成功' : '失败';
      const excerpt = (r.content || '').slice(0, 800);
      return `- [task ${r.id} · agent=${r.agent} · status=${status}] len=${(r.content || '').length}chars\n  ${excerpt}`;
    })
    .join('\n');

  const prompt =
    `你是一名极严格的项目验收员。验证 sub-task 真的产出了**可验证的交付物**，而不是仅声称完成。\n\n` +
    `## 验收规则（任一违反即 achieved=false）\n` +
    `1. 调研/搜集类：必须列出被调研对象名称 + 数据/特性/链接。\n` +
    `2. 撰写/生成类：必须包含实际文本/代码/markdown 正文。\n` +
    `3. 审查/对比类：必须列出具体问题点或对比维度。\n` +
    `4. 下游任务内容与原目标无关 ⇒ 未达成。\n\n` +
    `## 用户原目标\n${goal}\n\n## 子任务执行结果\n${bullets}\n\n` +
    `严格按下列 JSON 输出（除 JSON 外不要任何字符）：\n{"achieved": true/false, "missing": "若未达成，逐项列出缺什么"}`;

  let raw: string;
  try {
    raw = await (snow as any).chatOneshot(prompt);
  } catch (exc) {
    log.warning('judge_llm_failed', { error: String(exc) });
    return [true, ''];
  }

  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?/, '')
      .replace(/```$/, '')
      .trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [true, ''];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return [Boolean(parsed.achieved ?? true), String(parsed.missing ?? '').trim()];
  } catch {
    return [true, ''];
  }
}

/** Detect cycles in the dependency graph. */
function hasCycle(t: Task, tasks: Task[], path: Set<string>): boolean {
  if (path.has(t.id)) return true;
  path.add(t.id);
  for (const depId of t.allDeps) {
    const depTask = tasks.find((x) => x.id === depId);
    if (depTask && hasCycle(depTask, tasks, new Set(path))) return true;
  }
  return false;
}

/**
 * Full orchestration: plan (pipeline or snow) → execute DAG → judge → re-plan → summarize.
 * Returns [tasks, results, summary].
 */
export async function runOrchestration(
  goal: string,
  agentMap: Record<string, BaseAgent>,
  snow: BaseAgent,
  opts: {
    resultTruncate?: number;
    maxTaskRetries?: number;
    maxReplanRounds?: number;
    maxTotalTasks?: number;
  } = {},
): Promise<{ tasks: Task[]; results: TaskExecutionResult[]; summary: string }> {
  const resultTruncate = opts.resultTruncate ?? 500;
  const maxTaskRetries = opts.maxTaskRetries ?? 3;
  const maxReplanRounds = opts.maxReplanRounds ?? 1;
  const maxTotalTasks = opts.maxTotalTasks ?? 6;

  const matched = matchPipeline(goal);
  let tasks: Task[] = matched
    ? buildTasksFromPipeline(matched, goal)
    : await (snow as SnowAgent).orchestrate(goal);

  const completed = new Set<string>();
  const results: TaskExecutionResult[] = [];
  const resultsById = new Map<string, TaskExecutionResult>();
  const fullContentsById = new Map<string, string>();
  let replanRound = 0;

  const filterCycles = (cand: Task[]): Task[] => {
    const kept: Task[] = [];
    for (const t of cand) {
      if (hasCycle(t, tasks, new Set())) {
        const r: TaskExecutionResult = {
          id: t.id,
          agent: t.assignedTo || '',
          description: t.description,
          success: false,
          content: `[cycle detected] task ${t.id} has circular dependency`,
        };
        results.push(r);
        resultsById.set(r.id, r);
        completed.add(t.id);
      } else {
        kept.push(t);
      }
    }
    return kept;
  };

  let pending = filterCycles(tasks.filter((t) => t.assignedTo && t.assignedTo !== 'snow'));

  while (true) {
    await executePending(
      pending,
      agentMap,
      results,
      resultsById,
      fullContentsById,
      completed,
      resultTruncate,
      maxTaskRetries,
    );
    pending = [];

    if (!results.length || replanRound >= maxReplanRounds) break;
    if (results.length === 1 && results[0]!.success) break;
    if (looksObviouslyComplete(results)) break;

    const [achieved, missing] = await judgeGoalAchievement(snow, goal, results);
    if (achieved) break;

    replanRound += 1;
    let extraTasks: Task[];
    try {
      extraTasks = await (snow as SnowAgent).replanForMissing(
        goal,
        results,
        missing,
        new Set(tasks.map((t) => t.id)),
      );
    } catch (exc) {
      log.warning('replan_failed', { error: String(exc) });
      break;
    }
    if (!extraTasks.length) break;
    if (tasks.length + extraTasks.length > maxTotalTasks) {
      log.info('replan_capped', {
        current: tasks.length,
        extra: extraTasks.length,
        cap: maxTotalTasks,
      });
      break;
    }
    tasks = [...tasks, ...extraTasks];
    pending = filterCycles(extraTasks.filter((t) => t.assignedTo && t.assignedTo !== 'snow'));
  }

  // Summarize.
  let summary: string;
  if (!results.length) {
    summary = '没有需要执行的任务。';
  } else if (results.length === 1) {
    summary = results[0]!.content;
  } else {
    let summaryPrompt = '请汇总以下所有子任务的执行结果：\n\n';
    for (const r of results) {
      summaryPrompt += `### 任务 ${r.id} (${r.agent}) - ${r.success ? '成功' : '失败'}\n${r.content.slice(0, 300)}\n\n`;
    }
    summary = await (snow as any).chatOneshot(summaryPrompt);
  }

  return { tasks, results, summary };
}

/** Classify goal and dispatch: direct → no LLM, single → one agent, orchestrate → full engine. */
export async function orchestrateTask(
  ctx: SystemContext,
  goal: string,
): Promise<{ mode: Mode; result: string }> {
  const mode = classify(goal);

  // direct + single (without a pipeline match) both resolve to one agent.
  // For `direct` we still answer via the best-matched agent rather than
  // returning empty, so `wa task "你好"` produces a real reply.
  if ((mode === 'direct' || mode === 'single') && !matchPipeline(goal)) {
    const available = new Set(Object.keys(ctx.agentMap));
    const agentName = pickAgentForKey(goal, available);
    const agent = ctx.agentMap[agentName];
    if (!agent) return { mode, result: 'No agent available.' };
    await agent.init();
    const result = await agent.chat(goal);
    return { mode, result };
  }

  // orchestrate (or single goal that matched a pipeline): run the full engine.
  const snow = ctx.agentMap['snow'];
  if (!snow) return { mode: 'orchestrate', result: 'Snow agent not available.' };
  for (const agent of Object.values(ctx.agentMap)) await agent.init();
  const { summary } = await runOrchestration(goal, ctx.agentMap, snow);
  return { mode: 'orchestrate', result: summary };
}
