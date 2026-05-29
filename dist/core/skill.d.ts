/**
 * Skill system — Anthropic-compatible composable capability modules.
 *
 * Skills use Markdown + YAML frontmatter format, matching the Claude Code
 * skill specification. When activated, a skill injects its system prompt
 * and can register custom handler tools into the agent.
 */
/** A handler that registers custom tools when the skill is activated. */
export type SkillHandler = (agent: unknown, toolRegistry: unknown) => void;
export interface SkillInit {
    name: string;
    description: string;
    systemPrompt?: string;
    requiredTools?: string[];
    tools?: unknown[];
    handler?: SkillHandler | null;
    model?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
    triggers?: string[];
    resourceDir?: string | null;
    license?: string | null;
    allowedTools?: string[] | null;
    sourcePath?: string | null;
    bodyTruncated?: boolean;
    metadata?: Record<string, unknown>;
}
/** A composable capability module for an agent (Anthropic/Claude Code format). */
export declare class Skill {
    name: string;
    description: string;
    systemPrompt: string;
    requiredTools: string[];
    tools: unknown[];
    handler: SkillHandler | null;
    model: string | null;
    temperature: number | null;
    maxTokens: number | null;
    triggers: string[];
    resourceDir: string | null;
    license: string | null;
    allowedTools: string[] | null;
    sourcePath: string | null;
    bodyTruncated: boolean;
    metadata: Record<string, unknown>;
    constructor(init: SkillInit);
    /** Load a skill from a Markdown file with YAML frontmatter. */
    static fromMarkdown(path: string): Skill | null;
}
/** Central registry for all available skills. */
export declare class SkillRegistry {
    private readonly skills;
    register(skill: Skill): void;
    get(name: string): Skill | null;
    getSkills(names?: string[] | null): Skill[];
    listNames(): string[];
    merge(other: SkillRegistry): void;
    /**
     * Load all .md skill files from a directory (Anthropic format).
     * Skips files starting with _ or . (private/disabled skills).
     */
    loadSkillsFromDirectory(directory: string): Skill[];
}
export declare const globalSkillRegistry: SkillRegistry;
