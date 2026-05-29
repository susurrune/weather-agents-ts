/**
 * Core framework for Weather Agents (TypeScript port).
 *
 * Re-exports the public surface. Unlike the Python package (which uses PEP 562
 * lazy attribute loading to defer heavy imports), ES modules are already
 * loaded lazily by the runtime per import site, so a flat barrel is fine here.
 */

export { TASK_DONE_SENTINEL } from './constants.js';
export { AGENT_COLORS, AGENT_COLOR_MAP, AGENT_EMOJI, iconText, svgPath } from './icons.js';
export {
  CircuitBreaker,
  CircuitState,
  getBreaker,
  resetAllBreakers,
  breakerStates,
} from './circuitBreaker.js';
export { LLMCache } from './cache.js';
export { Logger, getLogger, setupLogging, setRequestId, getRequestId, logEvent } from './logger.js';
export { MessageBus, EventType, makeEvent, type Event, type Handler } from './bus.js';
export { stableStringify, sleep } from './util.js';
export {
  Tool,
  ToolRegistry,
  RESULT_STORE,
  globalRegistry,
  type ToolHandler,
  type ToolParameter,
  type ToolInit,
  type FunctionSchema,
} from './tool.js';
export {
  ACLMiddleware,
  RateLimitMiddleware,
  AuditMiddleware,
  MiddlewareChain,
  setMiddlewareChain,
  getMiddlewareChain,
  type Middleware,
  type PreResult,
} from './middleware.js';
export {
  SchemaValidationError,
  VALID_AGENTS,
  TaskStepSchema,
  TaskPlanSchema,
  FactSchema,
  ExtractionResultSchema,
  parseRawJson,
  parseSchema,
  parseTaskPlan,
  parseFacts,
  type TaskStep,
  type TaskPlan,
  type Fact,
  type ExtractionResult,
} from './schemas.js';
