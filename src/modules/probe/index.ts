import type { AppContext } from '../../app/context.ts';
import type { ProbeService } from '../../contracts/probe-scan.ts';
import { notImplemented } from '../../core/errors.ts';

export function createProbeService(_ctx: AppContext): ProbeService {
  return {
    probe: async () => notImplemented('probe.probe'),
  };
}
