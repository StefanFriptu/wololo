import { createRuntime } from './app/bootstrap.ts';

const runtime = createRuntime({ env: process.env });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    runtime.stop(signal).finally(() => process.exit(0));
  });
}

try {
  await runtime.start();
} catch (error) {
  runtime.ctx.log.error('startup failed', { error });
  await runtime.stop('startup failure');
  process.exit(1);
}
