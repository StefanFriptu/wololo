import { restartAndReload } from '#lib/restart.ts';
import { toasts } from '#lib/toast.svelte.ts';

class Restarter {
  restarting = $state(false);

  async run(): Promise<void> {
    if (this.restarting) return;
    if (!confirm('Restart Wololo now? Running jobs are stopped and picked up again after the restart.')) return;
    this.restarting = true;
    try {
      const back = await restartAndReload();
      if (!back) toasts.show('warning', 'Wololo did not come back within two minutes. Check the container logs.');
    } catch (error) {
      toasts.error(error);
    } finally {
      this.restarting = false;
    }
  }
}

export const restarter = new Restarter();
