const MASK = '***';

/** Hides the user and password of a URL (reverse-proxy basic auth) so it can be logged; other input is returned as is. */
export function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (!url.username && !url.password) return value;
  if (url.username) url.username = MASK;
  if (url.password) url.password = MASK;
  return url.href;
}
