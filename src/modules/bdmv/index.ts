import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { BdmvService } from '../../contracts/bdmv.ts';
import { AppError } from '../../core/errors.ts';
import { runProcess } from '../../core/process.ts';
import type { BdmvDecision, BdmvDecisionChoice, TorrentInfo } from '../../shared/domain.ts';
import {
  closeDecision,
  getDecisionQuery,
  insertDecision,
  latestDecisionQuery,
  listDecisionsQuery,
} from './decisions.ts';
import { analyzeDisc, detectDisc, openDisc } from './disc.ts';
import { createBdmvExecutor } from './execute.ts';
import { createIsoReader, findEntry } from './iso.ts';
import { completedBdmvJob, createDiscPlanner, loadDiscRow, pickOptions, playlistViews } from './planner.ts';

function seededFor(seconds: number): string {
  const hours = seconds / 3600;
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`;
}

export function deleteSourceMessage(torrent: TorrentInfo, sourcePath: string, outputPath: string | null): string {
  return (
    `"${torrent.name}" met its seeding goal (ratio ${torrent.ratio.toFixed(2)}, seeded ${seededFor(torrent.seedingTimeSec)}). ` +
    `Delete the source ${sourcePath}?${outputPath ? ` It was converted to ${outputPath}.` : ''}`
  );
}

function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** Pure: why a main_title choice does not fit the decision, or null when it does. */
export function mainTitleChoiceError(
  decision: Pick<BdmvDecision, 'titleCandidates'>,
  choice: Extract<BdmvDecisionChoice, { kind: 'main_title' }>,
): string | null {
  const offered = new Set(decision.titleCandidates.map((candidate) => candidate.playlist));
  const unknown = choice.playlists.filter((playlist) => !offered.has(playlist));
  if (unknown.length > 0)
    return `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not among the offered playlists (${[...offered].join(', ')})`;
  const chosen = new Set(choice.asEditions ? choice.playlists : choice.playlists.slice(0, 1));
  const strayNames = Object.keys(choice.editionNames).filter((playlist) => !chosen.has(playlist));
  if (strayNames.length > 0) return `edition names given for playlists that are not exported: ${strayNames.join(', ')}`;
  return null;
}

export function createBdmvService(ctx: AppContext): BdmvService {
  const log = ctx.logs.logger('bdmv');
  const tempRoot = tmpdir();
  const isoReader = createIsoReader({
    sevenZip: ctx.config.get().tools.sevenZip,
    run: (options) =>
      runProcess({ ...options, signal: options.signal ?? ctx.shutdownSignal, lowPriority: false, timeoutMs: 300_000 }),
    tempRoot,
  });
  const planner = createDiscPlanner(ctx, { isoReader, log });

  const getDecision = async (id: number): Promise<BdmvDecision> => {
    const decision = getDecisionQuery(ctx.db, id);
    if (!decision) throw new AppError('not_found', `BDMV decision ${id} not found`);
    return decision;
  };

  const closePending = async (
    decision: BdmvDecision,
    state: 'resolved' | 'dismissed',
    choice: BdmvDecisionChoice | null,
  ) => {
    if (!closeDecision(ctx.db, decision.id, state, choice, new Date().toISOString()))
      throw new AppError('conflict', `BDMV decision ${decision.id} is already ${decision.state}`);
    log.info(`BDMV decision ${state}`, {
      decisionId: decision.id,
      mediaFileId: decision.mediaFileId,
      kind: decision.kind,
    });
    ctx.events.emit('bdmv.decision', { decisionId: decision.id, mediaFileId: decision.mediaFileId });
  };

  /** The converted output must exist on its own, outside the source, before anything of the source is deleted. */
  const requireConvertedOutput = async (mediaFileId: number, sourcePath: string): Promise<string> => {
    const converted = completedBdmvJob(ctx, mediaFileId);
    if (!converted)
      throw new AppError('precondition_failed', 'the disc has no completed conversion; refusing to delete it');
    if (!converted.outputPath)
      throw new AppError('precondition_failed', 'the completed conversion has no recorded output; refusing to delete');
    const outputPath = resolve(converted.outputPath);
    if (isWithin(outputPath, sourcePath))
      throw new AppError(
        'precondition_failed',
        `refusing to delete ${sourcePath}: the converted ${outputPath} is in it`,
      );
    const output = await stat(outputPath).catch(() => null);
    if (!output?.isFile() || output.size === 0)
      throw new AppError(
        'precondition_failed',
        `refusing to delete ${sourcePath}: the converted ${outputPath} is gone`,
      );
    return outputPath;
  };

  const removeSource = async (mediaFileId: number): Promise<void> => {
    const disc = loadDiscRow(ctx, mediaFileId);
    const path = resolve(disc.row.path);
    if (path === resolve(disc.rootPath) || path === resolve('/'))
      throw new AppError('precondition_failed', `refusing to delete ${path}: it is a library root`);
    await requireConvertedOutput(mediaFileId, path);

    const torrent = await ctx.services.downloadClient.findTorrentByPath(path);
    const torrentContent = torrent
      ? resolve(await ctx.services.pathMappings.toLocal('qbittorrent', torrent.contentPath))
      : null;
    if (torrent && torrentContent && path !== torrentContent && isWithin(path, torrentContent))
      throw new AppError(
        'precondition_failed',
        `refusing to delete torrent "${torrent.name}": it holds more than ${path} (${torrentContent})`,
      );
    const ownedTorrent = torrent && torrentContent && isWithin(torrentContent, path) ? torrent : null;
    if (ownedTorrent) await ctx.services.downloadClient.deleteTorrent(ownedTorrent.hash, true);
    if (!ownedTorrent || torrentContent !== path)
      await rm(path, { recursive: disc.kind === 'bdmv', force: !!ownedTorrent });
    const message = ownedTorrent ? `removed torrent "${ownedTorrent.name}" and its files` : `deleted ${path}`;
    log.info('BDMV source deleted', { mediaFileId, path, torrent: ownedTorrent?.hash ?? null });
    await ctx.services.jobs.addHistory({
      event: 'source_deleted',
      path,
      message,
      mediaFileId,
      data: ownedTorrent ? { torrentHash: ownedTorrent.hash } : null,
    });
  };

  const deleteSource = async (mediaFileId: number): Promise<void> => {
    const decision = latestDecisionQuery(ctx.db, mediaFileId, 'delete_source');
    if (decision?.state !== 'resolved' || decision.choice?.kind !== 'delete_source' || !decision.choice.confirm)
      throw new AppError('precondition_failed', 'deleting a source needs a confirmed delete_source decision');
    await removeSource(mediaFileId);
  };

  const reevaluate = async (decision: BdmvDecision): Promise<void> => {
    try {
      const disc = loadDiscRow(ctx, decision.mediaFileId);
      const check = await ctx.services.media.checkPath(disc.row.path, { trigger: 'manual' });
      log.info('BDMV disc re-evaluated after a decision', {
        decisionId: decision.id,
        action: check.action,
        jobId: check.jobId,
      });
    } catch (error) {
      log.error('re-evaluating a BDMV disc after a decision failed', { decisionId: decision.id, error });
    }
  };

  return {
    detect: (path) =>
      detectDisc(path, async (isoPath) => {
        try {
          return findEntry(await isoReader.entries(isoPath), 'BDMV/index.bdmv') !== null;
        } catch (error) {
          log.warn('could not list the .iso, treating it as a Blu-ray image', { path: isoPath, error });
          return true;
        }
      }),

    analyze: async (mediaFileId) => {
      const disc = loadDiscRow(ctx, mediaFileId);
      const settings = ctx.settings.section('bdmv');
      const analysis = await analyzeDisc(await openDisc(disc.row.path, disc.kind, isoReader), pickOptions(settings));
      const resolvedTitle = latestDecisionQuery(ctx.db, mediaFileId, 'main_title')?.state === 'resolved';
      return {
        mediaFileId,
        path: disc.row.path,
        kind: disc.kind,
        encrypted: analysis.encryption.encrypted,
        encryptionMarkers: analysis.encryption.markers,
        volumeLabel: analysis.volumeLabel,
        playlists: playlistViews(analysis),
        mainPlaylist: analysis.pick.main?.name ?? null,
        needsDecision: analysis.pick.ambiguous && settings.onAmbiguous === 'ask' && !resolvedTitle,
      };
    },

    evaluate: (mediaFileId) => planner.evaluate(mediaFileId),

    execute: createBdmvExecutor(ctx, { planner, log, tempRoot }),

    listDecisions: async (query) => listDecisionsQuery(ctx.db, query.state),

    getDecision,

    resolveDecision: async (id, choice) => {
      const decision = await getDecision(id);
      if (decision.kind !== choice.kind)
        throw new AppError('validation', `decision ${id} is a ${decision.kind} decision, not ${choice.kind}`);
      if (decision.state !== 'pending')
        throw new AppError('conflict', `BDMV decision ${decision.id} is already ${decision.state}`);
      const invalid = choice.kind === 'main_title' ? mainTitleChoiceError(decision, choice) : null;
      if (invalid) throw new AppError('unprocessable', `decision ${id}: ${invalid}`);
      if (choice.kind === 'delete_source' && choice.confirm) await removeSource(decision.mediaFileId);
      await closePending(decision, 'resolved', choice);
      if (choice.kind !== 'delete_source') await reevaluate(decision);
      return getDecision(id);
    },

    dismissDecision: async (id) => {
      const decision = await getDecision(id);
      await closePending(decision, 'dismissed', null);
      if (decision.kind !== 'delete_source')
        await ctx.services.media
          .setIgnored(decision.mediaFileId, true, 'BDMV decision dismissed')
          .catch((error: unknown) => log.error('ignoring a dismissed BDMV disc failed', { decisionId: id, error }));
      return getDecision(id);
    },

    offerSourceDeletion: async (mediaFileId, torrent) => {
      if (!ctx.settings.section('bdmv').deleteSourceWhenSeeded) return null;
      const converted = completedBdmvJob(ctx, mediaFileId);
      if (!converted) return null;
      const existing = latestDecisionQuery(ctx.db, mediaFileId, 'delete_source');
      if (existing) return existing.state === 'pending' ? existing : null;
      const disc = loadDiscRow(ctx, mediaFileId);
      const decisionId = insertDecision(ctx.db, {
        mediaFileId,
        kind: 'delete_source',
        message: deleteSourceMessage(torrent, disc.row.path, converted.outputPath),
      });
      log.info('offering to delete a seeded BDMV source', { mediaFileId, decisionId, torrent: torrent.hash });
      ctx.events.emit('bdmv.decision', { decisionId, mediaFileId });
      return getDecision(decisionId);
    },

    deleteSource,
  };
}
