import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readConfig(): { port?: number; urlBase?: string } {
  try {
    return JSON.parse(
      readFileSync(
        join(process.env.WOLOLO_CONFIG_DIR ?? '/config', 'config.json'),
        'utf8',
      ),
    );
  } catch {
    return {};
  }
}

const config = readConfig();
const port = process.env.WOLOLO__PORT ?? config.port ?? 8585;
const urlBase = process.env.WOLOLO__URL_BASE ?? config.urlBase ?? '';

try {
  const response = await fetch(`http://127.0.0.1:${port}${urlBase}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
