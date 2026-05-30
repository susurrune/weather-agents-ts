/** delegate_to — allows an agent to hand off work to a specialist agent. */
import { Task } from '../core/agent.js';
import { iconText } from '../core/icons.js';
import { getLogger } from '../core/logger.js';
import { Tool } from '../core/tool.js';
import { AgentState } from '../core/agent.js';
const log = getLogger('delegate');
const AGENT_SPECIALTIES = {
    fog: 'research / code analysis / knowledge retrieval / information synthesis',
    rain: 'code generation / content creation / data transformation / multi-file projects',
    frost: 'code review / security audit / performance analysis / debugging',
    snow: 'task planning / architecture design / workflow management / codebase refactoring',
    dew: 'command execution / deployment / API integration / system operations',
};
const MAX_RESULT_CHARS = 4000;
const MAX_DEPTH = 2;
// depth tracker — AsyncLocalStorage mirrors Python's ContextVar (per-chain, not per-caller)
import { AsyncLocalStorage } from 'node:async_hooks';
const delegationDepth = new AsyncLocalStorage();
function buildSharedContext(callingAgent, context) {
    const parts = [];
    if (context)
        parts.push(`Additional context: ${context}`);
    if (callingAgent) {
        const recent = callingAgent.memory.shortTerm;
        const nonSystem = recent.filter((m) => m.role !== 'system');
        if (nonSystem.length) {
            const ctxMsgs = nonSystem.slice(-4);
            const msgText = ctxMsgs
                .map((m) => `[${m.role}] ${(m.content || '').slice(0, 500)}`)
                .join('\n');
            if (msgText)
                parts.push(`Calling agent context:\n${msgText}`);
        }
        const active = callingAgent.getActiveSkills();
        if (active.length) {
            parts.push('Parent agent had these skills active when delegating: ' +
                active.join(', ') +
                '. If you need the same context, call use_skill(name); otherwise proceed with your own specialty.');
        }
    }
    return parts.join('\n\n');
}
/** Build a `delegate_to` Tool whose handler closes over `agentMap`. */
export function createDelegateTool(agentMap, callingAgent = null) {
    const handle = async (args) => {
        const { agent, task, context = '' } = args;
        if (callingAgent && callingAgent.name === 'fair') {
            return 'Fair (晴) is an independent companion agent and does not delegate work. Continue the conversation directly with the user.';
        }
        if (agent === 'fair') {
            return "Fair (晴) cannot be delegated to — she is the user's personal companion, not a work agent. Complete this task yourself, or delegate to fog / rain / frost / snow / dew.";
        }
        const target = agentMap[agent];
        if (!target) {
            const names = Object.keys(agentMap)
                .filter((k) => k !== 'fair')
                .join(', ');
            return `Unknown agent '${agent}'. Available agents: ${names}`;
        }
        if (callingAgent && agent === callingAgent.name) {
            return `You are already ${callingAgent.displayName}. Complete the task directly using your own tools and knowledge — do not delegate to yourself.`;
        }
        const store = delegationDepth.getStore() ?? 0;
        if (store >= MAX_DEPTH) {
            return `Nested delegation depth limit (${MAX_DEPTH}) reached. Agent '${agent}' must complete the task directly using its own tools.`;
        }
        return delegationDepth.run(store + 1, async () => {
            try {
                await target.init();
                const sharedCtx = buildSharedContext(callingAgent, context);
                const taskObj = new Task({
                    id: `dlg-${nextId()}`,
                    description: task,
                    assignedTo: agent,
                    metadata: sharedCtx ? { context: sharedCtx } : {},
                });
                log.info('delegation_start', {
                    target: agent,
                    task: task.slice(0, 120),
                    depth: store + 1,
                });
                const result = await target.executeTask(taskObj);
                if (target.state === AgentState.ERROR) {
                    await target.setState(AgentState.IDLE);
                }
                let content = result.content;
                if (content.length > MAX_RESULT_CHARS)
                    content = content.slice(0, MAX_RESULT_CHARS) + '\n\n… (truncated)';
                const status = result.success ? 'completed' : 'failed';
                const header = `[${iconText(target.name)} ${target.displayName}] ${status}`;
                log.info('delegation_done', {
                    target: agent,
                    success: result.success,
                    chars: result.content.length,
                });
                const trustClause = result.success
                    ? `[Hint: ${target.displayName}'s work above is COMPLETE and authoritative for the sub-task you delegated. Do NOT re-verify, re-audit, re-implement, or repeat the same operation in your own voice — that doubles the cost for the same answer. Synthesize a brief reply in your OWN voice citing their conclusion, and only do MORE work if it's distinctly different from what they completed.]`
                    : `[Hint: ${target.displayName}'s attempt failed. Decide whether to retry with a different approach, ask the user for guidance, or skip this sub-task. Don't just call delegate_to again with the same task.]`;
                return `<delegated_response from='${target.displayName}'>\n${header}\n\n${content}\n</delegated_response>\n${trustClause}`;
            }
            catch (exc) {
                log.exception('delegation_error', exc);
                return `Delegation to '${agent}' failed: ${exc instanceof Error ? exc.message : String(exc)}`;
            }
        });
    };
    return new Tool({
        name: 'delegate_to',
        description: "Delegate a task to a specialist agent and receive the result. Use this when a task would benefit from another agent's expertise. Available agents and their specialties:\n" +
            Object.entries(AGENT_SPECIALTIES)
                .map(([k, v]) => `  - ${k}: ${v}`)
                .join('\n'),
        parameters: [
            {
                name: 'agent',
                type: 'string',
                description: 'Target agent name. One of: fog, rain, frost, snow, dew.',
                required: true,
            },
            {
                name: 'task',
                type: 'string',
                description: 'Clear, specific description of what the agent should do.',
                required: true,
            },
            {
                name: 'context',
                type: 'string',
                description: 'Additional context or data the target agent needs.',
                required: false,
                default: '',
            },
        ],
        handler: handle,
        cacheable: false,
    });
}
let _idCounter = 0;
function nextId() {
    _idCounter = (_idCounter + 1) & 0xffff;
    return _idCounter.toString(16).padStart(4, '0');
}
