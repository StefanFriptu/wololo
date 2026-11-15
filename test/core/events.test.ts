import { describe, expect, mock, test } from 'bun:test';
import { EventBus } from '../../src/core/events.ts';

describe('EventBus', () => {
  test('delivers typed payloads to named and any listeners and isolates listener errors', () => {
    const onError = mock(() => {});
    const bus = new EventBus(onError);
    const named = mock(() => {});
    const any = mock(() => {});
    bus.on('job.removed', () => {
      throw new Error('bad listener');
    });
    const off = bus.on('job.removed', named);
    bus.onAny(any);
    bus.emit('job.removed', { jobId: 7 });
    expect(named).toHaveBeenCalledWith({ jobId: 7 });
    expect(any).toHaveBeenCalledWith({
      name: 'job.removed',
      payload: { jobId: 7 },
    });
    expect(onError).toHaveBeenCalledTimes(1);
    off();
    bus.emit('job.removed', { jobId: 8 });
    expect(named).toHaveBeenCalledTimes(1);
  });
});
