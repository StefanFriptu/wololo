import type { HealthCheck, ToolInfo } from '../../shared/api-types.ts';
import type { ToolReport } from './tools.ts';

export interface LibraryRootFact {
  library: string;
  path: string;
  /** null when the root is a readable directory, else what is wrong ("ENOENT", "not a directory"). */
  problem: string | null;
}

export interface HealthFacts {
  platform: string;
  isDocker: boolean;
  /** Effective uid, null where the platform has none. */
  uid: number | null;
  tools: ToolReport;
  libraryCount: number;
  /** Roots of enabled libraries. */
  roots: LibraryRootFact[];
  configDir: string;
  configWritable: boolean;
  /** Free bytes on the config filesystem, null when unknown. */
  configFreeBytes: number | null;
  processingEnabled: boolean;
  restorePending: boolean;
}

export const LOW_CONFIG_SPACE_BYTES = 1024 ** 3;

const MISSING_TOOL: Readonly<Record<ToolInfo['name'], { level: HealthCheck['level']; impact: string }>> = {
  ffmpeg: { level: 'error', impact: 'no audio can be converted (set WOLOLO__FFMPEG or install ffmpeg)' },
  ffprobe: { level: 'error', impact: 'media files cannot be checked (set WOLOLO__FFPROBE or install ffprobe)' },
  mkvmerge: { level: 'warning', impact: 'Blu-ray (BDMV/ISO) conversion is unavailable (install MKVToolNix)' },
  '7z': { level: 'warning', impact: 'Blu-ray .iso images cannot be read (install 7-Zip)' },
  nice: { level: 'notice', impact: 'jobs run at normal CPU priority' },
  ionice: { level: 'notice', impact: 'jobs run at normal disk priority' },
};

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function toolChecks(facts: HealthFacts): HealthCheck[] {
  const checks: HealthCheck[] = facts.tools.tools
    .filter((tool) => !tool.available && (tool.name !== 'ionice' || facts.platform === 'linux'))
    .map((tool) => ({
      source: 'tools',
      level: MISSING_TOOL[tool.name].level,
      message: `${tool.name} ${tool.path ? `at ${tool.path} cannot be run` : 'not found'}: ${MISSING_TOOL[tool.name].impact}`,
    }));
  if (facts.tools.ffmpegBluray === false) {
    checks.push({
      source: 'tools',
      level: 'warning',
      message: 'ffmpeg was built without libbluray: Blu-ray (BDMV/ISO) discs cannot be read',
    });
  }
  return checks;
}

function libraryChecks(facts: HealthFacts): HealthCheck[] {
  if (facts.libraryCount === 0) {
    return [
      {
        source: 'libraries',
        level: 'notice',
        message: 'No library yet: add your media folders (the same /data paths Radarr and Sonarr use) under Settings',
      },
    ];
  }
  return facts.roots
    .filter((root) => root.problem !== null)
    .map((root) => ({
      source: 'libraries',
      level: 'error',
      message: `Library "${root.library}": root folder ${root.path} is not reachable (${root.problem}); check the volume mount`,
    }));
}

function configChecks(facts: HealthFacts): HealthCheck[] {
  const checks: HealthCheck[] = [];
  if (!facts.configWritable) {
    checks.push({
      source: 'config',
      level: 'error',
      message: `Config folder ${facts.configDir} is not writable: check PUID/PGID and the owner of the /config volume`,
    });
  }
  if (facts.configFreeBytes !== null && facts.configFreeBytes < LOW_CONFIG_SPACE_BYTES) {
    checks.push({
      source: 'config',
      level: 'warning',
      message: `Only ${formatGiB(facts.configFreeBytes)} free for ${facts.configDir} (database, logs and backups)`,
    });
  }
  if (facts.restorePending) {
    checks.push({
      source: 'backup',
      level: 'notice',
      message: 'A backup restore is staged: restart Wololo to apply it',
    });
  }
  return checks;
}

function runtimeChecks(facts: HealthFacts): HealthCheck[] {
  const checks: HealthCheck[] = [];
  if (facts.isDocker && facts.uid === 0) {
    checks.push({
      source: 'docker',
      level: 'warning',
      message: 'Wololo runs as root: set PUID and PGID to the user that owns your media so new files keep their owner',
    });
  }
  if (!facts.processingEnabled) {
    checks.push({
      source: 'processing',
      level: 'notice',
      message:
        'Processing is off (dry run): Wololo only reports what it would change. Review the dry-run report, then turn processing on',
    });
  }
  return checks;
}

/** Health warnings from facts gathered by the system service; most severe first. */
export function buildHealthChecks(facts: HealthFacts): HealthCheck[] {
  const rank: Record<HealthCheck['level'], number> = { error: 0, warning: 1, notice: 2 };
  return [...toolChecks(facts), ...libraryChecks(facts), ...configChecks(facts), ...runtimeChecks(facts)].sort(
    (a, b) => rank[a.level] - rank[b.level],
  );
}
