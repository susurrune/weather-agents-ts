/** Skill file discovery and registration. */
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Skill } from '../core/skill.js';
import { CONFIG_DIR } from '../core/config.js';
/** Register all skills from the bundled config/skills/ directory + user dir. */
export function registerAllSkills(reg) {
    const dirs = [];
    const bundled = join(CONFIG_DIR, 'skills');
    if (existsSync(bundled))
        dirs.push(bundled);
    const userDir = join(homedir(), '.weather-agents', 'skills');
    if (existsSync(userDir))
        dirs.push(userDir);
    for (const d of dirs) {
        try {
            for (const entry of readdirSync(d, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_'))
                    continue;
                const md = join(d, entry.name, 'SKILL.md');
                if (existsSync(md)) {
                    const skill = Skill.fromMarkdown(md);
                    if (skill) {
                        skill.resourceDir = join(d, entry.name);
                        reg.register(skill);
                    }
                }
            }
        }
        catch {
            /* skip unreadable */
        }
    }
}
