export function nameById(items: ReadonlyArray<{ id: number; name: string }> | undefined, id: number): string {
  return items?.find((item) => item.id === id)?.name ?? `#${id}`;
}
