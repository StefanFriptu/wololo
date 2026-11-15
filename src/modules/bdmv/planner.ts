import { basename, dirname, resolve, sep } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { AppContext } from '../../app/context.ts';
import type { BdmvEvaluation, MplsPlaylist } from '../../contracts/bdmv.ts';
import { AppError, errorMessage } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import { jobs, libraryRoots, type MediaFileRow, mediaFiles } from '../../db/schema.ts';
import type { BdmvPlaylistView } from '../../shared/api-types.ts';
import type {
  ArrInstance,
  BdmvDecision,
  BdmvDecisionKind,
  BdmvJobPlan,
  BdmvOutputTitle,
  BdmvTitleCandidate,
  Library,
  MovieMatchCandidate,
  ProbeResult,
} from '../../shared/domain.ts';
import type { Settings } from '../../shared/settings.ts';
import { insertDecision, latestDecisionQuery } from './decisions.ts';
import { analyzeDisc, clipBytes, type DiscAnalysis, type DiscKind, openDisc } from './disc.ts';
import type { SevenZipIsoReader } from './iso.ts';
import { buildOutputPaths } from './mkvmerge.ts';
import { cleanDiscName, defaultEditionNames, titleCandidate } from './titles.ts';

export interface DiscRow {
  row: MediaFileRow;
  kind: DiscKind;
  rootPath: string;
}

export function loadDiscRow(ctx: AppContext, mediaFileId: number): DiscRow {
  const found = ctx.db
    .select({ row: mediaFiles, rootPath: libraryRoots.path })
    .from(mediaFiles)
    .leftJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
    .where(eq(mediaFiles.id, mediaFileId))
    .get();
  if (!found) throw new AppError('not_found', `media file ${mediaFileId} not found`);
  const { row } = found;
  if (row.kind !== 'bdmv' && row.kind !== 'iso')
    throw new AppError('unprocessable', `media file ${mediaFileId} is not a Blu-ray disc (${row.kind})`);
  return { row, kind: row.kind, rootPath: found.rootPath ?? dirname(row.path) };
}

export function completedBdmvJob(
  ctx: AppContext,
  mediaFileId: number,
): { id: number; outputPath: string | null } | null {
  return (
    ctx.db
      .select({ id: jobs.id, outputPath: jobs.outputPath })
      .from(jobs)
      .where(and(eq(jobs.mediaFileId, mediaFileId), eq(jobs.type, 'bdmv'), eq(jobs.state, 'completed')))
      .orderBy(desc(jobs.id))
      .limit(1)
      .get() ?? null
  );
}

export function pickOptions(settings: Settings['bdmv']) {
  return {
    ambiguityPercent: settings.ambiguityPercent,
    extrasMinMinutes: settings.extras.enabled ? settings.extras.minMinutes : null,
  };
}

export function playlistViews(analysis: DiscAnalysis): BdmvPlaylistView[] {
  const { pick, duplicateOf } = analysis;
  const candidates = new Set(pick.candidates.map((p) => p.name));
  const extras = new Set(pick.extras.map((p) => p.name));
  const role = (name: string): BdmvPlaylistView['role'] => {
    if (name === pick.main?.name) return 'main';
    if (candidates.has(name)) return 'candidate';
    if (extras.has(name)) return 'extra';
    return 'ignored';
  };
  return [...analysis.playlists]
    .sort((a, b) => b.durationSec - a.durationSec || a.name.localeCompare(b.name))
    .map((playlist) => ({
      ...titleCandidate(playlist),
      duplicateOf: duplicateOf[playlist.name] ?? null,
      role: role(playlist.name),
    }));
}

/**
 * Pure: the playlist's stream table is the authority for disc languages (ffmpeg often leaves PGS untagged), so each
 * probed stream takes the MPLS language of its PID before the rules engine plans on it.
 */
export function withPlaylistLanguages(probe: ProbeResult, playlist: MplsPlaylist): ProbeResult {
  const byPid = new Map(
    playlist.streams.flatMap((stream) => (stream.language ? [[stream.pid, stream.language] as const] : [])),
  );
  return {
    ...probe,
    streams: probe.streams.map((stream) => {
      const language = stream.streamId === null ? undefined : byPid.get(stream.streamId);
      return language && stream.kind !== 'video' ? { ...stream, language } : stream;
    }),
  };
}

const GENERIC_DISC_NAMES = /^(bdmv|disc\s*\d*|bd\s*\d*|bluray|blu-ray|untitled|video|movie)$/i;

/** Folder or .iso name used for the Radarr lookup; generic names fall back to the parent folder or the disc title. */
export function discLookupName(path: string, volumeLabel: string | null): string {
  const own = basename(path).replace(/\.iso$/i, '');
  if (!GENERIC_DISC_NAMES.test(own)) return own;
  const parent = basename(dirname(path));
  if (parent && parent !== sep && !GENERIC_DISC_NAMES.test(parent)) return parent;
  return volumeLabel ?? own;
}

export function isWithin(path: string, folder: string): boolean {
  const base = folder.endsWith(sep) ? folder : `${folder}${sep}`;
  return path === folder || path.startsWith(base);
}

interface TitleSelection {
  playlist: MplsPlaylist;
  role: BdmvOutputTitle['role'];
  edition: string | null;
}

export interface DiscPlan {
  evaluation: BdmvEvaluation;
  analysis: DiscAnalysis | null;
  /** bluray: probe of the main playlist (when the plan got that far). */
  probe: ProbeResult | null;
}

type Mode = 'evaluate' | 'execute';

const result = (
  status: BdmvEvaluation['status'],
  reason: string,
  extra: Partial<Omit<DiscPlan, 'evaluation'>> & { plan?: BdmvJobPlan | null; decisionId?: number | null } = {},
): DiscPlan => ({
  evaluation: { status, reason, plan: extra.plan ?? null, decisionId: extra.decisionId ?? null },
  analysis: extra.analysis ?? null,
  probe: extra.probe ?? null,
});

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

export function createDiscPlanner(ctx: AppContext, deps: { isoReader: SevenZipIsoReader; log: Logger }) {
  const { log } = deps;
  const services = ctx.services;

  /** Pending decision of this kind (reused), or a new one; never in execute mode. */
  function requireDecision(
    disc: DiscRow,
    mode: Mode,
    kind: BdmvDecisionKind,
    message: string,
    candidates: { titleCandidates?: BdmvTitleCandidate[]; movieCandidates?: MovieMatchCandidate[] },
    analysis: DiscAnalysis,
  ): DiscPlan {
    if (mode === 'execute') throw new AppError('precondition_failed', `a ${kind} decision is required: ${message}`);
    const existing = latestDecisionQuery(ctx.db, disc.row.id, kind);
    let decisionId = existing?.state === 'pending' ? existing.id : null;
    if (decisionId === null) {
      decisionId = insertDecision(ctx.db, { mediaFileId: disc.row.id, kind, message, ...candidates });
      log.info('BDMV decision required', { mediaFileId: disc.row.id, decisionId, kind, message });
      ctx.events.emit('bdmv.decision', { decisionId, mediaFileId: disc.row.id });
    }
    return result('needs_work', `waiting for a decision: ${message}`, { decisionId, analysis });
  }

  function resolvedChoice<K extends BdmvDecisionKind>(
    mediaFileId: number,
    kind: K,
  ): Extract<NonNullable<BdmvDecision['choice']>, { kind: K }> | null {
    const decision = latestDecisionQuery(ctx.db, mediaFileId, kind);
    if (decision?.state !== 'resolved' || decision.choice?.kind !== kind) return null;
    return decision.choice as Extract<NonNullable<BdmvDecision['choice']>, { kind: K }>;
  }

  function selectTitles(
    disc: DiscRow,
    analysis: DiscAnalysis,
    settings: Settings['bdmv'],
    mode: Mode,
  ): TitleSelection[] | DiscPlan {
    const { pick, parseErrors } = analysis;
    const main = pick.main as MplsPlaylist;
    const extras = pick.extras.map((playlist): TitleSelection => ({ playlist, role: 'extra', edition: null }));
    if (!pick.ambiguous && parseErrors.length === 0)
      return [{ playlist: main, role: 'main', edition: null }, ...extras];

    const byName = new Map(analysis.playlists.map((p) => [p.name, p]));
    const choice = resolvedChoice(disc.row.id, 'main_title');
    const missing = choice?.playlists.filter((name) => !byName.has(name)) ?? [];
    if (choice && missing.length === 0) {
      const chosen = choice.playlists.map((name) => byName.get(name) as MplsPlaylist);
      const titles = choice.asEditions ? chosen : chosen.slice(0, 1);
      return editionsOf(titles, choice.asEditions ? choice.editionNames : null).concat(extras);
    }
    if (!choice && parseErrors.length === 0 && settings.onAmbiguous === 'editions')
      return editionsOf(pick.candidates, {}).concat(extras);
    const names = pick.candidates.map((p) => `${p.name} (${formatDuration(p.durationSec)})`).join(', ');
    let message = `several playlists could be the main title: ${names}`;
    if (parseErrors.length > 0)
      message = `could not read ${parseErrors.join('; ')}; the main title may be among them, confirm it: ${names}`;
    if (missing.length > 0)
      message = `the chosen ${missing.join(', ')} no longer exist on the disc, choose again: ${names}`;
    return requireDecision(
      disc,
      mode,
      'main_title',
      message,
      { titleCandidates: pick.candidates.map(titleCandidate) },
      analysis,
    );
  }

  function editionsOf(playlists: readonly MplsPlaylist[], names: Record<string, string> | null): TitleSelection[] {
    const sorted = [...playlists].sort((a, b) => b.durationSec - a.durationSec);
    const defaults = defaultEditionNames(sorted);
    return sorted.map((playlist, i) => ({
      playlist,
      role: i === 0 ? 'main' : 'edition',
      edition: names === null ? null : names[playlist.name]?.trim() || defaults[playlist.name] || null,
    }));
  }

  async function resolveRadarr(library: Library): Promise<ArrInstance | null> {
    if (library.arrInstanceId !== null) {
      const instance = await services.arr.get(library.arrInstanceId).catch((error: unknown) => {
        log.warn('library Radarr instance unavailable, using the default Radarr', { libraryId: library.id, error });
        return null;
      });
      if (instance?.kind === 'radarr' && instance.enabled) return instance;
    }
    return services.arr.defaultRadarr();
  }

  async function resolveMovie(
    disc: DiscRow,
    analysis: DiscAnalysis,
    radarr: ArrInstance,
    settings: Settings['bdmv'],
    mode: Mode,
  ): Promise<MovieMatchCandidate | DiscPlan> {
    const choice = resolvedChoice(disc.row.id, 'movie_match');
    if (choice) {
      const found = await services.arr.lookupMovie(radarr.id, `tmdb:${choice.tmdbId}`);
      const movie = found.find((candidate) => candidate.tmdbId === choice.tmdbId) ?? found[0];
      if (!movie) return result('failed', `Radarr found no movie for TMDB id ${choice.tmdbId}`, { analysis });
      return movie;
    }
    const name = cleanDiscName(discLookupName(disc.row.path, analysis.volumeLabel));
    const candidates = [...(await services.arr.lookupMovie(radarr.id, name.title, name.year))].sort(
      (a, b) => b.score - a.score,
    );
    const known =
      disc.row.arrKind === 'radarr' && disc.row.arrItemId !== null
        ? candidates.find((candidate) => candidate.radarrMovieId === disc.row.arrItemId)
        : undefined;
    if (known) return known;
    const best = candidates[0];
    if (best && best.score >= settings.minMatchScore) return best;
    const lookup = name.year ? `${name.title} (${name.year})` : name.title;
    const message = best
      ? `best Radarr match for "${lookup}" is ${best.title} (${best.year ?? '?'}) with score ${best.score.toFixed(2)}`
      : `Radarr found no movie for "${lookup}"`;
    return requireDecision(disc, mode, 'movie_match', message, { movieCandidates: candidates.slice(0, 10) }, analysis);
  }

  async function resolveRootFolder(disc: DiscRow, radarr: ArrInstance, settings: Settings['bdmv']) {
    if (settings.rootFolderPath) return settings.rootFolderPath;
    const folders = (await services.arr.rootFolders(radarr.id)).filter(
      (folder): folder is typeof folder & { localPath: string } => folder.accessible && folder.localPath !== null,
    );
    const containing = folders
      .filter((folder) => isWithin(disc.rootPath, folder.localPath) || isWithin(folder.localPath, disc.rootPath))
      .sort((a, b) => b.localPath.length - a.localPath.length)[0];
    return (containing ?? folders[0])?.localPath ?? null;
  }

  async function plan(disc: DiscRow, mode: Mode, signal?: AbortSignal): Promise<DiscPlan> {
    const settings = ctx.settings.section('bdmv');
    const library = await services.libraries.get(disc.row.libraryId);
    const source = await openDisc(disc.row.path, disc.kind, deps.isoReader);
    const analysis = await analyzeDisc(source, pickOptions(settings));
    if (analysis.parseErrors.length > 0 || analysis.warnings.length > 0)
      log.warn('BDMV disc has unreadable playlist or clip files', {
        mediaFileId: disc.row.id,
        path: disc.row.path,
        parseErrors: analysis.parseErrors,
        warnings: analysis.warnings,
      });
    if (analysis.encryption.encrypted)
      return result(
        'failed',
        `disc is encrypted (${analysis.encryption.markers.join(', ')}): decrypt with MakeMKV first`,
        { analysis },
      );
    const main = analysis.pick.main;
    if (!main) {
      const unreadable = analysis.parseErrors.length > 0 ? `; could not read ${analysis.parseErrors.join('; ')}` : '';
      return result('failed', `no playable playlist found on the disc${unreadable}`, { analysis });
    }

    const titles = selectTitles(disc, analysis, settings, mode);
    if (!Array.isArray(titles)) return titles;

    const radarr = await resolveRadarr(library);
    if (!radarr) return result('failed', 'no enabled Radarr instance to identify and import the movie', { analysis });
    const movie = await resolveMovie(disc, analysis, radarr, settings, mode);
    if ('evaluation' in movie) return movie;

    const rootFolderPath = await resolveRootFolder(disc, radarr, settings);
    if (!rootFolderPath) return result('failed', `Radarr "${radarr.name}" has no accessible root folder`, { analysis });
    const outputs = buildOutputPaths(
      rootFolderPath,
      movie,
      titles.map((title) => ({ playlist: title.playlist.name, role: title.role, edition: title.edition })),
    );
    const insideSource = [rootFolderPath, ...outputs].find((path) => isWithin(resolve(path), resolve(disc.row.path)));
    if (insideSource)
      return result(
        'failed',
        `the output ${insideSource} would be inside the source disc ${disc.row.path}, which must stay untouched: ` +
          'move the disc out of the Radarr movie folder or set a BDMV output root folder',
        { analysis },
      );

    const mainTitle = titles.find((title) => title.role === 'main') ?? titles[0];
    const mainPlaylist = mainTitle?.playlist ?? main;
    const probe = withPlaylistLanguages(
      await services.probe.probe(disc.row.path, { playlist: mainPlaylist.name, signal }),
      mainPlaylist,
    );
    const profile = await services.rules.effectiveProfileForLibrary(disc.row.libraryId);
    const audioPlan = services.rules.plan({
      probe,
      profile,
      library,
      originalLanguage: disc.row.originalLanguage,
    });

    const playlists = titles.map((title) => title.playlist);
    const jobPlan: BdmvJobPlan = {
      sourcePath: disc.row.path,
      sourceKind: disc.kind,
      movie,
      radarrInstanceId: radarr.id,
      rootFolderPath,
      titles: titles.map((title, i) => ({
        playlist: title.playlist.name,
        outputPath: outputs[i] as string,
        role: title.role,
        edition: title.edition,
      })),
      audioPlan,
      dolbyVision: profile.definition.video.dolbyVision,
      estimatedOutputBytes: clipBytes(source.entries, playlists, false),
      extractBytes: disc.kind === 'iso' ? clipBytes(source.entries, playlists, true) : 0,
    };
    if (audioPlan.action === 'blocked')
      return result(
        'blocked',
        `blocked: ${audioPlan.reasons.join('; ') || 'the device profile cannot play this disc'}`,
        {
          plan: jobPlan,
          analysis,
          probe,
        },
      );
    const extrasNote = titles.length > 1 ? ` (+${titles.length - 1} more)` : '';
    return result(
      'needs_work',
      `convert ${mainPlaylist.name} (${formatDuration(mainPlaylist.durationSec)}) to ${outputs[0]}${extrasNote}`,
      { plan: jobPlan, analysis, probe },
    );
  }

  /** BdmvService.evaluate: disabled / converted / per-disc problems become a status, never an exception. */
  async function evaluate(mediaFileId: number): Promise<BdmvEvaluation> {
    const disc = loadDiscRow(ctx, mediaFileId);
    const settings = ctx.settings.section('bdmv');
    const library = await services.libraries.get(disc.row.libraryId);
    if (!settings.enabled || !library.bdmvEnabled) return result('ignored', 'BDMV conversion is disabled').evaluation;
    const converted = completedBdmvJob(ctx, mediaFileId);
    if (converted) return result('compatible', `converted to ${converted.outputPath ?? 'MKV'}`).evaluation;
    try {
      return (await plan(disc, 'evaluate')).evaluation;
    } catch (error) {
      log.warn('BDMV evaluation failed', { mediaFileId, path: disc.row.path, error });
      return result('failed', `BDMV evaluation failed: ${errorMessage(error)}`).evaluation;
    }
  }

  return { plan, evaluate, formatDuration };
}

export type DiscPlanner = ReturnType<typeof createDiscPlanner>;
