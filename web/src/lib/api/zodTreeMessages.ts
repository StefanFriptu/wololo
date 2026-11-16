const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function collect(node: unknown, path: ReadonlyArray<string>, messages: string[]): void {
  if (!isRecord(node)) return;
  const prefix = path.length > 0 ? `${path.join('.')}: ` : '';
  if (Array.isArray(node.errors)) {
    for (const error of node.errors) if (typeof error === 'string') messages.push(`${prefix}${error}`);
  }
  if (isRecord(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) collect(child, [...path, key], messages);
  }
  if (Array.isArray(node.items)) {
    node.items.forEach((child, index) => {
      collect(child, [...path, String(index)], messages);
    });
  }
}

/** Flattens a zod `treeifyError` tree into "path: message" lines; [] when `details` has another shape. */
export function zodTreeMessages(details: unknown): string[] {
  if (!isRecord(details) || !Array.isArray(details.errors)) return [];
  const messages: string[] = [];
  collect(details, [], messages);
  return messages;
}
