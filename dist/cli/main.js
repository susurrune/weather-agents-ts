#!/usr/bin/env node
/** wa — Weather Agents CLI (TypeScript port). */
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { program } from 'commander';
import { createSystemContext, AGENT_CLASSES, orchestrateTask } from '../core/factory.js';
import { loadModelCatalog, formatModelsForDisplay, setConfig, deleteConfig, loadConfig, USER_CONFIG_DIR, getProviderEnvVar, } from '../core/config.js';
const VERSION = '1.0.1';
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
        await interactiveRepl(agent);
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
// ── wa config [action] [key] [value] ─────────────────────────────────────
program
    .command('config [action] [key] [value]')
    .description('Manage configuration (list / set / delete / models)')
    .action(async (action, key, value) => {
    const act = action || 'list';
    if (act === 'list') {
        const cfg = loadConfig();
        console.log('\n  Configuration');
        console.log(`    default model   ${cfg.llm.defaultModel}`);
        console.log(`    lightweight     ${cfg.llm.lightweightModel || '(none)'}`);
        console.log(`    temperature     ${cfg.llm.temperature}`);
        console.log(`    max tokens      ${cfg.llm.maxTokens}`);
        console.log(`    timeout         ${cfg.llm.timeout}s`);
        console.log(`    default agent   ${cfg.cli.defaultAgent}`);
        console.log(`    language        ${cfg.llm.language}`);
        console.log('\n  Per-agent Models');
        for (const name of Object.keys(AGENT_CLASSES)) {
            const m = cfg.agents[name]?.model || '';
            console.log(`    ${name.padEnd(8)} ${m || '(default)'}`);
        }
        const keys = cfg.llm.apiKeys ?? {};
        if (Object.keys(keys).length) {
            console.log('\n  API Keys');
            for (const [p, v] of Object.entries(keys)) {
                const s = String(v);
                const masked = s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-4)}` : `${s.slice(0, 4)}…`;
                console.log(`    ● ${p.padEnd(14)} ${masked}`);
            }
        }
        console.log(`\n  ${join(USER_CONFIG_DIR, 'config.yaml')}\n`);
    }
    else if (act === 'set') {
        if (!key || value === undefined) {
            console.error('  usage: wa config set <key> <value>');
            process.exit(1);
        }
        const [ok, msg] = setConfig(key, value);
        console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`);
        if (!ok)
            process.exit(1);
    }
    else if (act === 'delete') {
        if (!key) {
            console.error('  usage: wa config delete <key>');
            process.exit(1);
        }
        const [ok, msg] = deleteConfig(key);
        console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`);
        if (!ok)
            process.exit(1);
    }
    else if (act === 'models') {
        const catalog = loadModelCatalog();
        if (!Object.keys(catalog).length) {
            console.log('  no models.yaml found');
            return;
        }
        console.log(formatModelsForDisplay(catalog));
    }
    else {
        console.error(`  unknown action: ${act} (list / set / delete / models)`);
        process.exit(1);
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
const voiceCmd = program.command('voice').description('Voice chat server and TTS voice management');
voiceCmd
    .argument('[agent]', 'Agent to use for voice chat', 'fair')
    .option('-p, --port <port>', 'Listen port', '8765')
    .option('-H, --host <host>', 'Bind host (0.0.0.0 for remote access)', '0.0.0.0')
    .option('-c, --cert-file <path>', 'TLS certificate (auto-generated if omitted for remote)')
    .option('-k, --key-file <path>', 'TLS private key (required with --cert-file)')
    .action(async (agentName, opts) => {
    const name = (agentName || 'fair').toLowerCase();
    if (!(name in AGENT_CLASSES)) {
        console.error(`unknown agent '${name}'; available: ${Object.keys(AGENT_CLASSES).join(', ')}`);
        process.exit(1);
    }
    if (Boolean(opts.certFile) !== Boolean(opts.keyFile)) {
        console.error('--cert-file and --key-file must be used together');
        process.exit(1);
    }
    const host = opts.host || '0.0.0.0';
    const ctx = createSystemContext();
    const { runVoiceServer } = await import('../web/server.js');
    // Remote (non-loopback) access needs HTTPS for mic permission. Auto-generate
    // a self-signed cert when binding broadly and none was supplied.
    let certFile = opts.certFile ?? null;
    let keyFile = opts.keyFile ?? null;
    if (!certFile && host !== '127.0.0.1' && host !== 'localhost') {
        const { ensureSelfSignedCert, detectAllLanIps } = await import('../web/certs.js');
        [certFile, keyFile] = ensureSelfSignedCert(detectAllLanIps());
    }
    await runVoiceServer(ctx, {
        agentName: name,
        port: Number(opts.port) || 8765,
        host,
        certFile,
        keyFile,
    });
});
voiceCmd
    .command('list')
    .description('List available TTS voices')
    .action(async () => {
    const { VOICE_CATALOG } = await import('../web/tts.js');
    const cfg = loadConfig();
    if (!VOICE_CATALOG.length) {
        console.log('暂无可用音色');
        return;
    }
    console.log('\n  可用音色:\n');
    for (const v of VOICE_CATALOG) {
        console.log(`  ${v.name.padEnd(8)}  ${v.key.padEnd(20)}  ${v.desc}`);
    }
    console.log(`\n  当前音色: ${cfg.tts.voiceType}`);
    console.log('  使用 wa voice select <名称> 切换音色\n');
});
voiceCmd
    .command('select <name>')
    .description("Select a TTS voice by name (see 'wa voice list')")
    .action(async (name) => {
    const { getVoiceByKey } = await import('../web/tts.js');
    const { saveUserCfg } = await import('../core/config.js');
    const entry = getVoiceByKey(name);
    if (!entry) {
        console.error(`未知音色: ${name}. 使用 wa voice list 查看可用音色`);
        process.exit(1);
    }
    saveUserCfg({ tts: { voice_type: entry.voice_type } });
    console.log(`已切换音色至: ${entry.name} (${entry.desc})`);
});
// ── wa status ──────────────────────────────────────────────────────────────
program
    .command('status')
    .description('Show all agent status and model configuration')
    .action(() => {
    const cfg = loadConfig();
    console.log('\n  Agent Configuration\n');
    console.log(`  ${'Agent'.padEnd(18)}${'Specialty'.padEnd(16)}${'Model'.padEnd(30)}Skills`);
    for (const [name, cls] of Object.entries(AGENT_CLASSES)) {
        const c = cls;
        const model = cfg.agents[name]?.model || cfg.llm.defaultModel;
        const skills = c.agentSkillNames ?? [];
        const skillStr = skills.length ? skills.join(', ') : '—';
        console.log(`  ${String(c.agentDisplayName).padEnd(18)}${String(c.agentSpecialty).padEnd(16)}${String(model).padEnd(30)}${skillStr}`);
    }
    console.log('');
});
// ── wa memory [action] [agent] ───────────────────────────────────────────
program
    .command('memory [action] [agent]')
    .description('Manage agent memory (status / clear)')
    .action(async (action, agentName) => {
    const act = action || 'status';
    const ctx = createSystemContext();
    const agents = Object.entries(ctx.agentMap);
    try {
        for (const [, agent] of agents)
            await agent.init();
        if (act === 'clear') {
            const targets = agentName ? [agentName.toLowerCase()] : Object.keys(ctx.agentMap);
            for (const name of targets) {
                const agent = ctx.agentMap[name];
                if (!agent) {
                    console.error(`  unknown agent: ${name}`);
                    continue;
                }
                const removed = agent.memory.shortTerm.filter((m) => m.role !== 'system').length;
                await agent.memory.clearShortTerm();
                console.log(`  ✓ cleared ${agent.emoji} ${agent.displayName} (${removed} messages)`);
            }
        }
        else if (act === 'status') {
            for (const [, agent] of agents) {
                const shortN = agent.memory.shortTerm.length;
                const working = Object.keys(agent.memory.working ?? {}).length;
                const longTerm = await agent.memory.recall({ limit: 100 }).catch(() => []);
                console.log(`  ${agent.emoji} ${agent.displayName}  ${shortN} short / ${working} working / ${longTerm.length} long-term`);
            }
        }
        else {
            console.error(`  unknown action: ${act} (status / clear)`);
            process.exitCode = 1;
        }
    }
    finally {
        for (const [, agent] of agents)
            await agent.close().catch(() => { });
    }
});
// ── wa version ─────────────────────────────────────────────────────────────
program
    .command('version')
    .description('Show version information')
    .action(() => {
    console.log(`  Weather Agents v${VERSION}`);
});
// ── wa init ────────────────────────────────────────────────────────────────
program
    .command('init')
    .description('Run the setup wizard, then optionally drop into chat')
    .action(async () => {
    await runSetupWizard();
    const answer = (await ask('  Enter chat now? [Y/n]: ')).toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') {
        const ctx = createSystemContext();
        const name = loadConfig().cli.defaultAgent || 'fog';
        const agent = ctx.agentMap[name] ?? ctx.agentMap.fog;
        await agent.init();
        await interactiveRepl(agent);
        await agent.close();
    }
    else {
        console.log('\n  Run `wa` when ready.\n');
    }
});
// ── Setup wizard (functional port of _run_setup_wizard) ──────────────────
/** Flatten the model catalog into [provider, modelName] pairs in catalog order. */
function flattenCatalog(catalog) {
    const out = [];
    for (const [prov, models] of Object.entries(catalog)) {
        for (const m of models)
            out.push([prov, m.name]);
    }
    return out;
}
async function runSetupWizard() {
    console.log('\n  Weather Agents Setup  ·  pick a model, store an API key\n');
    const catalog = loadModelCatalog();
    if (!Object.keys(catalog).length) {
        console.log('  No model catalog found. Reinstall and try again.');
        return;
    }
    const flat = flattenCatalog(catalog);
    // Step 1 — mode
    console.log('  Step 1 — Agent mode');
    console.log('    1. Unified    one model for all agents  (recommended)');
    console.log('    2. Per-agent  a different model per agent  (advanced)');
    const mode = (await ask('\n  Choice [1/2] — Enter for 1: ')) || '1';
    // Step 2 — model selection (numeric pick over the flat catalog)
    console.log('\n  Step 2 — Model selection');
    flat.forEach(([prov, name], i) => {
        console.log(`  ${String(i + 1).padStart(3)}. ${name}  (${prov})`);
    });
    const providersNeeded = new Set();
    const pickModel = async (title) => {
        const raw = await ask(`\n  ${title} #: `);
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= flat.length)
            return flat[n - 1];
        return null;
    };
    if (mode === '2') {
        for (const agentName of Object.keys(AGENT_CLASSES)) {
            const picked = await pickModel(`Model for ${agentName} (Enter to keep current)`);
            if (!picked) {
                console.log(`    ${agentName} → keep current`);
                continue;
            }
            const [prov, modelName] = picked;
            setConfig(`model.${agentName}`, modelName);
            providersNeeded.add(prov);
            console.log(`    ✓ ${agentName} → ${modelName}`);
        }
    }
    else {
        const picked = await pickModel('Pick default model');
        if (!picked) {
            console.log('  setup cancelled');
            return;
        }
        const [prov, modelName] = picked;
        setConfig('default_model', modelName);
        for (const ag of Object.keys(AGENT_CLASSES))
            deleteConfig(`model.${ag}`);
        providersNeeded.add(prov);
        console.log(`  ✓ default → ${modelName}`);
    }
    // Step 3 — API keys for the providers we just selected
    console.log('\n  Step 3 — API keys');
    for (const provider of providersNeeded) {
        const envVar = getProviderEnvVar(provider);
        const current = loadConfig().llm.apiKeys?.[provider] || process.env[envVar] || '';
        if (current) {
            console.log(`  ● ${provider} already configured — Enter to keep`);
        }
        else {
            console.log(`  ○ ${provider}`);
        }
        const keyVal = await ask(`     ${envVar}: `, true);
        if (keyVal) {
            const [ok, msg] = setConfig(`api_key.${provider}`, keyVal);
            console.log(`     ${ok ? '✓' : '✗'} ${msg}`);
        }
        else if (!current) {
            console.log(`     skipped — set later with: wa config set api_key.${provider} <key>`);
        }
        else {
            console.log('     (kept)');
        }
    }
    console.log('\n  ✓ Setup complete');
    console.log(`  config saved to ${join(USER_CONFIG_DIR, 'config.yaml')}\n`);
}
// ── Interactive REPL (shared by `wa chat`, bare `wa`, and `wa init`) ───────
async function interactiveRepl(agent) {
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
/** Prompt the user for a single line (resolves to trimmed string, '' on EOF). */
function ask(question, hidden = false) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // Hidden input (API keys): mute the output stream while typing.
        if (hidden) {
            const out = rl;
            const orig = rl.output;
            out._writeToOutput = (s) => {
                if (s.includes('\n'))
                    orig.write('\n');
            };
        }
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
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
// Bare `wa` (no subcommand) → drop into interactive chat with the default agent,
// mirroring the Python top-level callback.
program.action(async () => {
    const ctx = createSystemContext();
    const name = (loadConfig().cli.defaultAgent || 'fog').toLowerCase();
    const agent = ctx.agentMap[name] ?? ctx.agentMap.fog;
    await agent.init();
    await interactiveRepl(agent);
    await agent.close();
});
program.parse();
