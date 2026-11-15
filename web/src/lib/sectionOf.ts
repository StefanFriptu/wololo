/** "/library/12" -> "/library": the sidebar section a path belongs to (path relative to the URL base). */
export function sectionOf(pathname: string): string {
  return `/${pathname.split('/')[1] ?? ''}`;
}
