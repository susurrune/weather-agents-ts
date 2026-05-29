#!/usr/bin/env node
/** wa — Weather Agents CLI entry point. */
import { program } from 'commander';
import { createSystemContext, AGENT_CLASSES, orchestrateTask } from '../core/factory.js';

program
  .name('wa')
  .description('Weather Agents — multi-agent AI orchestration framework')
  .version('1.0.1');

program
  .command('chat [agent] [message...]')
  .description('Chat with an agent')
  .action(async (agentName?: string, messageParts?: string[]) => {
    const ctx = createSystemContext();
    const name = (agentName || 'fog').toLowerCase();
    const message = (messageParts || []).join(' ').trim() || '';
    if (!message) {
      console.log(`Usage: wa chat [${Object.keys(AGENT_CLASSES).join('|')}] "<message>"`);
      process.exit(0);
    }
    const agent = ctx.agentMap[name];
    if (!agent) {
      console.log(`Unknown agent: ${name}. Use: ${Object.keys(AGENT_CLASSES).join(', ')}`);
      process.exit(1);
    }
    await agent.init();
    const result = await agent.chat(message);
    console.log(result);
    await agent.close();
  });

program
  .command('task <goal...>')
  .description('Orchestrate a multi-agent task')
  .action(async (goalParts: string[]) => {
    const goal = goalParts.join(' ').trim();
    if (!goal) {
      console.log('Usage: wa task "<goal>"');
      process.exit(0);
    }
    const ctx = createSystemContext();
    const { mode, result } = await orchestrateTask(ctx, goal);
    console.log(`[mode: ${mode}]\n${result}`);
  });

program.parse();
