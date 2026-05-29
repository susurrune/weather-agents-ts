<div align="center">

# Weather Agents

**雾 · 雨 · 霜 · 雪 · 露 · 晴**

*Six agents. One team. Specialization meets orchestration.*

[![Node 22+](https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CI](https://github.com/susurrune/weather-agents-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/susurrune/weather-agents-ts/actions)
[![Tests](https://img.shields.io/badge/tests-104-blue)](https://github.com/susurrune/weather-agents-ts)

</div>

---

Weather Agents is a **local-first multi-agent CLI framework**. Six agents — each with a distinct specialty — collaborate through an event bus, skill system, and orchestration engine to handle the full pipeline from research to code generation to deployment.

This is the **TypeScript port** of the original Python project ([susurrune/weather-agents](https://github.com/susurrune/weather-agents)). It runs on Node.js 22+ and uses the Vercel AI SDK for multi-provider LLM access.

```bash
# Global install (recommended)
npm install -g github:susurrune/weather-agents-ts

# Now `wa` is available anywhere:
wa chat fog "Search the web for the latest TypeScript 5.7 features"

# Orchestrate a multi-agent task
wa task "Design and implement a URL shortener"

# Interactive REPL
wa chat snow
```

---

## Design Philosophy

| Principle | What it means |
|:----------|:--------------|
| **Rules first, LLM as fallback** | Router classification, pipeline matching, and keyword dispatch run in microseconds. The LLM is called only when a task genuinely needs reasoning. |
| **Stable agent identities** | Each agent's persona, specialty, and system prompt are version-stable. New capabilities come through Skills and Pipelines, not personality drift. |
| **Local-first** | Core functionality runs without cloud services. Web search and API calls are tools the agent *chooses* to use, not infrastructure it depends on. |
| **Transparent** | Token usage, cost estimates, context-window pressure, and circuit-breaker state are all visible in real time. |

---

## The Six Agents

| Agent | Glyph | Role | Best at |
|:------|:-----|:-----|:--------|
| **Fog** 雾 | ≋ | Exploration & Research | Web search, document analysis, codebase exploration, knowledge synthesis |
| **Rain** 雨 | ╱ | Generation & Creation | Code generation, content writing, data transformation, full-stack projects |
| **Frost** 霜 | ✱ | Review & Optimization | Code review, security audit, performance analysis, debugging |
| **Snow** 雪 | ❉ | Architecture & Orchestration | Task decomposition, DAG planning, multi-agent coordination, full-pipeline execution |
| **Dew** 露 | ∘ | DevOps & Integration | Shell commands, deployment, CI/CD, API integration, environment diagnostics |
| **Fair** 晴 | ☼ | Companion | Emotional support, casual conversation — deliberately isolated from orchestration |

```bash
wa chat fog    "Compare FastAPI and Hono for a new API project"
wa chat rain   "Write a React hook for debounced search"
wa chat frost  "Review src/core/agent.ts for bugs"
wa chat dew    "Check which ports are listening on this machine"
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                    cli/main.ts                    │
│         Commander CLI (chat / task / config)       │
├──────────────────────────────────────────────────┤
│                  core/factory.ts                   │
│      createSystemContext / orchestrateTask        │
├──────────┬──────────┬──────────┬─────────────────┤
│  Fog 雾  │ Rain 雨  │ Frost 霜 │  Snow 雪        │
│          │          │          │  Dew 露  Fair 晴 │
├──────────┴──────────┴──────────┴─────────────────┤
│                core/agent.ts (BaseAgent)           │
│   chatStream loop · tool execution · 5 detectors  │
├──────────────────────────────────────────────────┤
│  core/llm.ts     │  core/memory.ts  │ core/tool.ts │
│  (Vercel AI SDK)  │  (node:sqlite)   │  (registry)  │
├──────────────────────────────────────────────────┤
│  tools/builtin.ts (17 handlers)                   │
│  tools/delegate.ts · core/mcp.ts                 │
│  core/middleware.ts (ACL · rate-limit · audit)    │
├──────────────────────────────────────────────────┤
│  core/config.ts · core/skill.ts · core/router.ts  │
│  core/pipelines.ts · core/schemas.ts              │
└──────────────────────────────────────────────────┘
```

### Key design decisions

- **`CompletionBackend` interface**: The LLM provider call is isolated behind an injectable interface. All orchestration logic (fallback chains, retries, usage tracking, budget enforcement, caching) is provider-agnostic and fully unit-testable with a fake backend — mirroring how the Python tests mock `litellm`.
- **`node:sqlite`**: Persistence uses Node's built-in synchronous SQLite (stable since Node 22). No native addons, no build toolchain. WAL mode, per-agent database isolation, conversation-gap truncation on resume.
- **Tool-call invariant**: The `_prune_dangling_tool_calls` algorithm (position-aware stack matching) is preserved exactly — every `tool` message must have a matching preceding `assistant` with that `tool_call_id`. This is the red-line invariant from the Python codebase.
- **Five stuck-loop detectors** in `chatStream`: narration-loop (text similarity), tool-signature loop (fingerprint counting), failure storm (≥5/6 failing), hard-escape (≥8 consecutive failures), search storm (≥8 web_search/fetch_page).

---

## CLI Commands

```bash
wa chat [agent] [message]     # Streaming chat. Omit message for interactive REPL.
                              #   /model <id>   switch model
                              #   /sessions     list sessions
                              #   /models       model catalog
                              #   /quit         exit

wa task <goal>                # Orchestrate a multi-agent task via Snow

wa models                     # List available models from the bundled catalog

wa config                     # Show current configuration
wa config default_model gpt-4o   # Set a config key

wa sessions [agent]           # List saved conversation sessions

wa voice [agent]              # Start the voice WebSocket server (port 8765)
```

---

## Technical Stack

| Concern | Implementation |
|:--------|:---------------|
| Runtime | Node.js 22+ / tsx |
| Language | TypeScript 5.x (strict, `noUncheckedIndexedAccess`) |
| LLM layer | Vercel AI SDK (`ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@ai-sdk/google`) |
| CLI framework | Commander |
| Persistence | `node:sqlite` (built-in, no native deps) |
| Configuration | YAML (js-yaml) with `${VAR}` env resolution |
| Schema validation | Zod |
| Testing | Vitest |
| Lint / Format | ESLint (flat config) + Prettier |
| CI | GitHub Actions (lint, typecheck, test on Node 22 + 24) |

### Provider routing

Models are specified as `<provider>/<model>` (e.g. `deepseek/deepseek-v4-pro`). The provider prefix is resolved against the YAML catalog (`config/providers.yaml`), which carries `env_var`, `base_url`, aliases, and region metadata. OpenAI-compatible providers (DeepSeek, Ollama, Groq, OpenRouter, …) all route through `@ai-sdk/openai` with the catalog-supplied `base_url`.

```bash
# Examples
wa chat fog -m openai/gpt-4.1-mini "explain closures"
wa chat rain -m anthropic/claude-sonnet-4-6 "write a sorting function"
wa chat snow -m deepseek/deepseek-v4-pro "plan a migration"
wa chat dew -m ollama/llama3 "check disk usage"
```

---

## Install / Uninstall / Update

```bash
# Global install (recommended — `wa` available anywhere)
npm install -g github:susurrune/weather-agents-ts

# Uninstall
npm uninstall -g weather-agents

# Update to latest
npm uninstall -g weather-agents && npm install -g github:susurrune/weather-agents-ts
```

## Development
npm test             # vitest (104 tests)
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier --write
npm run build        # tsc → dist/
```

### Environment

```bash
# Required: at least one provider API key
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export DEEPSEEK_API_KEY=sk-...

# Optional
WA_DEBUG=1          # Stream logs to stderr
WA_VERBOSE=1        # Show reasoning_content in streaming chat
WA_NO_RESUME=1      # Start fresh session (don't resume last)
WA_ALLOW_PRIVATE_NET=1  # Disable SSRF guard (allow private IPs)
```

### Project structure

```
src/
├── cli/main.ts              # CLI entry point
├── core/
│   ├── agent.ts             # BaseAgent — chat loop, tool execution, detectors
│   ├── llm.ts               # LLMClient + AiSdkBackend (CompletionBackend seam)
│   ├── memory.ts            # Three-layer memory on node:sqlite
│   ├── tool.ts              # Tool, ToolRegistry, result cache
│   ├── config.ts            # YAML config, provider/model catalog
│   ├── skill.ts             # Skill frontmatter parser (Anthropic format)
│   ├── mcp.ts               # MCP client (stdio + SSE transport)
│   ├── router.ts            # Classify goal → direct / single / orchestrate
│   ├── pipelines.ts         # Predefined multi-agent DAG templates
│   ├── factory.ts           # createSystemContext + orchestrateTask
│   ├── schemas.ts           # Zod schemas (TaskPlan, Fact, …)
│   ├── middleware.ts         # ACL, rate-limit, audit
│   ├── circuitBreaker.ts    # Per-tool circuit breaker
│   ├── cache.ts             # LLM response LRU cache
│   ├── bus.ts               # Pub/sub event bus
│   ├── logger.ts            # Structured JSON logging
│   ├── semantic.ts          # Character n-gram Jaccard scorer
│   ├── difflib.ts           # Ratcliff-Obershelp ratio + get_close_matches
│   ├── toolRouter.ts        # Keyword-scored tool subset selection
│   ├── workspace.ts         # Auto-detect best drive, create workspace tree
│   ├── icons.ts             # Agent glyphs + color map
│   └── constants.ts         # Shared constants (TASK_DONE_SENTINEL)
├── agents/
│   ├── fog.ts, rain.ts, frost.ts, snow.ts, dew.ts, fair.ts
├── tools/
│   ├── builtin.ts           # 17 tool handlers (files, HTTP, shell, search)
│   └── delegate.ts          # delegate_to — cross-agent task delegation
├── skills/loader.ts         # SKILL.md discovery + registration
├── plugins/loader.ts        # Plugin package loader
└── web/
    ├── server.ts            # Voice WebSocket server (RFC 6455)
    └── certs.ts             # Self-signed TLS certificate generation
```

---

## Security

- **SSRF guard**: `http_get` / `http_post` / `fetch_page` validate URLs against private, loopback, link-local, unspecified, and multicast IP ranges. Set `WA_ALLOW_PRIVATE_NET=1` to disable.
- **Path protection**: Write tools (`write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file`) refuse to touch system directories. Symlink resolution via `realpath` closes symlink-bypass attacks.
- **Shell safety**: `shell_exec` blocks dangerous binaries (`rm`, `sudo`, `ssh`, …) and shell metacharacter injection (`;`, `&&`, `||`, backticks, `$()`).
- **API key storage**: Configuration files written by `wa config` are `chmod`'d `0600` (owner-only).
- **Circuit breaker**: Per-tool fail-fast on cascading errors. OPEN → HALF_OPEN probe → CLOSED on success.

---

## License

MIT — see [LICENSE](LICENSE).

Original Python project: [susurrune/weather-agents](https://github.com/susurrune/weather-agents)
