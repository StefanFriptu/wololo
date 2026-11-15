import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json' with { type: 'json' };
import type { LogLevel } from '../shared/domain.ts';
import type { GeneralConfig } from '../shared/settings.ts';

export const APP_VERSION: string = pkg.version;
export const DEFAULT_PORT = 8585;

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  mkvmerge: string;
}

export interface AppConfig extends GeneralConfig {
  version: string;
  configDir: string;
  configFile: string;
  databasePath: string;
  logDir: string;
  jobLogDir: string;
  backupDir: string;
  webDir: string;
  tools: ToolPaths;
  isDocker: boolean;
  /** Keys of GeneralConfig currently forced by WOLOLO__* env vars (read-only in the UI). */
  envOverrides: (keyof GeneralConfig)[];
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
];

const ENV_KEYS: Record<keyof GeneralConfig, string> = {
  port: 'WOLOLO__PORT',
  bindAddress: 'WOLOLO__BIND_ADDRESS',
  urlBase: 'WOLOLO__URL_BASE',
  apiKey: 'WOLOLO__API_KEY',
  logLevel: 'WOLOLO__LOG_LEVEL',
  instanceName: 'WOLOLO__INSTANCE_NAME',
};

export function generateApiKey(): string {
  return randomBytes(16).toString('hex');
}

export function normalizeUrlBase(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

function isWritableDir(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveConfigDir(env: Env, cwd: string): string {
  if (env.WOLOLO_CONFIG_DIR) return resolve(env.WOLOLO_CONFIG_DIR);
  if (existsSync('/config') && isWritableDir('/config')) return '/config';
  return join(cwd, 'config');
}

function defaultGeneralConfig(): GeneralConfig {
  return {
    port: DEFAULT_PORT,
    bindAddress: '*',
    urlBase: '',
    apiKey: generateApiKey(),
    logLevel: 'info',
    instanceName: 'Wololo',
  };
}

function coerceGeneral(
  raw: Partial<Record<keyof GeneralConfig, unknown>>,
  base: GeneralConfig,
): GeneralConfig {
  const port = Number(raw.port);
  const logLevel = String(raw.logLevel ?? '') as LogLevel;
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : base.port,
    bindAddress:
      typeof raw.bindAddress === 'string' && raw.bindAddress
        ? raw.bindAddress
        : base.bindAddress,
    urlBase:
      typeof raw.urlBase === 'string'
        ? normalizeUrlBase(raw.urlBase)
        : base.urlBase,
    apiKey:
      typeof raw.apiKey === 'string' && raw.apiKey.length >= 16
        ? raw.apiKey
        : base.apiKey,
    logLevel: LOG_LEVELS.includes(logLevel) ? logLevel : base.logLevel,
    instanceName:
      typeof raw.instanceName === 'string' && raw.instanceName
        ? raw.instanceName
        : base.instanceName,
  };
}

function envGeneral(env: Env): Partial<Record<keyof GeneralConfig, string>> {
  const out: Partial<Record<keyof GeneralConfig, string>> = {};
  for (const [key, name] of Object.entries(ENV_KEYS) as [
    keyof GeneralConfig,
    string,
  ][]) {
    const value = env[name];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface LoadConfigOptions {
  env: Env;
  configDir?: string;
}

/**
 * Bootstrap config: <configDir>/config.json overlaid by WOLOLO__* env vars.
 * Creates the config dir and file (with a fresh API key) on first start.
 */
export class ConfigStore {
  private current: AppConfig;
  private readonly env: Env;

  constructor(options: LoadConfigOptions) {
    this.env = options.env;
    const configDir =
      options.configDir ?? resolveConfigDir(this.env, process.cwd());
    this.current = this.load(configDir);
  }

  get(): AppConfig {
    return this.current;
  }

  /** Persists the non-env-overridden fields and returns the new config. Port/bind/urlBase need a restart. */
  update(patch: Partial<Omit<GeneralConfig, 'apiKey'>>): AppConfig {
    const stored = coerceGeneral(
      readJsonFile(this.current.configFile),
      this.storedGeneral(),
    );
    const next = coerceGeneral({ ...stored, ...patch }, stored);
    writeJsonAtomic(this.current.configFile, next);
    this.current = this.load(this.current.configDir);
    return this.current;
  }

  regenerateApiKey(): AppConfig {
    const stored = coerceGeneral(
      readJsonFile(this.current.configFile),
      this.storedGeneral(),
    );
    writeJsonAtomic(this.current.configFile, {
      ...stored,
      apiKey: generateApiKey(),
    });
    this.current = this.load(this.current.configDir);
    return this.current;
  }

  private storedGeneral(): GeneralConfig {
    const { port, bindAddress, urlBase, apiKey, logLevel, instanceName } =
      this.current;
    return { port, bindAddress, urlBase, apiKey, logLevel, instanceName };
  }

  private load(configDir: string): AppConfig {
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, 'config.json');
    const fileExisted = existsSync(configFile);
    const stored = coerceGeneral(
      readJsonFile(configFile),
      defaultGeneralConfig(),
    );
    if (!fileExisted) writeJsonAtomic(configFile, stored);

    const overrides = envGeneral(this.env);
    const general = coerceGeneral({ ...stored, ...overrides }, stored);
    const logDir = join(configDir, 'logs');
    const jobLogDir = join(logDir, 'jobs');
    const backupDir = join(configDir, 'backups');
    for (const dir of [logDir, jobLogDir, backupDir])
      mkdirSync(dir, { recursive: true });

    return {
      ...general,
      version: APP_VERSION,
      configDir,
      configFile,
      databasePath: join(configDir, 'wololo.db'),
      logDir,
      jobLogDir,
      backupDir,
      webDir: this.env.WOLOLO_WEB_DIR
        ? resolve(this.env.WOLOLO_WEB_DIR)
        : fileURLToPath(new URL('../../web/build', import.meta.url)),
      tools: {
        ffmpeg: this.env.WOLOLO__FFMPEG || 'ffmpeg',
        ffprobe: this.env.WOLOLO__FFPROBE || 'ffprobe',
        mkvmerge: this.env.WOLOLO__MKVMERGE || 'mkvmerge',
      },
      isDocker: existsSync('/.dockerenv') || this.env.WOLOLO_DOCKER === '1',
      envOverrides: Object.keys(overrides) as (keyof GeneralConfig)[],
    };
  }
}
