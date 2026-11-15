import type { CreateProgressParser, FfmpegProgress } from '../../contracts/rules-ffmpeg.ts';

function parseNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseClock(value: string | undefined): number | null {
  const match = /^(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value ?? '');
  if (!match) return null;
  const [, negative, hours, minutes, seconds] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return negative ? -total : total;
}

function outTimeSec(block: ReadonlyMap<string, string>): number | null {
  const micros = parseNumber(block.get('out_time_us')) ?? parseNumber(block.get('out_time_ms'));
  if (micros !== null) return micros / 1_000_000;
  return parseClock(block.get('out_time'));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export const createProgressParser: CreateProgressParser = (durationSec) => {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  let block = new Map<string, string>();
  let lastOutTime = 0;

  const finish = (state: string): FfmpegProgress => {
    const done = state === 'end';
    const reported = outTimeSec(block);
    if (reported !== null && reported >= 0) lastOutTime = reported;
    const speedValue = parseNumber(block.get('speed')?.replace(/x$/, ''));
    const speed = speedValue !== null && speedValue > 0 ? speedValue : null;
    const progress = done ? 1 : duration > 0 ? clamp01(lastOutTime / duration) : 0;
    const remaining = Math.max(0, duration - lastOutTime);
    const etaSec = done ? 0 : speed !== null && duration > 0 ? remaining / speed : null;
    const totalSize = parseNumber(block.get('total_size'));
    const update: FfmpegProgress = {
      outTimeSec: lastOutTime,
      progress,
      speed,
      etaSec,
      fps: parseNumber(block.get('fps')),
      totalSizeBytes: totalSize !== null && totalSize >= 0 ? totalSize : null,
      done,
    };
    block = new Map();
    return update;
  };

  return {
    push(line) {
      const trimmed = line.trim();
      const separator = trimmed.indexOf('=');
      if (separator <= 0) return null;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key === 'progress') return finish(value);
      block.set(key, value);
      return null;
    },
  };
};
