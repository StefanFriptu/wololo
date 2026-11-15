import { createRuntime, type Runtime } from './app/bootstrap.ts';

let runtime: Runtime | null = null;

const fail = (message: string, error: unknown) => {
  if (runtime) runtime.ctx.log.error(message, { error });
  else console.error(message, error);
};

process.on('unhandledRejection', (reason) => fail('unhandled promise rejection', reason));
process.on('uncaughtException', (error) => {
  fail('uncaught exception', error);
  void (runtime?.stop('uncaught exception') ?? Promise.resolve()).finally(() => process.exit(1));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (runtime?.stop(signal) ?? Promise.resolve()).finally(() => process.exit(0));
  });
}

try {
  runtime = createRuntime({ env: process.env });
  await runtime.start();
} catch (error) {
  fail('startup failed', error);
  await runtime?.stop('startup failure');
  process.exit(1);
}
