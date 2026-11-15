import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogHub } from '../../src/core/logger.ts';

describe('LogHub', () => {
  test('filters by level, keeps a bounded ring buffer and returns newest first', () => {
    const hub = new LogHub({
      level: 'info',
      logDir: null,
      console: false,
      ringSize: 3,
    });
    const log = hub.logger('jobs');
    log.debug('hidden');
    for (const n of [1, 2, 3, 4]) log.info(`m${n}`);
    expect(hub.entries().map((e) => e.message)).toEqual(['m4', 'm3', 'm2']);
    log.error('boom', { error: new Error('x') });
    expect(hub.entries({ level: 'error' })[0]?.data?.error).toMatchObject({
      message: 'x',
    });
  });

  test('module filter matches children', () => {
    const hub = new LogHub({ level: 'trace', logDir: null, console: false });
    hub.logger('jobs').child('worker').info('a');
    hub.logger('scan').info('b');
    expect(hub.entries({ module: 'jobs' }).map((e) => e.module)).toEqual([
      'jobs.worker',
    ]);
  });

  test('writes and rotates the log file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wololo-logs-'));
    try {
      const hub = new LogHub({
        level: 'info',
        logDir: dir,
        console: false,
        maxFileBytes: 200,
        maxFiles: 2,
      });
      const log = hub.logger('t');
      for (let i = 0; i < 10; i++) {
        log.info(`line ${i} ${'x'.repeat(40)}`);
        hub.flush();
      }
      hub.close();
      expect(hub.listFiles().map((f) => f.name)).toEqual([
        'wololo.0.txt',
        'wololo.1.txt',
        'wololo.txt',
      ]);
      expect(readFileSync(join(dir, 'wololo.txt'), 'utf8')).toContain(
        '|INFO|t|line 9',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
