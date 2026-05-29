/** Plugin discovery and loading. */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolRegistry } from '../core/tool.js';
import { getLogger } from '../core/logger.js';

const log = getLogger('plugins');

/** Load all plugins from the given directories into the tool registry. */
export function loadPlugins(reg: ToolRegistry, directories: string[]): void {
  for (const dir of directories) {
    const expanded = dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
    if (!existsSync(expanded)) continue;
    try {
      for (const entry of readdirSync(expanded, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_'))
          continue;
        const pkgJson = join(expanded, entry.name, 'package.json');
        if (existsSync(pkgJson)) {
          try {
            const localRequire = createRequire(join(expanded, entry.name, 'package.json'));
            const mod = localRequire(join(expanded, entry.name));
            if (typeof mod.register === 'function') {
              mod.register(reg);
              log.info('plugin_loaded', { name: entry.name, dir: expanded });
            }
          } catch (e) {
            log.warning('plugin_load_failed', { name: entry.name, error: String(e) });
          }
        }
      }
    } catch {
      /* skip unreadable directory */
    }
  }
}
