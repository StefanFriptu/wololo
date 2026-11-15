import { ApiError } from './ApiError.ts';

/** User-facing text for anything a request or action threw. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 501) return 'Not available yet: this part of Wololo is missing from this build.';
    if (error.status === 0) return 'Cannot reach Wololo. Check that it is running.';
    return error.message || `Request failed (${error.status})`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
