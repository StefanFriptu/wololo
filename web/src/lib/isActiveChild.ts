/** Is this child link the current page? Nested pages (/library/12) keep their section's first link active. */
export function isActiveChild(pathname: string, childHref: string, siblings: readonly { href: string }[]): boolean {
  if (pathname === childHref) return true;
  if (siblings.some((sibling) => sibling.href === pathname)) return false;
  const longest = siblings
    .filter((sibling) => pathname.startsWith(`${sibling.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return longest?.href === childHref;
}
