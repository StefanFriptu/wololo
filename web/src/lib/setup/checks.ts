import { api } from '#lib/api/client.ts';
import { errorMessage } from '#lib/api/errorMessage.ts';
import { testConnection } from '#lib/api/testConnection.ts';
import { PATH_SCOPE_LABELS } from '#lib/labels.ts';
import type { ArrInstance, PathMappingInput } from '#lib/shared.ts';
import { explainWebhookFailure } from './explainWebhookFailure.ts';
import { libraryFolderChecks } from './libraryFolderChecks.ts';
import type { SetupCheck } from './SetupCheck.ts';

const REQUIRED_TOOLS = ['ffmpeg', 'ffprobe'] as const;
const DISC_TOOLS = ['mkvmerge', '7z'] as const;

function failed(key: string, title: string, error: unknown, fixStep: SetupCheck['fixStep']): SetupCheck {
  return { key, state: 'bad', title, detail: errorMessage(error), fixStep };
}

export async function toolChecks(): Promise<SetupCheck[]> {
  try {
    const { tools } = await api('GET /api/v1/system/status');
    const describe = (names: readonly string[]) =>
      names.map((name) => {
        const tool = tools.find((entry) => entry.name === name);
        return tool?.available ? `${name} ${tool.version ?? ''}`.trim() : null;
      });
    const required = describe(REQUIRED_TOOLS);
    const disc = describe(DISC_TOOLS);
    const missing = (names: readonly string[], found: (string | null)[]) => names.filter((_, index) => !found[index]);
    return [
      required.every(Boolean)
        ? { key: 'tools', state: 'ok', title: 'Media tools installed', detail: required.join(', ') }
        : {
            key: 'tools',
            state: 'bad',
            title: `Missing ${missing(REQUIRED_TOOLS, required).join(' and ')}`,
            detail: 'Wololo cannot read or convert files without them. The Docker image ships them.',
            fixStep: 'welcome',
          },
      disc.every(Boolean)
        ? { key: 'disc-tools', state: 'ok', title: 'Blu-ray tools installed', detail: disc.join(', ') }
        : {
            key: 'disc-tools',
            state: 'warn',
            title: `Missing ${missing(DISC_TOOLS, disc).join(' and ')}`,
            detail: 'Needed only to turn Blu-ray folders and .iso images into MKV files. The Docker image ships them.',
          },
    ];
  } catch (error) {
    return [failed('tools', 'Could not read the installed tools', error, 'welcome')];
  }
}

export async function playerChecks(): Promise<SetupCheck[]> {
  try {
    const profiles = await api('GET /api/v1/profiles');
    if (profiles.length === 0) {
      return [
        {
          key: 'players',
          state: 'bad',
          title: 'No player yet',
          detail: 'Add the TVs you watch on.',
          fixStep: 'players',
        },
      ];
    }
    const names = profiles.map((profile) => profile.name).join(', ');
    return [
      {
        key: 'players',
        state: 'ok',
        title: `${profiles.length} player${profiles.length === 1 ? '' : 's'}`,
        detail: names,
      },
    ];
  } catch (error) {
    return [failed('players', 'Could not read the players', error, 'players')];
  }
}

export async function folderChecks(): Promise<SetupCheck[]> {
  try {
    const libraries = await api('GET /api/v1/libraries');
    if (libraries.length === 0) {
      return [
        {
          key: 'folders',
          state: 'bad',
          title: 'No media folder yet',
          detail: 'Add your Movies and TV folders.',
          fixStep: 'media',
        },
      ];
    }
    return libraryFolderChecks(libraries);
  } catch (error) {
    return [failed('folders', 'Could not read the media folders', error, 'media')];
  }
}

interface ArrCheckOptions {
  address: string;
  addWebhook: boolean;
}

export interface ArrCheckResult {
  checks: SetupCheck[];
  suggestion: PathMappingInput | null;
}

export async function arrChecks(instance: ArrInstance, options: ArrCheckOptions): Promise<ArrCheckResult> {
  const service = PATH_SCOPE_LABELS[instance.kind];
  const prefix = `arr-${instance.id}`;
  const params = { id: instance.id };
  const connection = await testConnection(() =>
    api('POST /api/v1/arr/test', { body: { ...instance, id: instance.id } }),
  );
  if (!connection.ok) {
    return {
      checks: [
        {
          key: `${prefix}-connection`,
          state: 'bad',
          title: `${instance.name}: cannot connect`,
          detail: connection.message,
          fixStep: 'arr',
        },
      ],
      suggestion: null,
    };
  }
  let suggestion: PathMappingInput | null = null;
  const rows: SetupCheck[] = [
    { key: `${prefix}-connection`, state: 'ok', title: `${instance.name}: ${connection.message}` },
  ];

  try {
    const webhook = options.addWebhook
      ? await api('PUT /api/v1/arr/:id/webhook', { params, body: { address: options.address } })
      : await api('GET /api/v1/arr/:id/webhook', { params });
    rows.push(
      webhook.configured && webhook.triggersOk
        ? {
            key: `${prefix}-webhook`,
            state: 'ok',
            title: `Webhook in ${service} → Connect`,
            detail: 'Named "Wololo", sends On Import and On Upgrade',
          }
        : {
            key: `${prefix}-webhook`,
            state: 'bad',
            title: webhook.configured
              ? `${service}'s webhook misses On Import or On Upgrade`
              : `No Wololo webhook in ${service}`,
            detail: `Let Wololo add it, or add it in ${service} → Settings → Connect.`,
            fixStep: 'arr',
          },
    );
    if (webhook.configured) {
      const test = await api('POST /api/v1/arr/:id/webhook/test', { params });
      rows.push(
        test.received
          ? {
              key: `${prefix}-event`,
              state: 'ok',
              title: `${service}'s test event arrived`,
              detail: `${service} can reach Wololo on your network`,
            }
          : {
              key: `${prefix}-event`,
              state: 'bad',
              title: `${service} can't reach Wololo`,
              detail:
                explainWebhookFailure({ service, address: options.address, message: test.message }) ?? test.message,
              fixStep: 'arr',
            },
      );
    }
  } catch (error) {
    rows.push(failed(`${prefix}-webhook`, `Could not set up the webhook in ${service}`, error, 'arr'));
  }

  try {
    const paths = await api('GET /api/v1/arr/:id/pathcheck', { params });
    suggestion = paths.suggestion;
    const name = paths.remotePath?.split(/[\\/]/).pop();
    rows.push(
      paths.ok
        ? {
            key: `${prefix}-paths`,
            state: 'ok',
            title: 'Folders match',
            detail: paths.remotePath ? `Found "${name}" at ${paths.localPath}` : paths.message,
          }
        : {
            key: `${prefix}-paths`,
            state: 'bad',
            title: `Folders don't match`,
            detail: paths.suggestion
              ? `${service}'s ${paths.suggestion.remotePath} looks like ${paths.suggestion.localPath} here.`
              : paths.message,
            fixStep: 'arr',
          },
    );
  } catch (error) {
    rows.push(failed(`${prefix}-paths`, 'Could not compare the folders', error, 'arr'));
  }
  return { checks: rows, suggestion };
}

export async function plexChecks(): Promise<SetupCheck[]> {
  try {
    const plex = await api('GET /api/v1/plex');
    if (!plex.signedIn || !plex.serverUrl) return [];
    const test = await api('POST /api/v1/plex/test');
    if (!test.ok)
      return [
        {
          key: 'plex',
          state: 'bad',
          title: `Plex: ${plex.serverName ?? 'server'} unreachable`,
          detail: test.message,
          fixStep: 'plex',
        },
      ];
    const sections = (await api('GET /api/v1/plex/sections')).filter(
      (section) => section.type === 'movie' || section.type === 'show',
    );
    return [
      {
        key: 'plex',
        state: sections.length > 0 ? 'ok' : 'warn',
        title: `Plex: ${test.message}`,
        detail:
          sections.length > 0
            ? `Sections: ${sections.map((section) => section.title).join(', ')}`
            : 'No movie or TV section on this server',
        fixStep: sections.length > 0 ? null : 'plex',
      },
    ];
  } catch (error) {
    return [failed('plex', 'Could not check Plex', error, 'plex')];
  }
}

export async function downloadClientChecks(): Promise<SetupCheck[]> {
  try {
    const client = await api('GET /api/v1/downloadclient');
    if (!client) return [];
    const test = await api('POST /api/v1/downloadclient/test', { body: client });
    return [
      test.ok
        ? { key: 'qbittorrent', state: 'ok', title: `qBittorrent: ${test.message}` }
        : {
            key: 'qbittorrent',
            state: 'bad',
            title: 'qBittorrent: cannot log in',
            detail: test.message,
            fixStep: 'downloadClient',
          },
    ];
  } catch (error) {
    return [failed('qbittorrent', 'Could not check qBittorrent', error, 'downloadClient')];
  }
}

export async function libraryChecks(): Promise<SetupCheck[]> {
  try {
    const stats = await api('GET /api/v1/media/stats');
    if (stats.total === 0) {
      return [
        {
          key: 'library',
          state: 'warn',
          title: 'No file checked yet',
          detail: 'Start a scan to see what your players can play.',
        },
      ];
    }
    const { compatible, needs_work: needsWork, blocked, failed: broken } = stats.byStatus;
    return [
      {
        key: 'library',
        state: broken > 0 ? 'warn' : 'ok',
        title: `${stats.total} files checked`,
        detail: `${compatible} play as they are · ${needsWork} need converting · ${blocked} need a decision${broken > 0 ? ` · ${broken} could not be read` : ''}`,
      },
    ];
  } catch (error) {
    return [failed('library', 'Could not read the library', error, null)];
  }
}
