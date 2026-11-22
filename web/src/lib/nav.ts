import type { IconName } from '#lib/components/IconName.ts';

interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  children?: { label: string; href: string }[];
}

export const NAV: NavItem[] = [
  { label: 'Profiles', href: '/profiles', icon: 'profiles' },
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
