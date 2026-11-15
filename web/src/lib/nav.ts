import type { IconName } from '#lib/components/icons.ts';

export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  children?: { label: string; href: string }[];
}

export const NAV: NavItem[] = [
  {
    label: 'Library',
    href: '/library',
    icon: 'library',
    children: [
      { label: 'Files', href: '/library' },
      { label: 'Dry run', href: '/library/dryrun' },
      { label: 'Decisions', href: '/library/decisions' },
    ],
  },
  {
    label: 'Activity',
    href: '/activity/queue',
    icon: 'activity',
    children: [
      { label: 'Queue', href: '/activity/queue' },
      { label: 'History', href: '/activity/history' },
      { label: 'Recycle bin', href: '/activity/recyclebin' },
    ],
  },
  { label: 'Profiles', href: '/profiles', icon: 'profiles' },
  {
    label: 'Settings',
    href: '/settings/media',
    icon: 'settings',
    children: [
      { label: 'Media', href: '/settings/media' },
      { label: 'Connect', href: '/settings/connect' },
      { label: 'Plex', href: '/settings/plex' },
      { label: 'Download clients', href: '/settings/downloadclients' },
      { label: 'General', href: '/settings/general' },
    ],
  },
  {
    label: 'System',
    href: '/system/status',
    icon: 'system',
    children: [
      { label: 'Status', href: '/system/status' },
      { label: 'Tasks', href: '/system/tasks' },
      { label: 'Logs', href: '/system/logs' },
      { label: 'Backup', href: '/system/backup' },
    ],
  },
];

/** "/library/12" -> "/library": the sidebar section a path belongs to (path relative to the URL base). */
export function sectionOf(pathname: string): string {
  return `/${pathname.split('/')[1] ?? ''}`;
}

/** Is this child link the current page? Nested pages (/library/12) keep their section's first link active. */
export function isActiveChild(pathname: string, childHref: string, siblings: readonly { href: string }[]): boolean {
  if (pathname === childHref) return true;
  if (siblings.some((sibling) => sibling.href === pathname)) return false;
  const longest = siblings
    .filter((sibling) => pathname.startsWith(`${sibling.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return longest?.href === childHref;
}
