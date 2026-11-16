import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json' with { type: 'json' };
import type { LogLevel } from '../shared/domain.ts';
import { AUTHENTICATION_MODES, type AuthenticationMode, type GeneralConfig } from '../shared/settings.ts';

type Env = Record<string, string | undefined>;

/** WOLOLO_VERSION is baked into the Docker image from the git tag; local runs report package.json's version. */
export function resolveAppVersion(env: Env, fallback: string = pkg.version): string {
  const version = env.WOLOLO_VERSION?.trim();
  return version && version !== 'dev' ? version : fallback;
}

export const APP_VERSION: string = resolveAppVersion(process.env);
export const DEFAULT_PORT = 8585;

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  mkvmerge: string;
  /** 7-Zip, reads Blu-ray .iso images (UDF) for BDMV jobs. */
  sevenZip: string;
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
  /** Keys of GeneralConfig currently forced by valid WOLOLO__* env vars (read-only in the UI). */
  envOverrides: (keyof GeneralConfig)[];
  /** Problems found while loading (invalid env values, repaired config.json); logged by bootstrap. */
  warnings: string[];
}

const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

const ENV_KEYS: Record<keyof GeneralConfig, string> = {
  port: 'WOLOLO__PORT',
  bindAddress: 'WOLOLO__BIND_ADDRESS',
  urlBase: 'WOLOLO__URL_BASE',
  apiKey: 'WOLOLO__API_KEY',
  logLevel: 'WOLOLO__LOG_LEVEL',
  instanceName: 'WOLOLO__INSTANCE_NAME',
  authentication: 'WOLOLO__AUTHENTICATION',
};

const URL_BASE_PATTERN = /^(\/[A-Za-z0-9._~-]+)*$/;
const API_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

export function generateApiKey(): string {
  return randomBytes(16).toString('hex');
}

export function normalizeUrlBase(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

/** "" or "/seg[/seg...]" with unreserved URL characters only (no ":" so Hono never treats it as a route parameter). */
export function isValidUrlBase(value: string): boolean {
  return URL_BASE_PATTERN.test(normalizeUrlBase(value));
}

/** "*" (all interfaces) or a literal IPv4/IPv6 address; host names would make startup depend on DNS. */
export function isValidBindAddress(value: string): boolean {
  return value === '*' || isIP(value) !== 0;
}

/** A wildcard, or an address assigned to one of this machine's interfaces; anything else cannot be bound. */
export function isLocalBindAddress(value: string, localAddresses: ReadonlyArray<string>): boolean {
  if (value === '*' || value === '0.0.0.0' || value === '::') return true;
  const address = value.split('%')[0]?.toLowerCase();
  return localAddresses.some((local) => local.split('%')[0]?.toLowerCase() === address);
}

/** Address a local client (healthcheck) uses to reach the server. */
export function loopbackHost(bindAddress: string): string {
  if (bindAddress === '*' || bindAddress === '0.0.0.0') return '127.0.0.1';
  if (bindAddress === '::') return '[::1]';
  return isIP(bindAddress) === 6 ? `[${bindAddress}]` : bindAddress;
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
    authentication: 'disabled_for_local_addresses',
  };
}

type FieldParsers = { [K in keyof GeneralConfig]: (raw: unknown) => GeneralConfig[K] | undefined };

const FIELD_PARSERS: FieldParsers = {
  port: (raw) => {
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  },
  bindAddress: (raw) => (typeof raw === 'string' && isValidBindAddress(raw.trim()) ? raw.trim() : undefined),
  urlBase: (raw) => (typeof raw === 'string' && isValidUrlBase(raw) ? normalizeUrlBase(raw) : undefined),
  apiKey: (raw) => (typeof raw === 'string' && API_KEY_PATTERN.test(raw) ? raw : undefined),
  logLevel: (raw) => LOG_LEVELS.find((level) => level === raw),
  instanceName: (raw) => (typeof raw === 'string' && raw.trim() && raw.length <= 64 ? raw.trim() : undefined),
  authentication: (raw) => AUTHENTICATION_MODES.find((mode): mode is AuthenticationMode => mode === raw),
};

const GENERAL_KEYS = Object.keys(FIELD_PARSERS) as (keyof GeneralConfig)[];

interface MergeResult {
  config: GeneralConfig;
  invalid: (keyof GeneralConfig)[];
  missing: (keyof GeneralConfig)[];
}

/** Pure: overlays raw values on base field by field; invalid values keep the base value and are reported. */
export function mergeGeneral(raw: Partial<Record<keyof GeneralConfig, unknown>>, base: GeneralConfig): MergeResult {
  const config = { ...base };
  const invalid: (keyof GeneralConfig)[] = [];
  const missing: (keyof GeneralConfig)[] = [];
  for (const key of GENERAL_KEYS) {
    if (raw[key] === undefined) {
      missing.push(key);
      continue;
    }
    const value = FIELD_PARSERS[key](raw[key]);
    if (value === undefined) invalid.push(key);
    else Object.assign(config, { [key]: value });
  }
  return { config, invalid, missing };
}

function envGeneral(env: Env): Partial<Record<keyof GeneralConfig, string>> {
  const out: Partial<Record<keyof GeneralConfig, string>> = {};
  for (const key of GENERAL_KEYS) {
    const value = env[ENV_KEYS[key]]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

type ConfigFile =
  | { status: 'missing'; data: Record<string, unknown> }
  | { status: 'corrupt'; data: Record<string, unknown> }
  | { status: 'ok'; data: Record<string, unknown> };

function readConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) return { status: 'missing', data: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return { status: 'ok', data: parsed as Record<string, unknown> };
  } catch {}
  return { status: 'corrupt', data: {} };
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Read-only boot settings (no mkdir, no writes, no key generation): what the server listens on.
 * Shared by ConfigStore and docker/healthcheck.ts so both agree on port, bind address and URL base.
 */
export function resolveBootSettings(
  env: Env,
  configDir: string = resolveConfigDir(env, process.cwd()),
): Pick<GeneralConfig, 'port' | 'bindAddress' | 'urlBase'> {
  const file = readConfigFile(join(configDir, 'config.json'));
  const stored = mergeGeneral(file.data, defaultGeneralConfig()).config;
  const { port, bindAddress, urlBase } = mergeGeneral(envGeneral(env), stored).config;
  return { port, bindAddress, urlBase };
}

export interface LoadConfigOptions {
  env: Env;
  configDir?: string;
}

/**
 * Bootstrap config: <configDir>/config.json overlaid by WOLOLO__* env vars.
 * Creates the config dir and file (with a fresh API key) on first start and repairs a partial, invalid or corrupt
 * file (the corrupt original is kept as config.json.bad), so the API key never changes between boots.
 */
export class ConfigStore {
  private current: AppConfig;
  private readonly env: Env;

  constructor(options: LoadConfigOptions) {
    this.env = options.env;
    const configDir = options.configDir ?? resolveConfigDir(this.env, process.cwd());
    this.current = this.load(configDir);
  }

  get(): AppConfig {
    return this.current;
  }

  /** Persists the non-env-overridden fields and returns the new config. Port/bind/urlBase need a restart. */
  update(patch: Partial<Omit<GeneralConfig, 'apiKey'>>): AppConfig {
    const stored = mergeGeneral(readConfigFile(this.current.configFile).data, this.storedGeneral()).config;
    const next = mergeGeneral(patch, stored);
    if (next.invalid.length > 0) throw new Error(`invalid general settings: ${next.invalid.join(', ')}`);
    writeJsonAtomic(this.current.configFile, next.config);
    this.current = this.load(this.current.configDir);
    return this.current;
  }

  regenerateApiKey(): AppConfig {
    const stored = mergeGeneral(readConfigFile(this.current.configFile).data, this.storedGeneral()).config;
    writeJsonAtomic(this.current.configFile, { ...stored, apiKey: generateApiKey() });
    this.current = this.load(this.current.configDir);
    return this.current;
  }

  private storedGeneral(): GeneralConfig {
    const general = {} as Record<keyof GeneralConfig, unknown>;
    for (const key of GENERAL_KEYS) general[key] = this.current[key];
    return general as GeneralConfig;
  }

  private load(configDir: string): AppConfig {
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, 'config.json');
    const warnings: string[] = [];
    const file = readConfigFile(configFile);
    if (file.status === 'corrupt') {
      renameSync(configFile, `${configFile}.bad`);
      warnings.push('config.json was not valid JSON; kept it as config.json.bad and wrote a fresh one');
    }
    const stored = mergeGeneral(file.data, defaultGeneralConfig());
    for (const key of stored.invalid) warnings.push(`config.json: invalid ${key}, using ${String(stored.config[key])}`);
    if (file.status !== 'ok' || stored.invalid.length > 0 || stored.missing.length > 0)
      writeJsonAtomic(configFile, stored.config);

    const envValues = envGeneral(this.env);
    const general = mergeGeneral(envValues, stored.config);
    for (const key of general.invalid) warnings.push(`${ENV_KEYS[key]} is invalid and was ignored`);
    const logDir = join(configDir, 'logs');
    const jobLogDir = join(logDir, 'jobs');
    const backupDir = join(configDir, 'backups');
    for (const dir of [logDir, jobLogDir, backupDir]) mkdirSync(dir, { recursive: true });

    return {
      ...general.config,
      version: resolveAppVersion(this.env),
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
        sevenZip: this.env.WOLOLO__7Z || '7z',
      },
      isDocker: existsSync('/.dockerenv') || this.env.WOLOLO_DOCKER === '1',
      envOverrides: (Object.keys(envValues) as (keyof GeneralConfig)[]).filter((key) => !general.invalid.includes(key)),
      warnings,
    };
  }
}
