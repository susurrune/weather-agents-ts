/** Configuration management for Weather Agents. */
export declare const USER_CONFIG_DIR: string;
/** All agent names — single source of truth for config iteration and validation. */
export declare const AGENT_NAMES: readonly ["fog", "rain", "frost", "snow", "dew", "fair"];
export type AgentName = (typeof AGENT_NAMES)[number];
export declare const CONFIG_DIR: string;
export declare function saveUserCfg(data: Record<string, any>): void;
export interface ModelEntry {
    name: string;
    provider?: string;
    context_window?: number;
    max_output?: number;
    input_cost_per_1k?: number;
    output_cost_per_1k?: number;
    fallback?: string[];
    [k: string]: unknown;
}
export declare function loadModelCatalog(): Record<string, ModelEntry[]>;
export declare function formatModelsForDisplay(catalog: Record<string, ModelEntry[]>): string;
export declare function getModelContextWindow(modelName: string): number;
export declare function loadProviderCatalog(): Record<string, Record<string, any>>;
export declare function getProviderEnvVar(provider: string): string;
export declare function resolveProviderAlias(name: string): string;
export declare function invalidateProviderCache(): void;
export interface LLMConfig {
    defaultModel: string;
    lightweightModel: string | null;
    temperature: number;
    maxTokens: number;
    timeout: number;
    maxRetries: number;
    apiKeys: Record<string, string>;
    language: string;
}
export interface AgentModelConfig {
    model: string | null;
    specialty: string;
    maxToolRounds: number;
}
export type AgentConfigs = Record<AgentName, AgentModelConfig>;
export interface BusConfig {
    maxRetries: number;
    retryDelay: number;
}
export interface MemoryConfig {
    dbPath: string;
    shortTermLimit: number;
    maxPersistedMessages: number;
}
export interface WebConfig {
    host: string;
    port: number;
}
export interface WorkspaceConfig {
    path: string;
}
export interface TTSConfig {
    enabled: boolean;
    provider: string;
    accessToken: string;
    apiKey: string;
    appId: string;
    resourceId: string;
    voiceType: string;
    encoding: string;
    sampleRate: number;
    speedRatio: number;
    volumeRatio: number;
    pitchRatio: number;
    emotion: string;
}
export interface PluginConfig {
    enabled: boolean;
    directories: string[];
}
export interface MCPConfig {
    servers: Array<Record<string, any>>;
}
export interface CLIConfig {
    defaultAgent: string;
    interactiveMode: string;
    approvalMode: string;
    circuitFailureThreshold: number;
    circuitRecoveryTimeout: number;
    rateLimitMaxCalls: number;
    rateLimitWindow: number;
    auditEnabled: boolean;
}
export interface AppConfig {
    llm: LLMConfig;
    agents: AgentConfigs;
    bus: BusConfig;
    memory: MemoryConfig;
    web: WebConfig;
    workspace: WorkspaceConfig;
    tts: TTSConfig;
    plugins: PluginConfig;
    mcp: MCPConfig;
    cli: CLIConfig;
}
export declare function defaultAppConfig(): AppConfig;
export declare function invalidateCache(): void;
/** Load config from default + user overrides + env vars, with TTL cache. */
export declare function loadConfig(): AppConfig;
/** Set a config key and persist to user config. Returns [ok, message]. */
export declare function setConfig(key: string, value: string): [boolean, string];
/** Delete a config key from user config. Returns [ok, message]. */
export declare function deleteConfig(key: string): [boolean, string];
