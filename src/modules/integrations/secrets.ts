import { AppError } from '../../core/errors.ts';
import { trimTrailingSlashes } from '../../shared/trimTrailingSlashes.ts';

/** What API responses show instead of a stored secret; sending it back on update/test keeps the stored value. */
export const SECRET_MASK = '********';

export function maskSecret(value: string): string {
  return value ? SECRET_MASK : '';
}

function endpointKey(url: string): string {
  const trimmed = trimTrailingSlashes(url.trim());
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${trimTrailingSlashes(parsed.pathname)}`;
  } catch {
    return trimmed;
  }
}

/** Same scheme, host, port and path (case of the host and trailing slashes ignored). */
export function sameEndpoint(a: string, b: string): boolean {
  return endpointKey(a) === endpointKey(b);
}

export interface SecretInput {
  provided: string;
  stored: { secret: string; url: string } | null | undefined;
  /** URL the secret is about to be sent to. */
  url: string;
  /** Human name for error messages ("API key", "password"). */
  label: string;
}

/**
 * The mask resolves to the stored secret (null when nothing is stored), but only for the URL it was saved with:
 * otherwise anyone who can call the API could send the stored secret to a server of their choice and read it there.
 * Anything else is a new value.
 */
export function resolveSecret({ provided, stored, url, label }: SecretInput): string | null {
  if (provided !== SECRET_MASK) return provided;
  if (!stored) return null;
  if (!sameEndpoint(stored.url, url)) {
    throw new AppError('unprocessable', `the URL changed, so enter the ${label} again`);
  }
  return stored.secret;
}
