import type { ThemeChoice } from '#lib/ThemeChoice.ts';

const STORAGE_KEY = 'wololo-theme';

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

class ThemeState {
  choice = $state<ThemeChoice>(typeof window === 'undefined' ? 'system' : readStored());

  set(choice: ThemeChoice): void {
    this.choice = choice;
    try {
      if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // storage may be unavailable (private mode)
    }
    if (choice === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
  }

  cycle(): void {
    const order: ThemeChoice[] = ['system', 'light', 'dark'];
    this.set(order[(order.indexOf(this.choice) + 1) % order.length] ?? 'system');
  }
}

export const theme = new ThemeState();
