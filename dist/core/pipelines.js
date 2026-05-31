/** Pipeline templates — predefined multi-agent DAGs. Rule-only match (<1µs). */
import { Task } from './agent.js';
const PIPELINES = [
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
                descriptionTemplate: '基于第 1 步的调研结果撰写: {goal}',
                dependsOn: ['1'],
            },
        ],
        requireRegex: [],
    },
    {
        name: 'research_review_write',
        triggers: ['调研审查后写', 'research review write', '先调研审查再写', '调研并审查后生成'],
        steps: [
            { id: '1', agent: 'fog', descriptionTemplate: '调研: {goal}', dependsOn: [] },
            {
                id: '2',
                agent: 'frost',
                descriptionTemplate: '审查第 1 步的调研结果,确认可行性',
                dependsOn: ['1'],
            },
            {
                id: '3',
                agent: 'rain',
                descriptionTemplate: '基于第 1 步调研和第 2 步审查意见撰写: {goal}',
                dependsOn: ['2'],
            },
        ],
        requireRegex: [],
    },
    {
        name: 'implement_and_review',
        triggers: ['实现并审查', '写完后审查', 'implement and review', '写代码并 review', '实现并审计'],
        steps: [
            { id: '1', agent: 'rain', descriptionTemplate: '实现: {goal}', dependsOn: [] },
            {
                id: '2',
                agent: 'frost',
                descriptionTemplate: '审查第 1 步的实现',
                dependsOn: ['1'],
            },
        ],
        requireRegex: [],
    },
    {
        name: 'fix_and_verify',
        triggers: ['修复并验证', 'fix and verify', '修复bug并验证', '修复后审查', 'bugfix review'],
        steps: [
            { id: '1', agent: 'rain', descriptionTemplate: '修复: {goal}', dependsOn: [] },
            {
                id: '2',
                agent: 'frost',
                descriptionTemplate: '验证第 1 步的修复是否正确',
                dependsOn: ['1'],
            },
        ],
        requireRegex: [],
    },
    {
        name: 'implement_test_deploy',
        triggers: ['实现测试部署', '实现并部署', '写完测试再部署', 'implement test deploy'],
        steps: [
            { id: '1', agent: 'rain', descriptionTemplate: '实现: {goal}', dependsOn: [] },
            {
                id: '2',
                agent: 'frost',
                descriptionTemplate: '审查第 1 步的实现',
                dependsOn: ['1'],
            },
            {
                id: '3',
                agent: 'dew',
                descriptionTemplate: '部署第 1 步的实现',
                dependsOn: ['2'],
            },
        ],
        requireRegex: [],
    },
    {
        name: 'design_implement_review_deploy',
        triggers: [
            '设计实现审查部署',
            '设计开发测试上线',
            'design implement review deploy',
            '完整开发流程',
        ],
        steps: [
            { id: '1', agent: 'fog', descriptionTemplate: '设计方案: {goal}', dependsOn: [] },
            {
                id: '2',
                agent: 'rain',
                descriptionTemplate: '根据第 1 步的设计实现: {goal}',
                dependsOn: ['1'],
            },
            {
                id: '3',
                agent: 'frost',
                descriptionTemplate: '审查第 2 步的实现代码',
                dependsOn: ['2'],
            },
            {
                id: '4',
                agent: 'dew',
                descriptionTemplate: '部署第 2 步的实现到生产环境',
                dependsOn: ['3'],
            },
        ],
        requireRegex: [],
    },
    // fair 是独立陪伴 agent,不参与任务编排,故无 research_then_fair pipeline。
    {
        name: 'investigate_report',
        triggers: ['安全审计', 'security audit', '漏洞扫描', 'vulnerability scan', '安全检测'],
        steps: [
            { id: '1', agent: 'fog', descriptionTemplate: '安全调研: {goal}', dependsOn: [] },
            {
                id: '2',
                agent: 'frost',
                descriptionTemplate: '基于第 1 步的调研生成安全报告',
                dependsOn: ['1'],
            },
        ],
        requireRegex: [],
    },
    {
        name: 'debug_and_deploy',
        triggers: ['调试部署', 'debug and deploy', '修复并上线', 'hotfix deploy'],
        steps: [
            { id: '1', agent: 'rain', descriptionTemplate: '调试修复: {goal}', dependsOn: [] },
            {
                id: '2',
                agent: 'dew',
                descriptionTemplate: '部署第 1 步的修复',
                dependsOn: ['1'],
            },
        ],
        requireRegex: [],
    },
];
// Compiled regex cache keyed by pipeline identity.
const REGEX_CACHE = new Map();
function compiledRegex(p) {
    let c = REGEX_CACHE.get(p);
    if (!c) {
        c = p.requireRegex.map((rx) => new RegExp(rx, 'i'));
        REGEX_CACHE.set(p, c);
    }
    return c;
}
/** Return the first matching pipeline, or null. Case-insensitive substring + regex. */
export function matchPipeline(goal) {
    if (!goal)
        return null;
    const lower = goal.toLowerCase();
    for (const p of PIPELINES) {
        if (!p.triggers.some((t) => lower.includes(t.toLowerCase())))
            continue;
        if (p.requireRegex.length && !compiledRegex(p).some((rx) => rx.test(lower)))
            continue;
        return p;
    }
    return null;
}
/** Materialize a pipeline into runtime Task objects (full DAG). */
export function buildTasksFromPipeline(pipeline, goal) {
    const tasks = [];
    for (const step of pipeline.steps) {
        const parentId = step.dependsOn[0] ?? null;
        tasks.push(new Task({
            id: step.id,
            description: step.descriptionTemplate.replace(/\{goal\}/g, goal),
            assignedTo: step.agent,
            parentId,
            dependsOn: [...step.dependsOn],
            metadata: { goal, pipeline: pipeline.name },
        }));
    }
    return tasks;
}
/** For CLI / debug introspection. */
export function listPipelines() {
    return PIPELINES.map((p) => ({
        name: p.name,
        triggers: [...p.triggers],
        steps: p.steps.map((s) => ({ id: s.id, agent: s.agent, dependsOn: [...s.dependsOn] })),
    }));
}
