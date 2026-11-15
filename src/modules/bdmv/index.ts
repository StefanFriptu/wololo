import type { AppContext } from '../../app/context.ts';
import type { BdmvService } from '../../contracts/bdmv.ts';
import { notImplemented } from '../../core/errors.ts';

export function createBdmvService(_ctx: AppContext): BdmvService {
  return {
    detect: async () => notImplemented('bdmv.detect'),
    analyze: async () => notImplemented('bdmv.analyze'),
    evaluate: async () => notImplemented('bdmv.evaluate'),
    execute: async () => notImplemented('bdmv.execute'),
    listDecisions: async () => notImplemented('bdmv.listDecisions'),
    getDecision: async () => notImplemented('bdmv.getDecision'),
    resolveDecision: async () => notImplemented('bdmv.resolveDecision'),
    dismissDecision: async () => notImplemented('bdmv.dismissDecision'),
    offerSourceDeletion: async () => notImplemented('bdmv.offerSourceDeletion'),
    deleteSource: async () => notImplemented('bdmv.deleteSource'),
  };
}
