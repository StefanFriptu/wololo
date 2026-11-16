import { untrack } from 'svelte';
import type { PlexConnection } from '#lib/shared.ts';

interface PlexConnectionSync {
  connection: () => PlexConnection | undefined;
  /** The saved server changed: reset the server form to it. */
  onSavedServer: (machineId: string, url: string) => void;
  loadServers: () => void;
  loadServerData: () => void;
}

/**
 * Reacts only to changes of the saved sign-in and server, not to every new connection object: a PUT of a switch
 * returns a fresh object, which must neither reset an unsaved server choice nor query plex.tv again.
 */
export function syncPlexConnection({
  connection,
  onSavedServer,
  loadServers,
  loadServerData,
}: PlexConnectionSync): void {
  const signedIn = $derived(connection()?.signedIn ?? false);
  const machineId = $derived(connection()?.serverMachineId ?? '');
  const savedUrl = $derived(connection()?.serverUrl ?? '');

  $effect(() => {
    const id = machineId;
    const url = savedUrl;
    untrack(() => onSavedServer(id, url));
  });

  $effect(() => {
    if (signedIn) untrack(loadServers);
  });

  $effect(() => {
    void machineId;
    if (signedIn && savedUrl) untrack(loadServerData);
  });
}
