import { resolve } from '$app/paths';

type ResolvePathname = (pathname: string) => string;

/**
 * App link under the URL base: href('/library/5?tab=log'). resolve() accepts any relative pathname at runtime, but its
 * types only admit literal route ids, so dynamic paths go through this one cast.
 */
export function href(path: string): string {
  return (resolve as unknown as ResolvePathname)(path.replace(/^\/+/, ''));
}
