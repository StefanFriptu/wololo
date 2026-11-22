import { errnoCode } from '../../core/errors.ts';

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS']);

/** True for link() errors of filesystems without hard links (some FUSE/SMB mounts), where a rename has to do. */
export function isLinkUnsupported(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && LINK_UNSUPPORTED.has(code);
}
