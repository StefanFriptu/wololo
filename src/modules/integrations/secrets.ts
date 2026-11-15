/** What API responses show instead of a stored secret; sending it back on update/test keeps the stored value. */
export const SECRET_MASK = '********';

export function maskSecret(value: string): string {
  return value ? SECRET_MASK : '';
}

/** The mask resolves to the stored secret (null when nothing is stored); anything else is a new value. */
export function resolveSecret(provided: string, stored: string | null | undefined): string | null {
  if (provided !== SECRET_MASK) return provided;
  return stored ?? null;
}
