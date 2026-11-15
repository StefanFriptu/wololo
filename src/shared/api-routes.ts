import type { RouteKey } from './api-types.ts';

export const MODULE_KEYS = ['core', 'probe-scan', 'rules-ffmpeg', 'jobs', 'integrations', 'bdmv', 'platform'] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface RouteMeta {
  /** Module that implements the handler (see docs/ARCHITECTURE.md). */
  module: ModuleKey;
  /** "none" routes skip the API key check. */
  auth: 'apikey' | 'none';
  responseType: 'json' | 'empty' | 'text' | 'blob' | 'html' | 'sse';
  summary: string;
}

const json = (module: ModuleKey, summary: string): RouteMeta => ({
  module,
  auth: 'apikey',
  responseType: 'json',
  summary,
});

const empty = (module: ModuleKey, summary: string): RouteMeta => ({
  module,
  auth: 'apikey',
  responseType: 'empty',
  summary,
});

export const API_ROUTE_META: { readonly [K in RouteKey]: RouteMeta } = {
  'GET /health': {
    module: 'core',
    auth: 'none',
    responseType: 'json',
    summary: 'Liveness probe',
  },
  'GET /api/v1/events': {
    module: 'core',
    auth: 'apikey',
    responseType: 'sse',
    summary: 'Server-sent events stream (use ?apikey=)',
  },

  'GET /api/v1/system/status': json('platform', 'Version, runtime, paths, tool availability'),
  'GET /api/v1/system/health': json('platform', 'Health warnings (missing tools, unreachable roots)'),
  'GET /api/v1/system/tasks': json('probe-scan', 'Scheduled tasks'),
  'PUT /api/v1/system/tasks/:name': json('probe-scan', 'Change a task interval or enable it'),
  'POST /api/v1/system/tasks/:name/run': json('probe-scan', 'Run a task now'),
  'GET /api/v1/system/logs': json('core', 'Recent log entries from the in-memory ring buffer'),
  'GET /api/v1/system/logs/files': json('core', 'Log files under <config>/logs'),
  'GET /api/v1/system/logs/files/:name': {
    module: 'core',
    auth: 'apikey',
    responseType: 'text',
    summary: 'Download a log file',
  },
  'GET /api/v1/system/backups': json('platform', 'List backups'),
  'POST /api/v1/system/backups': json('platform', 'Create a backup (zip of database + config.json)'),
  'GET /api/v1/system/backups/:name': {
    module: 'platform',
    auth: 'apikey',
    responseType: 'blob',
    summary: 'Download a backup',
  },
  'DELETE /api/v1/system/backups/:name': empty('platform', 'Delete a backup'),
  'POST /api/v1/system/backups/:name/restore': json('platform', 'Restore a stored backup'),
  'POST /api/v1/system/backups/restore': json('platform', 'Restore an uploaded backup (multipart "file")'),
  'POST /api/v1/system/restart': empty('platform', 'Exit so the container restart policy restarts Wololo'),
  'GET /api/v1/openapi.json': json('platform', 'OpenAPI 3.1 document'),
  'GET /api/v1/docs': {
    module: 'platform',
    auth: 'none',
    responseType: 'html',
    summary: 'API documentation page',
  },

  'GET /api/v1/settings': json('core', 'Runtime settings'),
  'PUT /api/v1/settings': json('core', 'Update runtime settings (deep partial)'),
  'GET /api/v1/settings/general': json('core', 'Bootstrap config (port, URL base, API key, log level)'),
  'PUT /api/v1/settings/general': json('core', 'Update bootstrap config'),
  'POST /api/v1/settings/general/apikey': json('core', 'Regenerate the API key'),

  'GET /api/v1/libraries': json('probe-scan', 'List libraries'),
  'POST /api/v1/libraries': json('probe-scan', 'Create a library'),
  'GET /api/v1/libraries/:id': json('probe-scan', 'Get a library'),
  'PUT /api/v1/libraries/:id': json('probe-scan', 'Update a library'),
  'DELETE /api/v1/libraries/:id': empty('probe-scan', 'Delete a library (files on disk untouched)'),
  'GET /api/v1/filesystem': json('probe-scan', 'Browse directories for the root folder picker'),
  'GET /api/v1/media': json('probe-scan', 'List media files with filters'),
  'GET /api/v1/media/stats': json('probe-scan', 'Counts per status and failing codec'),
  'GET /api/v1/media/:id': json('probe-scan', 'Media file detail with streams and plan'),
  'POST /api/v1/media/:id/probe': json('probe-scan', 'Re-probe and re-evaluate a file'),
  'GET /api/v1/media/:id/plan': json('probe-scan', 'Conversion plan preview with current profiles'),
  'PUT /api/v1/media/:id/ignore': json('probe-scan', 'Ignore or un-ignore a file'),
  'POST /api/v1/scans': json('probe-scan', 'Start a library scan'),
  'GET /api/v1/scans/current': json('probe-scan', 'Current or last scan'),
  'DELETE /api/v1/scans/current': empty('probe-scan', 'Cancel the running scan'),
  'GET /api/v1/dryrun': json('probe-scan', 'Dry-run report: files per failing codec, time and space'),

  'GET /api/v1/profiles': json('rules-ffmpeg', 'List device profiles'),
  'POST /api/v1/profiles': json('rules-ffmpeg', 'Create a device profile'),
  'GET /api/v1/profiles/codecs': json('rules-ffmpeg', 'Known codecs for the profile editor'),
  'GET /api/v1/profiles/:id': json('rules-ffmpeg', 'Get a device profile'),
  'PUT /api/v1/profiles/:id': json('rules-ffmpeg', 'Update a device profile (bumps version)'),
  'DELETE /api/v1/profiles/:id': empty('rules-ffmpeg', 'Delete an unassigned device profile'),
  'POST /api/v1/profiles/:id/clone': json('rules-ffmpeg', 'Clone a device profile'),

  'GET /api/v1/queue': json('jobs', 'Queue state and active jobs'),
  'POST /api/v1/queue/pause': json('jobs', 'Pause the queue'),
  'POST /api/v1/queue/resume': json('jobs', 'Resume the queue'),
  'GET /api/v1/jobs': json('jobs', 'List jobs'),
  'POST /api/v1/jobs': json('jobs', 'Queue media files manually'),
  'GET /api/v1/jobs/:id': json('jobs', 'Job detail with before/after streams'),
  'GET /api/v1/jobs/:id/log': {
    module: 'jobs',
    auth: 'apikey',
    responseType: 'text',
    summary: 'Full ffmpeg/mkvmerge log of a job',
  },
  'POST /api/v1/jobs/:id/cancel': json('jobs', 'Cancel a queued or running job'),
  'POST /api/v1/jobs/:id/retry': json('jobs', 'Retry a failed or cancelled job'),
  'DELETE /api/v1/jobs/:id': empty('jobs', 'Remove a finished job'),
  'GET /api/v1/history': json('jobs', 'Job history events'),
  'GET /api/v1/recyclebin': json('jobs', 'Recycle bin entries'),
  'POST /api/v1/recyclebin/:id/restore': json('jobs', 'Restore a recycled original'),
  'DELETE /api/v1/recyclebin/:id': empty('jobs', 'Delete a recycled original now'),
  'POST /api/v1/recyclebin/purge': json('jobs', 'Purge expired (or all) recycle bin entries'),

  'GET /api/v1/arr': json('integrations', 'List Radarr/Sonarr instances'),
  'POST /api/v1/arr': json('integrations', 'Add a Radarr/Sonarr instance'),
  'POST /api/v1/arr/test': json('integrations', 'Test a Radarr/Sonarr connection'),
  'GET /api/v1/arr/:id': json('integrations', 'Get a Radarr/Sonarr instance'),
  'PUT /api/v1/arr/:id': json('integrations', 'Update a Radarr/Sonarr instance'),
  'DELETE /api/v1/arr/:id': empty('integrations', 'Delete a Radarr/Sonarr instance'),
  'GET /api/v1/arr/:id/rootfolders': json('integrations', 'Root folders with local path mapping'),
  'GET /api/v1/arr/:id/qualityprofiles': json('integrations', 'Radarr/Sonarr quality profiles'),
  'GET /api/v1/arr/:id/lookup': json('integrations', 'Search Radarr for a movie (BDMV movie_match decision)'),
  'POST /api/v1/webhook/radarr': json('integrations', 'Radarr webhook (Test, Download incl. upgrades); ?instance=<id>'),
  'POST /api/v1/webhook/sonarr': json('integrations', 'Sonarr webhook (Test, Download incl. upgrades); ?instance=<id>'),
  'GET /api/v1/plex': json('integrations', 'Plex connection state'),
  'PUT /api/v1/plex': json('integrations', 'Select server and Plex options'),
  'DELETE /api/v1/plex': json('integrations', 'Sign out of Plex'),
  'POST /api/v1/plex/pin': json('integrations', 'Start the plex.tv PIN sign-in'),
  'GET /api/v1/plex/pin/:id': json('integrations', 'Poll the plex.tv PIN'),
  'GET /api/v1/plex/servers': json('integrations', 'Servers available to the signed-in account'),
  'GET /api/v1/plex/sections': json('integrations', 'Library sections of the selected server'),
  'POST /api/v1/plex/test': json('integrations', 'Test the selected Plex server'),
  'GET /api/v1/plex/sessions': json('integrations', 'Active Plex playback sessions'),
  'GET /api/v1/downloadclient': json('integrations', 'qBittorrent connection'),
  'PUT /api/v1/downloadclient': json('integrations', 'Save the qBittorrent connection'),
  'DELETE /api/v1/downloadclient': empty('integrations', 'Remove the qBittorrent connection'),
  'POST /api/v1/downloadclient/test': json('integrations', 'Test a qBittorrent connection'),
  'GET /api/v1/pathmappings': json('integrations', 'List path mappings'),
  'POST /api/v1/pathmappings': json('integrations', 'Add a path mapping'),
  'PUT /api/v1/pathmappings/:id': json('integrations', 'Update a path mapping'),
  'DELETE /api/v1/pathmappings/:id': empty('integrations', 'Delete a path mapping'),

  'GET /api/v1/bdmv/decisions': json('bdmv', 'BDMV decisions (ambiguous title, low match score)'),
  'GET /api/v1/bdmv/decisions/:id': json('bdmv', 'Get a BDMV decision'),
  'POST /api/v1/bdmv/decisions/:id/resolve': json('bdmv', 'Resolve a BDMV decision'),
  'POST /api/v1/bdmv/decisions/:id/dismiss': json('bdmv', 'Dismiss a BDMV decision'),
  'GET /api/v1/bdmv/discs/:id': json('bdmv', 'Disc analysis for a BDMV/ISO media file'),
};

export function splitRouteKey(key: RouteKey): { method: string; path: string } {
  const space = key.indexOf(' ');
  return { method: key.slice(0, space), path: key.slice(space + 1) };
}

export function routesOf(module: ModuleKey): RouteKey[] {
  return (Object.keys(API_ROUTE_META) as RouteKey[]).filter((key) => API_ROUTE_META[key].module === module);
}
