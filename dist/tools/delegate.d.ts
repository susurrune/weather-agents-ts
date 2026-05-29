/** delegate_to — allows an agent to hand off work to a specialist agent. */
import { type BaseAgent } from '../core/agent.js';
import { Tool } from '../core/tool.js';
/** Build a `delegate_to` Tool whose handler closes over `agentMap`. */
export declare function createDelegateTool(agentMap: Record<string, BaseAgent>, callingAgent?: BaseAgent | null): Tool;
