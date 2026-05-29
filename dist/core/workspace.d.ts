/**
 * Workspace auto-detection and lifecycle management.
 *
 * - First launch: auto-select best drive, create workspace/
 * - Windows multi-drive: skip C:, pick drive with most free space
 * - Windows single drive (C: only): use C:\workspace
 * - Unix: use ~/workspace
 * - User can override via config workspace.path
 */
export interface DriveInfo {
    letter: string;
    path: string;
    totalBytes: number;
    freeBytes: number;
}
/** Pick the best drive for the workspace directory. */
export declare function detectBestWorkspaceRoot(): string;
/** Resolve workspace path from config ("auto" → detect; else expand ~ and resolve). */
export declare function resolveWorkspacePath(configValue: string): string;
/** Create the workspace directory tree on first use. Idempotent. */
export declare function initWorkspace(root: string): string;
/** Human-readable byte count (e.g. 128.5 GB). */
export declare function formatBytes(n: number): string;
