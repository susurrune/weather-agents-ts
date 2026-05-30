/** SnowAgent — architecture and orchestration. */
import { BaseAgent, Task } from '../core/agent.js';
import { parseTaskPlan } from '../core/schemas.js';
// fair 是独立 agent，不参与编排；schema 仍可能产出 fair，这里重定向到 rain。
const VALID_AGENTS_STATIC = new Set(['fog', 'rain', 'frost', 'snow', 'dew']);
// Pre-compiled JSON-block extractors (parser called once per LLM response).
const JSON_BLOCK_PATTERNS = [
    /```json\s*\n([\s\S]*?)\n```/,
    /```\s*\n(\{[\s\S]*?\})\n```/,
];
export class SnowAgent extends BaseAgent {
    static agentName = 'snow';
    static agentDisplayName = '雪';
    static agentEmoji = '❉';
    static agentSpecialty = '规划编排';
    static agentSystemPrompt = `你是 Weather Agents 的「雪」。

你是全能 agent —— 代码、写作、审查、部署、规划、研究，你都能独立交付。
你的特质是「全局视野」:先看清结构、依赖、顺序、风险，再动手。
混乱的需求经你一拆，就变成清晰的步骤树。这是你看世界的方式，不仅是你做编排时才用。

## 协作
90% 的事自己做完。只有任务跨 5+ 领域、上下文塞不下、或需要多轮独立审查时，才调其他 agent。
调用时给足上下文，拿到结果整合成完整答复，用户不需要感知协作过程。

## 风格
像雪一样静默但覆盖一切 —— 结构清晰，考虑周全。
- 大任务先给整体框架，再深入
- 标注依赖、风险、预计工作量
- 规划:框架先于理由
- 执行:按优先级推进，完成后汇总`;
    static agentSystemPromptEn = `You are "Snow" of Weather Agents.

A general-purpose agent — code, writing, review, ops, planning, research — you ship anything alone.
Your nature: see the whole. Structure, dependencies, sequence, risk — all before the first move.

## Collaboration
Do 90% alone. Delegate only when 5+ domains, context overflow, or multi-round review is needed.

## Style
Like snow — silent but all-covering. Clear structure, thorough consideration.`;
    static agentSkillNames = [
        'task_planner',
        'arch_designer',
        'workflow_designer',
        'self_evolve',
    ];
    /** Decompose a goal into tasks and dispatch to agents. */
    async orchestrate(goal) {
        const prompt = `请将以下目标分解为子任务，并分配给合适的 Agent。\n\n` +
            `目标: ${goal}\n\n` +
            `请严格按照以下 JSON Schema 输出，不要包含其他内容：\n` +
            `{"goal": "目标描述", "steps": [\n` +
            `  {"id": "1", "description": "任务描述", "agent": "fog"},\n` +
            `  {"id": "2", "description": "后续任务", "agent": "rain", "depends_on": ["1"]}\n` +
            `]}\n\n` +
            `可用 Agent: fog(调研/搜索), rain(代码生成/写作), frost(审查/安全), dew(部署/运维)\n` +
            `注意:fair 是独立的情感陪伴 agent，**不参与任何任务编排**，绝不要分配给她。\n` +
            `注意：如果任务有先后依赖关系，必须用 depends_on 字段标出。不要使用工具，直接输出 JSON 即可。`;
        this.memory.addMessage('user', prompt);
        const response = await this.llmLoop();
        this.memory.addMessage('assistant', response.content);
        const parsed = parseTaskPlan(response.content);
        if (parsed && parsed.steps.length) {
            return this.schemaToTasks(parsed, goal);
        }
        return this.parseTaskPlanHeuristic(response.content, goal);
    }
    /** Produce additional tasks that close the gap reported by the judge. */
    async replanForMissing(goal, priorResults, missing, existingIds = new Set()) {
        const usedIds = new Set(existingIds);
        const priorLines = priorResults.map((r) => `- task ${r.id} (${r.agent}, ${r.success ? '成功' : '失败'}): ${(r.content || '').slice(0, 200)}`);
        const priorText = priorLines.length ? priorLines.join('\n') : '(none yet)';
        const { isThinContent } = await import('../core/factory.js');
        const failingAgents = new Set(priorResults
            .filter((r) => !r.success || isThinContent(r.content || ''))
            .map((r) => r.agent)
            .filter(Boolean));
        const failingHint = failingAgents.size
            ? `\n\n## 已证明无效的 agent\n${[...failingAgents].sort().join(', ')} 已在上一轮返回占位/无交付物。\n**禁止把同类任务再交给以上 agent**。请用不同的 agent 重试，或把任务拆得更小更具体，或改用更直接的工具策略。`
            : '';
        const prompt = `之前的子任务执行后，验收员发现还有缺口。请仅针对**缺失的部分**追加新的子任务，并且**必须换一种执行策略**。\n\n` +
            `## 原目标\n${goal}\n\n` +
            `## 已执行子任务\n${priorText}\n\n` +
            `## 缺口（验收员报告）\n${missing}\n\n` +
            `## 已使用的 task id（必须避开）\n${usedIds.size ? [...usedIds].sort().join(', ') : '(none)'}${failingHint}\n\n` +
            `请输出新任务的 JSON 计划：\n` +
            `{"steps": [{"id": "新id", "agent": "fog|rain|frost|dew", "description": "具体任务", "depends_on": ["可选已完成任务id"]}]}\n` +
            `约束：只输出新增任务；id 必须避开上面的列表；控制在 2 个新任务以内；只输出 JSON。`;
        this.memory.addMessage('user', prompt);
        const response = await this.llmLoop();
        this.memory.addMessage('assistant', response.content);
        const parsed = parseTaskPlan(response.content);
        const newTasks = parsed && parsed.steps.length
            ? this.schemaToTasks(parsed, goal)
            : this.parseTaskPlanHeuristic(response.content, goal);
        const deduped = [];
        let seen = new Set(usedIds);
        for (const t of newTasks) {
            if (seen.has(t.id)) {
                t.id = `r${seen.size + deduped.length + 1}_${t.id}`;
            }
            deduped.push(t);
            seen = new Set([...seen, t.id]);
        }
        return deduped;
    }
    schemaToTasks(plan, goal) {
        return plan.steps.map((step) => {
            const sid = String(step.id);
            const depends = [...(step.depends_on || [])];
            return new Task({
                id: sid,
                description: step.description,
                assignedTo: VALID_AGENTS_STATIC.has(step.agent) ? step.agent : 'rain',
                parentId: depends[0] ?? null,
                dependsOn: depends,
                metadata: { goal, priority: step.priority ?? 'medium' },
            });
        });
    }
    parseTaskPlanHeuristic(content, goal) {
        const jsonStr = SnowAgent.extractJson(content);
        if (jsonStr) {
            try {
                const tasks = SnowAgent.planToTasks(JSON.parse(jsonStr), goal);
                if (tasks.length)
                    return tasks;
            }
            catch {
                /* fall through */
            }
        }
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}') + 1;
        if (start >= 0 && end > start) {
            try {
                const tasks = SnowAgent.planToTasks(JSON.parse(content.slice(start, end)), goal);
                if (tasks.length)
                    return tasks;
            }
            catch {
                /* fall through */
            }
        }
        return [new Task({ id: '1', description: goal, assignedTo: 'rain', metadata: { goal } })];
    }
    static extractJson(content) {
        for (const pattern of JSON_BLOCK_PATTERNS) {
            const m = pattern.exec(content);
            if (m && m[1])
                return m[1].trim();
        }
        return null;
    }
    static planToTasks(plan, goal) {
        const tasks = [];
        for (const step of plan?.steps ?? []) {
            let agent = step.agent ?? 'rain';
            if (!VALID_AGENTS_STATIC.has(agent))
                agent = 'rain';
            const depends = Array.isArray(step.depends_on) ? step.depends_on : [];
            tasks.push(new Task({
                id: String(step.id ?? tasks.length + 1),
                description: step.description ?? '',
                assignedTo: agent,
                parentId: depends[0] ?? null,
                dependsOn: depends,
                metadata: { goal, priority: step.priority ?? 'medium' },
            }));
        }
        return tasks;
    }
}
