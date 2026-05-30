/** Factory: create the system context (agents + bus + tools) and orchestrate tasks. */
import { MessageBus } from './bus.js';
import { type AppConfig } from './config.js';
import { LLMClient } from './llm.js';
import { ToolRegistry } from './tool.js';
import { type BaseAgent } from './agent.js';
import { type Mode } from './router.js';
import { Task } from './agent.js';
import { FogAgent } from '../agents/fog.js';
declare const AGENT_CLASSES: Record<string, typeof FogAgent>;
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
export declare function createSystemContext(): SystemContext;
export interface TaskExecutionResult {
    id: string;
    agent: string;
    description: string;
    success: boolean;
    content: string;
}
/** True if `content` is too thin to count as a real deliverable. */
export declare function isThinContent(content: string): boolean;
/**
 * Full orchestration: plan (pipeline or snow) → execute DAG → judge → re-plan → summarize.
 * Returns [tasks, results, summary].
 */
export declare function runOrchestration(goal: string, agentMap: Record<string, BaseAgent>, snow: BaseAgent, opts?: {
    resultTruncate?: number;
    maxTaskRetries?: number;
    maxReplanRounds?: number;
    maxTotalTasks?: number;
}): Promise<{
    tasks: Task[];
    results: TaskExecutionResult[];
    summary: string;
}>;
/** Classify goal and dispatch: direct → no LLM, single → one agent, orchestrate → full engine. */
export declare function orchestrateTask(ctx: SystemContext, goal: string): Promise<{
    mode: Mode;
    result: string;
}>;
