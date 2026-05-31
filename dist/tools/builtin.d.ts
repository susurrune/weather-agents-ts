/** Built-in tool implementations — real Node.js handlers. Faithful port of 1280-line Python. */
import { ToolRegistry } from '../core/tool.js';
export declare function isProtectedPath(path: string): boolean;
export declare function validateUrl(url: string): string | null;
interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}
/** Decode HTML entities (named + decimal/hex numeric) in scraped result text. */
export declare function decodeEntities(s: string): string;
/** Parse DuckDuckGo HTML results (result__a / result__snippet), decoding the
 *  `uddg=` redirect wrapper DDG puts around result URLs. */
export declare function parseDdgHtml(html: string, max: number): SearchResult[];
/** Parse Bing HTML results (b_algo blocks). Works where DuckDuckGo is blocked
 *  (e.g. mainland China), so it's our fallback backend. */
export declare function parseBingHtml(html: string, max: number): SearchResult[];
export declare function registerBuiltinTools(reg: ToolRegistry): void;
export {};
