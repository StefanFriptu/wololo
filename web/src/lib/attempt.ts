import { toasts } from '#lib/toast.svelte.ts';

export async function attempt<T>(
  action: () => Promise<T>,
  success?: string | ((result: T) => string),
): Promise<T | undefined> {
  try {
    const result = await action();
    if (success) toasts.success(typeof success === 'function' ? success(result) : success);
    return result;
  } catch (error) {
    toasts.error(error);
    return undefined;
  }
}
