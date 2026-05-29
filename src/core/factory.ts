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
import { createDelegateTool } from '../tools/delegate.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import { registerAllSkills } from '../skills/loader.js';

import { FogAgent } from '../agents/fog.js';
import { RainAgent } from '../agents/rain.js';
import { FrostAgent } from '../agents/frost.js';
import { SnowAgent } from '../agents/snow.js';
import { DewAgent } from '../agents/dew.js';
import { FairAgent } from '../agents/fair.js';

const _log = getLogger('factory');

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

/** Classify goal and dispatch: direct → no LLM, single → one agent, orchestrate → pipeline or snow. */
export async function orchestrateTask(
  ctx: SystemContext,
  goal: string,
): Promise<{ mode: Mode; result: string }> {
  const mode = classify(goal);
  if (mode === 'direct') {
    return { mode, result: '' }; // caller handles greetings/questions directly
  }

  // Try pipeline match first — rules-only, <1µs, saves snow's LLM call.
  const pipeline = matchPipeline(goal);
  if (pipeline) {
    const tasks = buildTasksFromPipeline(pipeline, goal);
    const results: string[] = [];
    for (const task of tasks) {
      const agent = ctx.agentMap[task.assignedTo!];
      if (!agent) continue;
      await agent.init();
      const r = await agent.executeTask(task);
      results.push(`[${agent.displayName}] ${r.content.slice(0, 500)}`);
    }
    return { mode: 'orchestrate', result: results.join('\n\n') };
  }

  if (mode === 'single') {
    const available = new Set(Object.keys(ctx.agentMap));
    const agentName = pickAgentForKey(goal, available);
    const agent = ctx.agentMap[agentName];
    if (!agent) return { mode, result: 'No agent available.' };
    await agent.init();
    const result = await agent.chat(goal);
    return { mode, result };
  }

  // orchestrate: delegate to snow
  const snow = ctx.agentMap['snow'];
  if (!snow) return { mode, result: 'Snow agent not available.' };
  await snow.init();
  const result = await snow.chat(goal);
  return { mode, result };
}
