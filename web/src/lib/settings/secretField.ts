const SECRET_MASK = '********';

/** A stored secret arrives as the mask; the input starts empty so typing never appends to it. */
export function secretForForm(stored: string): string {
  return stored === SECRET_MASK ? '' : stored;
}

/** An empty input keeps the stored secret: the server resolves the mask to it. */
export function secretForRequest(typed: string, stored: string): string {
  return typed === '' && stored === SECRET_MASK ? SECRET_MASK : typed;
}
