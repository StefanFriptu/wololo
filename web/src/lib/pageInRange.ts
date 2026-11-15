import type { Paginated } from '#lib/shared.ts';

export function pageInRange(result: Pick<Paginated<unknown>, 'page' | 'pageSize' | 'total' | 'items'>): number | null {
  if (result.items.length > 0 || result.total <= 0 || result.pageSize <= 0) return null;
  const last = Math.max(1, Math.ceil(result.total / result.pageSize));
  return result.page > last ? last : null;
}
