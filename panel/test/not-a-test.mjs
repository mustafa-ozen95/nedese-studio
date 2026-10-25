/**
 * The helpers in this folder (fake servers and scripts) are started by the tests; they are not tests. `node --test`
 * without a pattern (e.g. `node --test panel/test`) runs every file here anyway: a fake then crashed on its missing
 * arguments, and fake-mcp.mjs waited on stdin and held the whole run for 10 minutes (25.10.2026). Started by the test
 * runner (its --test flags; a test's own spawn has none) as the main module, a helper exits at once.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function exitIfRunAsTest(url) {
  if (process.env.NODE_TEST_CONTEXT && process.execArgv.some((a) => a.startsWith('--test')) && resolve(process.argv[1] ?? '') === fileURLToPath(url)) process.exit(0);
}
