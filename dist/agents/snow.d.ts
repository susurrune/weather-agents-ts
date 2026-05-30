/** SnowAgent — architecture and orchestration. */
import { BaseAgent, Task } from '../core/agent.js';
export declare class SnowAgent extends BaseAgent {
    static agentName: string;
    static agentDisplayName: string;
    static agentEmoji: string;
    static agentSpecialty: string;
    static agentSystemPrompt: string;
    static agentSystemPromptEn: string;
    static agentSkillNames: string[];
    /** Decompose a goal into tasks and dispatch to agents. */
    orchestrate(goal: string): Promise<Task[]>;
    /** Produce additional tasks that close the gap reported by the judge. */
    replanForMissing(goal: string, priorResults: Array<{
        id: string;
        agent: string;
        success: boolean;
        content: string;
    }>, missing: string, existingIds?: Set<string>): Promise<Task[]>;
    private schemaToTasks;
    private parseTaskPlanHeuristic;
    private static extractJson;
    private static planToTasks;
}
