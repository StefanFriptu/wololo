import type { Tone } from '#lib/labels.ts';
import type { ProfileResult } from '#lib/shared.ts';

interface ProfileChip {
  label: string;
  tone: Tone;
}

export function profileChip(result: ProfileResult, name: string): ProfileChip {
  if (result.action === 'skip') return { label: name, tone: 'success' };
  const [codec] = result.failingCodecs;
  return { label: codec ? `${name} · ${codec}` : name, tone: 'danger' };
}
