import type { MediaFileStatus } from '#lib/shared.ts';

interface FileProcessAction {
  label: string;
  force: boolean;
  primary: boolean;
  title: string | null;
}

export function fileProcessAction(status: MediaFileStatus): FileProcessAction | null {
  switch (status) {
    case 'needs_work':
      return { label: 'Process now', force: false, primary: true, title: null };
    case 'failed':
      return { label: 'Process now', force: true, primary: true, title: 'Queue a new attempt for this file' };
    case 'compatible':
      return {
        label: 'Process anyway',
        force: true,
        primary: false,
        title: 'Queue a job even though the file passes the profile',
      };
    default:
      return null;
  }
}
