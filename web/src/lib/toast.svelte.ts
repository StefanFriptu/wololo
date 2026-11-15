import { errorMessage } from '#lib/api/errorMessage.ts';
import type { Tone } from '#lib/labels.ts';

interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

const TIMEOUT_MS = 5000;

class ToastState {
  items = $state<Toast[]>([]);
  #next = 1;

  show(tone: Tone, message: string): void {
    const id = this.#next++;
    this.items = [...this.items, { id, tone, message }];
    setTimeout(() => this.dismiss(id), tone === 'danger' ? TIMEOUT_MS * 2 : TIMEOUT_MS);
  }

  success(message: string): void {
    this.show('success', message);
  }

  error(error: unknown): void {
    this.show('danger', errorMessage(error));
  }

  dismiss(id: number): void {
    this.items = this.items.filter((item) => item.id !== id);
  }
}

export const toasts = new ToastState();
