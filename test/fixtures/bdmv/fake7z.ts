/**
 * A stand-in 7z for .iso tests: the ".iso" is a text file holding the path of a disc folder, and the script answers
 * `7z l -slt <iso>` and `7z x -y -bd -o<dir> <iso> @<list>` from that folder. An empty .iso fails like a broken image.
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const iso = command === 'l' ? args[1] : args.find((arg) => !arg.startsWith('-') && !arg.startsWith('@'));
const root = existsSync(iso) ? readFileSync(iso, 'utf8').trim() : '';
if (!root) {
  console.error('Can not open the file as archive');
  process.exit(2);
}

function walk(relative) {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative ? relative + '/' + entry.name : entry.name;
    return entry.isDirectory() ? [[path, 0, true], ...walk(path)] : [[path, statSync(join(root, path)).size, false]];
  });
}

if (command === 'l') {
  const blocks = walk('').map(([path, size, folder]) => 'Path = ' + path + '\\nFolder = ' + (folder ? '+' : '-') + '\\nSize = ' + size);
  console.log('Path = ' + iso + '\\nType = Udf\\n\\n----------\\n' + blocks.join('\\n\\n') + '\\n');
} else if (command === 'x') {
  const dest = args.find((arg) => arg.startsWith('-o')).slice(2);
  const list = readFileSync(args.find((arg) => arg.startsWith('@')).slice(1), 'utf8').split('\\n').filter(Boolean);
  for (const path of list) {
    mkdirSync(dirname(join(dest, path)), { recursive: true });
    cpSync(join(root, path), join(dest, path));
  }
} else {
  process.exit(7);
}
`;

/** Writes the fake 7z into dir and returns its path (pass it as WOLOLO__7Z). */
export function writeFake7z(dir: string): string {
  const path = join(dir, 'fake7z');
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  return path;
}

/** Writes an ".iso" that the fake 7z reads as the given disc folder (or as a broken image when folder is null). */
export function writeFakeIso(path: string, folder: string | null): string {
  writeFileSync(path, folder ?? '');
  return path;
}
