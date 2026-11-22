import type { Settings } from '#lib/shared.ts';

interface SetupFacts {
  setup: Settings['setup'];
  libraryCount: number;
  arrCount: number;
}

export function shouldOpenSetup({ setup, libraryCount, arrCount }: SetupFacts): boolean {
  return !setup.completed && !setup.dismissed && libraryCount === 0 && arrCount === 0;
}
