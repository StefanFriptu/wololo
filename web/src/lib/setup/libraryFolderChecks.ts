import { formatBytes } from '#lib/format/formatBytes.ts';
import type { Library } from '#lib/shared.ts';
import type { SetupCheck } from './SetupCheck.ts';

export function libraryFolderChecks(
  libraries: ReadonlyArray<Pick<Library, 'id' | 'name' | 'enabled' | 'profileIds' | 'roots'>>,
): SetupCheck[] {
  return libraries.flatMap((library) => {
    const profileCheck: SetupCheck[] =
      library.enabled && library.profileIds.length === 0
        ? [
            {
              key: `library-profile-${library.id}`,
              state: 'bad',
              title: `${library.name} has no player`,
              detail: 'Scans skip this library. Tick a player for it in Settings → Media.',
              fixStep: 'media',
            },
          ]
        : [];
    const rootChecks = library.roots.map((root): SetupCheck => {
      const key = `folder-${root.id}`;
      if (!root.accessible) {
        return {
          key,
          state: 'bad',
          title: `${root.path} is not reachable`,
          detail: 'Check the folder is mounted into the Wololo container at this path.',
          fixStep: 'media',
        };
      }
      if (!root.writable) {
        return {
          key,
          state: 'warn',
          title: `${root.path} is read-only`,
          detail: 'Wololo can check files here but cannot replace them. Check PUID/PGID and the mount options.',
          fixStep: 'media',
        };
      }
      return {
        key,
        state: 'ok',
        title: `${library.name}: ${root.path}`,
        detail: `Writable, ${formatBytes(root.freeBytes)} free`,
      };
    });
    return [...profileCheck, ...rootChecks];
  });
}
