const cache = new Map<string, boolean>();

/** True when an executable is on PATH. Tests that need mkvmerge, tsMuxeR or ffmpeg skip cleanly without it. */
export function hasBinary(name: string): boolean {
  let found = cache.get(name);
  if (found === undefined) {
    found = Bun.which(name) !== null;
    cache.set(name, found);
  }
  return found;
}
