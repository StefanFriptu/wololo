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

export async function attemptOk(action: () => Promise<unknown>, success?: string): Promise<boolean> {
  const done = await attempt(async () => {
    await action();
    return true;
  }, success);
  return done === true;
}
