/** The key the backend injected wins; otherwise the one the user entered earlier, else none (show the prompt). */
export function resolveApiKey(injected: string | null | undefined, stored: string | null | undefined): string {
  return injected?.trim() || stored?.trim() || '';
}
