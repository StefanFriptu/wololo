import { and, asc, count, eq, gt, inArray, isNotNull, ne, type SQL, sql } from 'drizzle-orm';
import type { AppContext } from '../../app/context.ts';
import type { DryRunService } from '../../contracts/probe-scan.ts';
import { errorMessage, notFound } from '../../core/errors.ts';
import { yieldToEventLoop } from '../../core/yieldToEventLoop.ts';
import { mediaFiles } from '../../db/schema.ts';
import type { DryRunGroup, DryRunProfileRow, DryRunReport } from '../../shared/api-types.ts';
import type { DeviceProfile, Library } from '../../shared/domain.ts';
import { dryRunGroupKeys } from './dryRunGroups.ts';
import { estimateJobSeconds, estimateOutputBytes, peakTempBytes } from './estimate.ts';
import { libraryQuery } from './libraryQuery.ts';

const PAGE_SIZE = 500;
const PROBE_PAGE_SIZE = 100;
const SAMPLE_PATHS = 5;

type Totals = DryRunReport['totals'];

function emptyGroup(codec: string): DryRunGroup {
  return {
    codec,
    files: 0,
    durationSec: 0,
    sizeBytes: 0,
    estimatedSeconds: 0,
    estimatedOutputBytes: 0,
    samplePaths: [],
  };
}

export function createDryRunService(ctx: AppContext): DryRunService {
  const log = ctx.logs.logger('dryrun');

  const totalsFor = (scope: SQL | undefined): Totals => {
    const rows = ctx.db
      .select({ status: mediaFiles.status, count: count() })
      .from(mediaFiles)
      .where(scope)
      .groupBy(mediaFiles.status)
      .all();
    const totals: Totals = { files: 0, compatible: 0, needsWork: 0, blocked: 0, failed: 0, pending: 0, ignored: 0 };
    for (const row of rows) {
      totals.files += row.count;
      if (row.status === 'blocked') totals.blocked += row.count;
      else if (row.status === 'failed') totals.failed += row.count;
      else if (row.status === 'compatible') totals.compatible += row.count;
      else if (row.status === 'needs_work') totals.needsWork += row.count;
      else if (row.status === 'pending') totals.pending += row.count;
      else if (row.status === 'ignored') totals.ignored += row.count;
    }
    return totals;
  };

  const workRows = async function* (scope: SQL | undefined) {
    const isWork = inArray(mediaFiles.status, ['needs_work', 'blocked']);
    let afterId = 0;
    while (true) {
      const page = ctx.db
        .select({
          id: mediaFiles.id,
          rootId: mediaFiles.rootId,
          kind: mediaFiles.kind,
          path: mediaFiles.path,
          sizeBytes: mediaFiles.sizeBytes,
          durationSec: mediaFiles.durationSec,
          planAction: mediaFiles.planAction,
          failingCodecs: mediaFiles.failingCodecs,
          videoCodec: mediaFiles.videoCodec,
          estimatedOutputBytes: sql<number | null>`json_extract(${mediaFiles.plan}, '$.estimatedOutputBytes')`,
        })
        .from(mediaFiles)
        .where(and(scope, isWork, gt(mediaFiles.id, afterId)))
        .orderBy(asc(mediaFiles.id))
        .limit(PAGE_SIZE)
        .all();
      yield* page;
      const last = page.at(-1);
      if (!last || page.length < PAGE_SIZE) return;
      afterId = last.id;
      await yieldToEventLoop();
    }
  };

  const groupsAndSpace = async (scope: SQL | undefined) => {
    const settings = ctx.settings.get();
    const speed = settings.processing.estimatedSpeedFactor;
    const recycling = settings.recycleBin.enabled && settings.recycleBin.retentionDays > 0;
    const groups = new Map<string, DryRunGroup>();
    const largestOutputPerRoot = new Map<number, number>();
    let estimatedSeconds = 0;
    let discOutputBytes = 0;
    let largestIsoExtract = 0;
    let recycleBytes = 0;

    for await (const row of workRows(scope)) {
      const blocked = row.planAction === 'blocked';
      const input = {
        planAction: row.planAction,
        durationSec: row.durationSec,
        sizeBytes: row.sizeBytes,
        estimatedOutputBytes: row.estimatedOutputBytes,
      };
      const seconds = blocked ? 0 : estimateJobSeconds(input, speed);
      const outputBytes = blocked ? 0 : estimateOutputBytes(input);
      for (const key of dryRunGroupKeys(row)) {
        const group = groups.get(key) ?? emptyGroup(key);
        group.files += 1;
        group.durationSec += row.durationSec ?? 0;
        group.sizeBytes += row.sizeBytes;
        group.estimatedSeconds += seconds;
        group.estimatedOutputBytes += outputBytes;
        if (group.samplePaths.length < SAMPLE_PATHS) group.samplePaths.push(row.path);
        groups.set(key, group);
      }
      if (blocked) continue;
      estimatedSeconds += seconds;
      if (row.kind === 'file') {
        largestOutputPerRoot.set(row.rootId, Math.max(largestOutputPerRoot.get(row.rootId) ?? 0, outputBytes));
        if (recycling) recycleBytes += row.sizeBytes;
      } else {
        discOutputBytes += outputBytes;
        if (row.kind === 'iso') largestIsoExtract = Math.max(largestIsoExtract, outputBytes);
      }
    }

    const margin = settings.processing.freeSpaceMarginPercent;
    const tempBytes = [...largestOutputPerRoot.values()].reduce((sum, bytes) => sum + peakTempBytes(bytes, margin), 0);
    const sorted = [...groups.values()].sort((a, b) => b.files - a.files || a.codec.localeCompare(b.codec));
    for (const group of sorted) {
      group.durationSec = Math.round(group.durationSec);
      group.estimatedSeconds = Math.round(group.estimatedSeconds);
    }
    return {
      groups: sorted,
      estimatedSeconds: Math.round(estimatedSeconds),
      estimatedExtraBytes: tempBytes + discOutputBytes + largestIsoExtract + recycleBytes,
      estimatedRecycleBytes: recycleBytes,
    };
  };

  const profileRow = async (profile: DeviceProfile, libraries: Library[]): Promise<DryRunProfileRow> => {
    const speed = ctx.settings.section('processing').estimatedSpeedFactor;
    const effective = ctx.services.rules.resolveProfile([profile]);
    const row: DryRunProfileRow = {
      profileId: profile.id,
      name: profile.name,
      files: 0,
      failing: 0,
      durationSec: 0,
      estimatedSeconds: 0,
      estimatedOutputBytes: 0,
    };
    for (const library of libraries) {
      let afterId = 0;
      while (true) {
        const page = ctx.db
          .select({
            id: mediaFiles.id,
            probe: mediaFiles.probe,
            sizeBytes: mediaFiles.sizeBytes,
            originalLanguage: mediaFiles.originalLanguage,
          })
          .from(mediaFiles)
          .where(
            and(
              eq(mediaFiles.libraryId, library.id),
              eq(mediaFiles.kind, 'file'),
              ne(mediaFiles.status, 'ignored'),
              isNotNull(mediaFiles.probe),
              gt(mediaFiles.id, afterId),
            ),
          )
          .orderBy(asc(mediaFiles.id))
          .limit(PROBE_PAGE_SIZE)
          .all();
        for (const media of page) {
          if (!media.probe) continue;
          const plan = ctx.services.rules.plan({
            probe: media.probe,
            profile: effective,
            library,
            originalLanguage: media.originalLanguage,
          });
          row.files += 1;
          if (plan.action === 'skip') continue;
          row.failing += 1;
          row.durationSec += media.probe.durationSec;
          if (plan.action === 'blocked') continue;
          const input = {
            planAction: plan.action,
            durationSec: media.probe.durationSec,
            sizeBytes: media.sizeBytes,
            estimatedOutputBytes: plan.estimatedOutputBytes,
          };
          row.estimatedSeconds += estimateJobSeconds(input, speed);
          row.estimatedOutputBytes += estimateOutputBytes(input);
        }
        const last = page.at(-1);
        if (!last || page.length < PROBE_PAGE_SIZE) break;
        afterId = last.id;
        await yieldToEventLoop();
      }
    }
    row.durationSec = Math.round(row.durationSec);
    row.estimatedSeconds = Math.round(row.estimatedSeconds);
    return row;
  };

  const byProfile = async (libraries: Library[], profileId: number | undefined): Promise<DryRunProfileRow[]> => {
    try {
      const fallback = libraries.some((library) => library.profileIds.length === 0)
        ? await ctx.services.profiles.getDefault()
        : null;
      const assigned = [...new Set(libraries.flatMap((library) => library.profileIds))];
      const wanted =
        profileId === undefined ? [...new Set([...assigned, ...(fallback ? [fallback.id] : [])])] : [profileId];
      const rows: DryRunProfileRow[] = [];
      for (const id of wanted.sort((a, b) => a - b)) {
        const profile = id === fallback?.id ? fallback : await ctx.services.profiles.get(id);
        const scope = libraries.filter(
          (library) => library.profileIds.includes(id) || (library.profileIds.length === 0 && id === fallback?.id),
        );
        rows.push(await profileRow(profile, scope));
      }
      return rows;
    } catch (error) {
      log.warn('per-profile dry run unavailable', { error: errorMessage(error) });
      return [];
    }
  };

  return {
    report: async ({ libraryId, profileId }) => {
      const libraries = libraryQuery(ctx.db, libraryId === undefined ? {} : { id: libraryId });
      if (libraryId !== undefined && libraries.length === 0) throw notFound(`library ${libraryId}`);
      const scope = libraryId === undefined ? undefined : eq(mediaFiles.libraryId, libraryId);
      const space = await groupsAndSpace(scope);
      return {
        generatedAt: new Date().toISOString(),
        libraryId: libraryId ?? null,
        processingEnabled: ctx.settings.section('processing').enabled,
        totals: totalsFor(scope),
        groups: space.groups,
        byProfile: await byProfile(libraries, profileId),
        estimatedSeconds: space.estimatedSeconds,
        estimatedExtraBytes: space.estimatedExtraBytes,
        estimatedRecycleBytes: space.estimatedRecycleBytes,
      };
    },
  };
}
