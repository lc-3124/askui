/** First-run setup: detect platform, seed modules, create data dirs. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA, ensurePlatform, PLATFORM_FILE } from './platform.mjs';
import { seedModules } from './modules.mjs';

export function init({ force = false } = {}) {
  for (const d of ['store', 'runs', 'cache']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
  const platform = ensurePlatform({ force });
  const modules = seedModules();
  return {
    ok: true,
    platform,
    platformFile: PLATFORM_FILE,
    modules: modules.length,
    dataDir: DATA,
  };
}
