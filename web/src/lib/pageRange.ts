/** Page buttons to show: first, last and the neighbours of the current page; null marks a gap. */
export function pageRange(current: number, pages: number): (number | null)[] {
  if (pages <= 0) return [];
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const page = Math.min(Math.max(1, current), pages);
  let start = Math.max(2, page - 1);
  let end = Math.min(pages - 1, page + 1);
  if (start <= 3) {
    start = 2;
    end = Math.max(end, 5);
  }
  if (end >= pages - 2) {
    end = pages - 1;
    start = Math.min(start, pages - 4);
  }
  const middle = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  return [1, ...(start > 2 ? [null] : []), ...middle, ...(end < pages - 1 ? [null] : []), pages];
}
