import { z } from 'zod';
import type { CheckAction } from '../../contracts/probe-scan.ts';
import type { RadarrWebhookPayload, SonarrWebhookPayload, WebhookResponse } from '../../shared/api-types.ts';
import type { ArrInstance, ArrKind } from '../../shared/domain.ts';
import { joinRemotePath } from './path-map.ts';

const optional = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? undefined);

const languageSchema = z.looseObject({ id: z.number(), name: z.string() });
const fileSchema = z.looseObject({
  id: z.number().int(),
  relativePath: optional(z.string()),
  path: optional(z.string()),
  size: optional(z.number()),
});

const commonFields = {
  eventType: z.string().min(1),
  instanceName: optional(z.string()),
  applicationUrl: optional(z.string()),
  isUpgrade: optional(z.boolean()),
  downloadClient: optional(z.string()),
  downloadId: optional(z.string()),
};

/** Unknown fields pass through; nulls (older Radarr/Sonarr builds) count as absent. */
export const radarrWebhookSchema = z.looseObject({
  ...commonFields,
  downloadClientType: optional(z.string()),
  movie: optional(
    z.looseObject({
      id: z.number().int(),
      title: z.string(),
      year: optional(z.number()),
      folderPath: optional(z.string()),
      filePath: optional(z.string()),
      tmdbId: optional(z.number()),
      imdbId: optional(z.string()),
      originalLanguage: optional(languageSchema),
    }),
  ),
  movieFile: optional(fileSchema),
}) satisfies z.ZodType<RadarrWebhookPayload>;

export const sonarrWebhookSchema = z.looseObject({
  ...commonFields,
  series: optional(
    z.looseObject({
      id: z.number().int(),
      title: z.string(),
      path: optional(z.string()),
      tvdbId: optional(z.number()),
      originalLanguage: optional(languageSchema),
    }),
  ),
  episodes: optional(
    z.array(
      z.looseObject({
        id: z.number().int(),
        episodeNumber: z.number().int(),
        seasonNumber: z.number().int(),
        title: optional(z.string()),
      }),
    ),
  ),
  episodeFile: optional(fileSchema),
  episodeFiles: optional(z.array(fileSchema)),
}) satisfies z.ZodType<SonarrWebhookPayload>;

export interface ImportedFile {
  remotePath: string;
  fileId: number | null;
}

export interface WebhookImport {
  itemId: number;
  /** Language name as sent ("English"); normalise with normalizeLanguage. */
  originalLanguage: string | null;
  files: ImportedFile[];
}

type FileFields = z.infer<typeof fileSchema>;

function fileLocation(file: FileFields, folder: string | undefined): string | null {
  if (file.path) return file.path;
  if (folder && file.relativePath) return joinRemotePath(folder, file.relativePath);
  return null;
}

function dedupe(files: ImportedFile[]): ImportedFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.remotePath)) return false;
    seen.add(file.remotePath);
    return true;
  });
}

/** Radarr Download payload -> movie id, original language and the imported file (path, else folderPath + relativePath). */
export function radarrImport(payload: z.infer<typeof radarrWebhookSchema>): WebhookImport | null {
  const movie = payload.movie;
  if (!movie) return null;
  const fromFile = payload.movieFile ? fileLocation(payload.movieFile, movie.folderPath) : null;
  const remotePath = fromFile ?? movie.filePath ?? null;
  return {
    itemId: movie.id,
    originalLanguage: movie.originalLanguage?.name ?? null,
    files: remotePath ? [{ remotePath, fileId: payload.movieFile?.id ?? null }] : [],
  };
}

/** Sonarr Download payload -> series id, original language and every imported episode file. */
export function sonarrImport(payload: z.infer<typeof sonarrWebhookSchema>): WebhookImport | null {
  const series = payload.series;
  if (!series) return null;
  const candidates = [payload.episodeFile, ...(payload.episodeFiles ?? [])].filter(
    (file): file is FileFields => file != null,
  );
  const files = candidates.flatMap((file) => {
    const remotePath = fileLocation(file, series.path);
    return remotePath ? [{ remotePath, fileId: file.id }] : [];
  });
  return { itemId: series.id, originalLanguage: series.originalLanguage?.name ?? null, files: dedupe(files) };
}

export type InstanceResolution = { ok: true; instance: ArrInstance } | { ok: false; reason: string };

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * ?instance=<id> wins; without it: the only enabled instance of the kind, else the one named payload.instanceName,
 * else the one whose url equals payload.applicationUrl.
 */
export function resolveWebhookInstance(
  instances: readonly ArrInstance[],
  request: { kind: ArrKind; instanceId: number | null; instanceName?: string; applicationUrl?: string },
): InstanceResolution {
  const { kind, instanceId, instanceName, applicationUrl } = request;
  if (instanceId != null) {
    const byId = instances.find((instance) => instance.id === instanceId);
    if (!byId) return { ok: false, reason: `unknown ${kind} instance ${instanceId}` };
    if (byId.kind !== kind) return { ok: false, reason: `instance ${instanceId} is a ${byId.kind} instance` };
    return { ok: true, instance: byId };
  }
  const ofKind = instances.filter((instance) => instance.kind === kind);
  if (ofKind.length === 0) return { ok: false, reason: `no ${kind} instance configured` };
  const enabled = ofKind.filter((instance) => instance.enabled);
  if (enabled.length === 1 && enabled[0]) return { ok: true, instance: enabled[0] };
  const byName = instanceName ? ofKind.find((instance) => instance.name === instanceName) : undefined;
  if (byName) return { ok: true, instance: byName };
  const byUrl = applicationUrl
    ? ofKind.find((instance) => normalizeUrl(instance.url) === normalizeUrl(applicationUrl))
    : undefined;
  if (byUrl) return { ok: true, instance: byUrl };
  return { ok: false, reason: `cannot tell which ${kind} instance sent this; add ?instance=<id> to the webhook URL` };
}

type WebhookAction = WebhookResponse['action'];

const ACTION_BY_CHECK: Readonly<Record<CheckAction, WebhookAction>> = {
  compatible: 'compatible',
  queued: 'queued',
  dry_run: 'dry_run',
  unknown_path: 'unknown_path',
  ignored: 'ignored',
  blocked: 'blocked',
  decision_required: 'decision_required',
  failed: 'error',
};

export function webhookActionFor(action: CheckAction): WebhookAction {
  return ACTION_BY_CHECK[action];
}

const ACTION_PRIORITY: readonly WebhookAction[] = [
  'error',
  'queued',
  'decision_required',
  'blocked',
  'dry_run',
  'unknown_path',
  'ignored',
  'compatible',
  'test',
];

/** The most significant action of a multi-file import (an error anywhere wins, then queued, ...). */
export function combineWebhookActions(actions: readonly WebhookAction[]): WebhookAction {
  const found = ACTION_PRIORITY.find((action) => actions.includes(action));
  return found ?? 'ignored';
}
