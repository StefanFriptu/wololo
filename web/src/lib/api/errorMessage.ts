import { ApiError } from './ApiError.ts';
import { zodTreeMessages } from './zodTreeMessages.ts';

const SHOWN_DETAILS = 3;

function withDetails(message: string, details: unknown): string {
  const lines = zodTreeMessages(details);
  if (lines.length === 0) return message;
  const shown = lines.slice(0, SHOWN_DETAILS).join('; ');
  const rest = lines.length - SHOWN_DETAILS;
  return `${message}: ${shown}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Cannot reach Wololo. Check that it is running.';
    return withDetails(error.message || `Request failed (${error.status})`, error.details);
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
