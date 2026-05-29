<div align="center">

# Weather Agents (TypeScript)

**雾 · 雨 · 霜 · 雪 · 露 · 晴**

*六位 Agent，一支团队。专精领域，默契协作。*

[![Node 20+](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

Weather Agents 是一个**本地优先的多智能体终端框架**。这是从 Python 版（[susurrune/weather-agents](https://github.com/susurrune/weather-agents)）忠实移植到 TypeScript 的版本。

六个 Agent 各司其职，通过事件总线通信、技能系统增强、编排引擎协作，完成从研究分析到代码生成到部署运维的完整工作流。

## 设计哲学

| 原则 | 含义 |
|:-----|:------|
| **规则优先，LLM 兜底** | 能用路由、Pipeline、关键词匹配解决的问题，绝不调 LLM |
| **Agent 角色稳定** | 六位 Agent 的人格与职能不随版本漂移 |
| **本地优先** | 核心功能不依赖云服务；Web 是补充，不是替代 |
| **诚实透明** | 功能描述基于代码事实，不过度承诺 |

## 六位 Agent

| Agent | 职责 | 核心技能 |
|:------|:------|:---------|
| **Fog** 雾 | 探索研究 | `web_research` · `code_analysis` · `document_analysis` |
| **Rain** 雨 | 生成创造 | `code_generator` · `content_writer` · `data_transformer` |
| **Frost** 霜 | 审查优化 | `code_reviewer` · `security_auditor` · `performance_checker` |
| **Snow** 雪 | 规划编排 | `task_planner` · `arch_designer` · `workflow_designer` |
| **Dew** 露 | 运维集成 | `sys_operator` · `ci_cd_manager` · `api_integrator` |
| **Fair** 晴 | 情感陪伴 | `emotional_companion` · `self_evolve` |

## 技术栈

| 关注点 | Python 版 | TypeScript 版 |
|:--|:--|:--|
| 运行时 | CPython 3.11+ | Node.js 20+ + tsx |
| LLM 层 | LiteLLM | Vercel AI SDK (`ai` + `@ai-sdk/*`) |
| CLI | Typer | commander |
| 终端样式 | Rich | chalk |
| 持久化 | aiosqlite | `node:sqlite`（Node 内置）|
| 配置 | PyYAML | js-yaml |
| 校验 | dataclass | zod |
| 测试 | pytest | vitest |
| Lint / 格式 | ruff | eslint + prettier |

## 开发

```bash
npm install
npm run dev        # tsx src/cli/main.ts
npm test           # vitest
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/
```

## 迁移状态

逐模块从 Python 移植，沿依赖图自底向上推进。

- [x] 工具链（tsconfig / eslint / prettier / vitest / CI）
- [x] `core/constants` · `core/icons` · `core/logger`
- [x] `core/circuitBreaker` · `core/cache` · `core/bus`（含测试）
- [ ] `core/config` · `core/tool` · `core/schemas` · `core/skill`
- [ ] `core/memory`（`node:sqlite`）· `core/llm`（AI SDK）
- [ ] `core/agent` · 六个 agent · `core/router` · `core/pipelines`
- [ ] `core/mcp` · `tools/builtin` · `core/factory`
- [ ] `cli/main` · `web/`（语音服务）

## License

MIT
