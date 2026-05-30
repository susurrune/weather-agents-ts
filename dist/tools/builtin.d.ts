/** Built-in tool implementations — real Node.js handlers. Faithful port of 1280-line Python. */
import { ToolRegistry } from '../core/tool.js';
export declare function isProtectedPath(path: string): boolean;
export declare function validateUrl(url: string): string | null;
export declare function registerBuiltinTools(reg: ToolRegistry): void;
