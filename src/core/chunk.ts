export const IN_LIST_CHUNK_SIZE = 500;

/** Splits `items` into consecutive slices of at most `size`; empty input gives no chunks. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}
