import { loopbackHost, resolveBootSettings } from '../src/core/config.ts';

const { port, bindAddress, urlBase } = resolveBootSettings(process.env);

try {
  const response = await fetch(`http://${loopbackHost(bindAddress)}:${port}${urlBase}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
