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
  .action(async (agentName?: string, messageParts?: string[], opts?: { model?: string }) => {
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
        if (trimmed === '/quit' || trimmed === '/exit') break;
        if (trimmed === '/sessions') {
          const sessions = await agent.memory.listSessions();
          console.log(
            sessions
              .map((s) => `  ${s.id.slice(0, 8)}… ${s.message_count}msgs ${s.preview || '(empty)'}`)
              .join('\n') || '  No sessions.',
          );
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
    } else {
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
  .action(async (goalParts: string[]) => {
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
  .action(async (key?: string, value?: string) => {
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
    } else {
      const cfg = loadConfig();
      // Simple key lookup
      const parts = key.split('.');
      let obj: any = cfg;
      for (const p of parts) {
        if (obj && typeof obj === 'object') obj = obj[p];
        else break;
      }
      console.log(`${key}: ${JSON.stringify(obj)}`);
    }
  });

// ── wa sessions [agent] ──────────────────────────────────────────────────

program
  .command('sessions [agent]')
  .description('List sessions for an agent')
  .action(async (agentName?: string) => {
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
    } else {
      for (const s of sessions) {
        console.log(
          `  ${s.id.padEnd(14)} ${String(s.message_count).padStart(4)} msgs  ${s.preview?.slice(0, 60) || '(empty)'}  ${s.updated_at}`,
        );
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
  .action(
    async (
      agentName: string | undefined,
      opts: { port?: string; host?: string; certFile?: string; keyFile?: string },
    ) => {
      const name = (agentName || 'fair').toLowerCase();
      if (!(name in AGENT_CLASSES)) {
        console.error(
          `unknown agent '${name}'; available: ${Object.keys(AGENT_CLASSES).join(', ')}`,
        );
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
    },
  );

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
  .action(async (name: string) => {
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

// ── Streaming helpers ────────────────────────────────────────────────────

async function streamChat(agent: any, message: string): Promise<void> {
  for await (const ev of agent.chatStream(message)) {
    if (ev.type === 'content') {
      process.stdout.write(ev.text);
    } else if (ev.type === 'tool_status') {
      process.stdout.write(`\n  ${ev.label}...`);
    } else if (ev.type === 'tool_done') {
      const icon = ev.success ? '✓' : '✗';
      process.stdout.write(` ${icon}`);
    } else if (ev.type === 'done') {
      process.stdout.write('\n');
    } else if (ev.type === 'reasoning') {
      // reasoning content is hidden by default; show dimly if VERBOSE=1
      if (process.env.WA_VERBOSE === '1') process.stdout.write(`\x1b[2m${ev.text}\x1b[0m`);
    } else if (ev.type === 'truncated') {
      process.stdout.write(`\n  ⚠ ${ev.reason}\n`);
    }
  }
}

program.parse();
