#!/usr/bin/env node
/** wa — Weather Agents CLI (TypeScript port). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { program } from 'commander';
import { createSystemContext, AGENT_CLASSES, orchestrateTask } from '../core/factory.js';
import { loadModelCatalog, formatModelsForDisplay, setConfig, loadConfig } from '../core/config.js';
program
    .name('wa')
    .description('Weather Agents — multi-agent AI orchestration framework')
    .version('1.0.1');
// ── wa chat [agent] <message...> ──────────────────────────────────────────
program
    .command('chat [agent] [message...]')
    .description('Chat with an agent (streaming)')
    .option('-m, --model <model>', 'Model override')
    .action(async (agentName, messageParts, opts) => {
    const ctx = createSystemContext();
    const name = (agentName || 'fog').toLowerCase();
    const message = (messageParts || []).join(' ').trim();
    const agent = ctx.agentMap[name];
    if (!agent) {
        console.error(`Unknown agent: ${name}. Use: ${Object.keys(AGENT_CLASSES).join(', ')}`);
        process.exit(1);
    }
    await agent.init();
    if (!message) {
        // Interactive REPL
        console.log(`${agent.emoji} ${agent.displayName} — ${agent.specialty}`);
        console.log('Type your message, /model to switch, /sessions to list, /quit to exit.\n');
        const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
        rl.prompt();
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) {
                rl.prompt();
                continue;
            }
            if (trimmed === '/quit' || trimmed === '/exit')
                break;
            if (trimmed === '/sessions') {
                const sessions = await agent.memory.listSessions();
                console.log(sessions
                    .map((s) => `  ${s.id.slice(0, 8)}… ${s.message_count}msgs ${s.preview || '(empty)'}`)
                    .join('\n') || '  No sessions.');
                rl.prompt();
                continue;
            }
            if (trimmed === '/models') {
                console.log(formatModelsForDisplay(loadModelCatalog()));
                rl.prompt();
                continue;
            }
            if (trimmed.startsWith('/model ')) {
                const model = trimmed.slice(7).trim();
                if (model) {
                    agent.config.llm.defaultModel = model;
                    console.log(`Model → ${model}`);
                }
                rl.prompt();
                continue;
            }
            await streamChat(agent, trimmed);
            rl.prompt();
        }
        rl.close();
    }
    else {
        if (opts?.model) {
            agent.config.llm.defaultModel = opts.model;
        }
        await streamChat(agent, message);
    }
    await agent.close();
});
// ── wa task <goal...> ────────────────────────────────────────────────────
program
    .command('task <goal...>')
    .description('Orchestrate a multi-agent task')
    .action(async (goalParts) => {
    const goal = goalParts.join(' ').trim();
    if (!goal) {
        console.error('Usage: wa task "<goal>"');
        process.exit(1);
    }
    const ctx = createSystemContext();
    console.log(`Orchestrating: ${goal}\n`);
    const { mode, result } = await orchestrateTask(ctx, goal);
    console.log(`[mode: ${mode}]\n${result}`);
});
// ── wa models ────────────────────────────────────────────────────────────
program
    .command('models')
    .description('List available models')
    .action(() => {
    console.log(formatModelsForDisplay(loadModelCatalog()));
});
// ── wa config [key] [value] ──────────────────────────────────────────────
program
    .command('config [key] [value]')
    .description('View or set configuration')
    .action(async (key, value) => {
    if (!key) {
        const cfg = loadConfig();
        console.log(`Default model:       ${cfg.llm.defaultModel}`);
        console.log(`Lightweight:         ${cfg.llm.lightweightModel || '(none)'}`);
        console.log(`Temperature:         ${cfg.llm.temperature}`);
        console.log(`Max tokens:          ${cfg.llm.maxTokens}`);
        console.log(`Timeout:             ${cfg.llm.timeout}s`);
        console.log(`Default agent:       ${cfg.cli.defaultAgent}`);
        console.log(`Language:            ${cfg.llm.language}`);
        console.log(`Memory DB:           ${cfg.memory.dbPath}`);
        console.log(`Config dir:          ${join(homedir(), '.weather-agents')}`);
        return;
    }
    if (value !== undefined && value !== null) {
        const [ok, msg] = setConfig(key, value);
        console.log(ok ? `✓ ${msg}` : `✗ ${msg}`);
    }
    else {
        const cfg = loadConfig();
        // Simple key lookup
        const parts = key.split('.');
        let obj = cfg;
        for (const p of parts) {
            if (obj && typeof obj === 'object')
                obj = obj[p];
            else
                break;
        }
        console.log(`${key}: ${JSON.stringify(obj)}`);
    }
});
// ── wa sessions [agent] ──────────────────────────────────────────────────
program
    .command('sessions [agent]')
    .description('List sessions for an agent')
    .action(async (agentName) => {
    const name = (agentName || 'fog').toLowerCase();
    const ctx = createSystemContext();
    const agent = ctx.agentMap[name];
    if (!agent) {
        console.error(`Unknown agent: ${name}`);
        process.exit(1);
    }
    await agent.init();
    const sessions = await agent.memory.listSessions();
    if (!sessions.length) {
        console.log(`No sessions for ${name}.`);
    }
    else {
        for (const s of sessions) {
            console.log(`  ${s.id.padEnd(14)} ${String(s.message_count).padStart(4)} msgs  ${s.preview?.slice(0, 60) || '(empty)'}  ${s.updated_at}`);
        }
    }
    await agent.close();
});
// ── wa voice ──────────────────────────────────────────────────────────────
program
    .command('voice [agent]')
    .description('Start voice WebSocket server')
    .option('-p, --port <port>', 'Port', '8765')
    .option('-H, --host <host>', 'Host', '0.0.0.0')
    .action(async (agentName, opts) => {
    const name = (agentName || 'fair').toLowerCase();
    const ctx = createSystemContext();
    const { runVoiceServer } = await import('../web/server.js');
    await runVoiceServer(ctx, {
        agentName: name,
        port: Number(opts?.port) || 8765,
        host: opts?.host || '0.0.0.0',
    });
});
// ── Streaming helpers ────────────────────────────────────────────────────
async function streamChat(agent, message) {
    for await (const ev of agent.chatStream(message)) {
        if (ev.type === 'content') {
            process.stdout.write(ev.text);
        }
        else if (ev.type === 'tool_status') {
            process.stdout.write(`\n  ${ev.label}...`);
        }
        else if (ev.type === 'tool_done') {
            const icon = ev.success ? '✓' : '✗';
            process.stdout.write(` ${icon}`);
        }
        else if (ev.type === 'done') {
            process.stdout.write('\n');
        }
        else if (ev.type === 'reasoning') {
            // reasoning content is hidden by default; show dimly if VERBOSE=1
            if (process.env.WA_VERBOSE === '1')
                process.stdout.write(`\x1b[2m${ev.text}\x1b[0m`);
        }
        else if (ev.type === 'truncated') {
            process.stdout.write(`\n  ⚠ ${ev.reason}\n`);
        }
    }
}
program.parse();
//# sourceMappingURL=main.js.map