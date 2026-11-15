import { redirect } from '@sveltejs/kit';
import { href } from '#lib/paths.ts';

export function load(): never {
  redirect(307, href('/settings/media'));
}
