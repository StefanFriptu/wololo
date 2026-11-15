const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS']);

/** True for link() errors of filesystems without hard links (some FUSE/SMB mounts), where a rename has to do. */
export function isLinkUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return LINK_UNSUPPORTED.has(String(error.code));
}
