export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

/** Clamps a requested page (min 1) and page size (1..MAX_PAGE_SIZE) and applies the defaults. */
export function resolvePageWindow(query: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  return {
    page: Math.max(1, query.page ?? 1),
    pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE)),
  };
}
