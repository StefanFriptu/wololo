import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { DownloadClientService } from '../../contracts/integrations.ts';
import type { JobsService, RecycleBinService } from '../../contracts/jobs.ts';
import type { SystemService } from '../../contracts/platform.ts';
import { DEFAULT_TASK_INTERVALS, type ScanService } from '../../contracts/probe-scan.ts';
import type { ScanStatus } from '../../shared/api-types.ts';
import type { TaskName } from '../../shared/domain.ts';
import { taskDefinitions } from './tasks.ts';

let t: TestContext;
let scanError: string | null;
let cancelled: number;

const status = (running: boolean): ScanStatus => ({
  scanId: 'scan-1',
  libraryId: null,
  running,
  startedAt: '2026-11-15T12:00:00.000Z',
  finishedAt: running ? null : '2026-11-15T12:01:00.000Z',
  currentPath: null,
  stats: {
    filesSeen: 10,
    filesNew: 2,
    filesChanged: 1,
    filesRemoved: 0,
    filesProbed: 3,
    probeErrors: 0,
    jobsQueued: 0,
  },
  error: scanError,
});

beforeEach(() => {
  scanError = null;
  cancelled = 0;
  let current: ScanStatus | null = null;
  t = createTestContext({
    overrides: {
      scan: stubService<ScanService>('scan', {
        start: async () => {
          current = status(true);
          setTimeout(() => {
            current = status(false);
            t.ctx.events.emit('scan.finished', { scanId: 'scan-1', stats: current.stats, error: scanError });
          }, 5);
          return status(true);
        },
        current: () => current,
        cancel: async () => {
          cancelled += 1;
        },
      }),
      recycleBin: stubService<RecycleBinService>('recycleBin', {
        purge: async () => ({ purged: 2, freedBytes: 2048 }),
      }),
      downloadClient: stubService<DownloadClientService>('downloadClient', {
        checkSeedingGoals: async () => '1 torrent removed',
      }),
      system: stubService<SystemService>('system', {
        createBackup: async (kind) => ({ name: `wololo_backup_${kind}.zip`, sizeBytes: 1, createdAt: '', kind }),
        cleanupLogs: async () => '3 logs removed',
      }),
      jobs: stubService<JobsService>('jobs', { housekeeping: async () => 'tidy' }),
    },
  });
});

afterEach(() => t.cleanup());

const runTask = (name: TaskName, signal = new AbortController().signal) => {
  const task = taskDefinitions(t.ctx).find((definition) => definition.name === name);
  if (!task) throw new Error(`no task ${name}`);
  return task.run(signal);
};

test('taskDefinitions - one definition per task name with the default interval', () => {
  const definitions = taskDefinitions(t.ctx);
  const pairs: [string, number][] = definitions.map((task) => [task.name, task.defaultIntervalMinutes]);
  expect(pairs).toEqual(Object.entries(DEFAULT_TASK_INTERVALS));
  expect(definitions.every((task) => task.label.length > 0)).toBe(true);
});

test.each([
  ['recycle_bin_purge', 'purged 2 file(s), freed 2048 bytes'],
  ['seeding_check', '1 torrent removed'],
  ['backup', 'created wololo_backup_scheduled.zip'],
  ['housekeeping', 'tidy'],
  ['log_cleanup', '3 logs removed'],
] as const)('taskDefinitions - %s dispatches to its service', async (name, message) => {
  expect(await runTask(name)).toBe(message);
});

test('taskDefinitions - library_scan waits for the scan and summarises it', async () => {
  expect(await runTask('library_scan')).toBe('10 files, 2 new, 1 changed, 0 removed, 3 probed, 0 errors, 0 queued');
});

test('taskDefinitions - library_scan fails when the scan reports an error', async () => {
  scanError = 'root /data is not accessible';
  const error = await runTask('library_scan').catch((caught: unknown) => caught);
  expect((error as Error).message).toStartWith('root /data is not accessible (10 files');
});

test('taskDefinitions - aborting library_scan cancels the scan', async () => {
  const controller = new AbortController();
  const running = runTask('library_scan', controller.signal);
  controller.abort();
  await running;
  expect(cancelled).toBe(1);
});
