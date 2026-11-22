/** "" (the empty option of a select) -> undefined, otherwise the number. Append `?? null` where the API wants null. */
export function parseOptionalNumber(value: string): number | undefined {
  return value === '' ? undefined : Number(value);
}
