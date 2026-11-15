/**
 * MPLS (movie playlist) and CLPI (clip information) parsers. Layout follows libbluray's mpls_parse.c / clpi_parse.c
 * and mkvtoolnix's src/common/bluray/mpls.cpp: big-endian, 45 kHz timestamps, length-prefixed records.
 */
import type {
  ClipInfo,
  MplsMark,
  MplsPlayItem,
  MplsPlaylist,
  MplsStream,
  ParseClpi,
  ParseMpls,
} from '../../contracts/bdmv.ts';
import { MPLS_TICKS_PER_SECOND } from '../../contracts/bdmv.ts';
import { normalizeLanguage } from '../../shared/language.ts';
import { ByteReader } from './byteReader.ts';

const CODEC_BY_CODING_TYPE: Readonly<Record<number, string>> = {
  1: 'mpeg1video',
  2: 'mpeg2video',
  27: 'h264',
  32: 'h264',
  36: 'hevc',
  234: 'vc1',
  3: 'mp2',
  4: 'mp2',
  128: 'pcm_bluray',
  129: 'ac3',
  130: 'dts',
  131: 'truehd',
  132: 'eac3',
  133: 'dts',
  134: 'dts',
  161: 'eac3',
  162: 'dts',
  144: 'hdmv_pgs_subtitle',
  145: 'hdmv_igs',
  146: 'hdmv_text_subtitle',
};

const AUDIO_CODING_TYPES = new Set([0x03, 0x04, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0xa1, 0xa2]);
const GRAPHICS_CODING_TYPES = new Set([0x90, 0x91]);
const TEXT_SUBTITLE_CODING_TYPE = 0x92;
const MVC_CODING_TYPE = 0x20;
const ENTRY_MARK = 1;
/** mkvmerge drops the last entry mark when it lies within 5 s of the playlist end; chapters must match its output. */
const LAST_CHAPTER_END_MARGIN_SEC = 5;
const CHAPTER_DEDUPE_SEC = 0.001;

export function codecForCodingType(codingType: number): string {
  return CODEC_BY_CODING_TYPE[codingType] ?? `0x${codingType.toString(16).padStart(2, '0')}`;
}

interface StreamAttributes {
  codingType: number;
  language: string | null;
}

function readStreamAttributes(reader: ByteReader, offset: number): StreamAttributes {
  const codingType = reader.u8(offset + 1);
  let language: string | null = null;
  if (AUDIO_CODING_TYPES.has(codingType)) language = reader.ascii(offset + 3, 3);
  else if (GRAPHICS_CODING_TYPES.has(codingType)) language = reader.ascii(offset + 2, 3);
  else if (codingType === TEXT_SUBTITLE_CODING_TYPE) language = reader.ascii(offset + 3, 3);
  return { codingType, language: language?.replace(/[\0\s]+/g, '') ?? null };
}

/** Stream entry: stream_type 1 = play item (pid), 2/4 = sub path + sub clip (pid), 3 = sub path (pid). */
function readStreamEntryPid(reader: ByteReader, offset: number): number {
  const streamType = reader.u8(offset + 1);
  if (streamType === 1) return reader.u16(offset + 2);
  if (streamType === 2 || streamType === 4) return reader.u16(offset + 4);
  if (streamType === 3) return reader.u16(offset + 3);
  return 0;
}

interface StnStream {
  stream: MplsStream;
  next: number;
}

function readStnStream(reader: ByteReader, offset: number, kind: MplsStream['kind'], secondary: boolean): StnStream {
  const pid = readStreamEntryPid(reader, offset);
  const attributesOffset = offset + 1 + reader.u8(offset);
  const attributes = readStreamAttributes(reader, attributesOffset);
  return {
    stream: {
      kind,
      pid,
      codingType: attributes.codingType,
      codec: codecForCodingType(attributes.codingType),
      language: normalizeLanguage(attributes.language),
      secondaryVideo: kind === 'video' && (secondary || attributes.codingType === MVC_CODING_TYPE),
    },
    next: attributesOffset + 1 + reader.u8(attributesOffset),
  };
}

/** Skips a list of 8-bit references preceded by a count and a reserved byte, padded to an even length. */
function skipReferences(reader: ByteReader, offset: number): number {
  const count = reader.u8(offset);
  return offset + 2 + count + (count % 2);
}

function parseStn(reader: ByteReader, offset: number): MplsStream[] {
  const counts = {
    video: reader.u8(offset + 4),
    audio: reader.u8(offset + 5),
    pg: reader.u8(offset + 6),
    ig: reader.u8(offset + 7),
    secondaryAudio: reader.u8(offset + 8),
    secondaryVideo: reader.u8(offset + 9),
    pipPg: reader.u8(offset + 10),
    dolbyVision: reader.u8(offset + 11),
  };
  const streams: MplsStream[] = [];
  let position = offset + 16;
  const take = (count: number, kind: MplsStream['kind'], secondary: boolean, after?: (next: number) => number) => {
    for (let i = 0; i < count; i++) {
      const entry = readStnStream(reader, position, kind, secondary);
      streams.push(entry.stream);
      position = after ? after(entry.next) : entry.next;
    }
  };
  take(counts.video, 'video', false);
  take(counts.audio, 'audio', false);
  take(counts.pg + counts.pipPg, 'subtitle', false);
  take(counts.ig, 'interactive', false);
  take(counts.secondaryAudio, 'audio', false, (next) => skipReferences(reader, next));
  take(counts.secondaryVideo, 'video', true, (next) => skipReferences(reader, skipReferences(reader, next)));
  take(counts.dolbyVision, 'video', true);
  return streams;
}

interface ParsedPlayItem {
  item: MplsPlayItem;
  stnOffset: number;
}

function parsePlayItem(reader: ByteReader, offset: number): ParsedPlayItem {
  const start = offset + 2;
  const flags = reader.u16(start + 9);
  const multiAngle = (flags & 0x10) !== 0;
  const inTime = reader.u32(start + 12);
  const outTime = reader.u32(start + 16);
  let position = start + 32;
  const angleClipIds: string[] = [];
  if (multiAngle) {
    const angles = reader.u8(position);
    position += 2;
    for (let angle = 1; angle < angles; angle++) {
      angleClipIds.push(reader.ascii(position, 5));
      position += 10;
    }
  }
  return {
    item: {
      clipId: reader.ascii(start, 5),
      inTime,
      outTime,
      durationSec: Math.max(0, outTime - inTime) / MPLS_TICKS_PER_SECOND,
      angleClipIds,
      connectionCondition: flags & 0x0f,
    },
    stnOffset: position,
  };
}

function parseMarks(reader: ByteReader, offset: number, items: readonly MplsPlayItem[]): MplsMark[] {
  if (offset === 0 || offset >= reader.length) return [];
  const count = reader.u16(offset + 4);
  const itemStarts: number[] = [];
  let elapsed = 0;
  for (const item of items) {
    itemStarts.push(elapsed);
    elapsed += item.durationSec;
  }
  const marks: MplsMark[] = [];
  for (let i = 0; i < count; i++) {
    const position = offset + 6 + i * 14;
    const playItemIndex = reader.u16(position + 2);
    const item = items[playItemIndex];
    const itemStart = itemStarts[playItemIndex];
    if (!item || itemStart === undefined) continue;
    const time = reader.u32(position + 4);
    marks.push({
      playItemIndex,
      timeSec: itemStart + (time - item.inTime) / MPLS_TICKS_PER_SECOND,
      entryMark: reader.u8(position + 1) === ENTRY_MARK,
    });
  }
  return marks;
}

export function chapterTimes(marks: readonly MplsMark[], durationSec: number): number[] {
  const times = marks
    .filter((mark) => mark.entryMark)
    .map((mark) => mark.timeSec)
    .sort((a, b) => a - b);
  const last = times.at(-1);
  if (last !== undefined && durationSec - last <= LAST_CHAPTER_END_MARGIN_SEC) times.pop();
  const inRange = times.filter((time) => time >= 0 && time < durationSec);
  return inRange.filter((time, i) => i === 0 || time - (inRange[i - 1] as number) > CHAPTER_DEDUPE_SEC);
}

export const parseMpls: ParseMpls = (name, bytes) => {
  const reader = new ByteReader(bytes, name);
  const magic = reader.ascii(0, 4);
  if (magic !== 'MPLS') throw new Error(`${name}: not an MPLS file (magic "${magic}")`);
  const playlistOffset = reader.u32(8);
  const marksOffset = reader.u32(12);
  const itemCount = reader.u16(playlistOffset + 6);

  const playItems: MplsPlayItem[] = [];
  let streams: MplsStream[] = [];
  let position = playlistOffset + 10;
  for (let i = 0; i < itemCount; i++) {
    const parsed = parsePlayItem(reader, position);
    playItems.push(parsed.item);
    if (i === 0) streams = parseStn(reader, parsed.stnOffset);
    position += 2 + reader.u16(position);
  }

  const durationSec = playItems.reduce((sum, item) => sum + item.durationSec, 0);
  const marks = parseMarks(reader, marksOffset, playItems);
  return { name, durationSec, playItems, streams, marks, chapterTimesSec: chapterTimes(marks, durationSec) };
};

const CLPI_TIME_WRAP = 2 ** 32;

function parseClipDuration(reader: ByteReader, offset: number): number | null {
  const atcCount = reader.u8(offset + 5);
  let position = offset + 6;
  let ticks = 0;
  let sequences = 0;
  for (let atc = 0; atc < atcCount; atc++) {
    const stcCount = reader.u8(position + 4);
    position += 6;
    for (let stc = 0; stc < stcCount; stc++) {
      const start = reader.u32(position + 6);
      const end = reader.u32(position + 10);
      ticks += end >= start ? end - start : end + CLPI_TIME_WRAP - start;
      sequences += 1;
      position += 14;
    }
  }
  return sequences > 0 ? ticks / MPLS_TICKS_PER_SECOND : null;
}

function parseClipStreams(reader: ByteReader, offset: number): ClipInfo['streams'] {
  const programCount = reader.u8(offset + 5);
  let position = offset + 6;
  const streams: ClipInfo['streams'] = [];
  for (let program = 0; program < programCount; program++) {
    const streamCount = reader.u8(position + 6);
    position += 8;
    for (let i = 0; i < streamCount; i++) {
      const pid = reader.u16(position);
      const attributes = readStreamAttributes(reader, position + 2);
      streams.push({
        pid,
        codingType: attributes.codingType,
        codec: codecForCodingType(attributes.codingType),
        language: normalizeLanguage(attributes.language),
      });
      position += 3 + reader.u8(position + 2);
    }
  }
  return streams;
}

export const parseClpi: ParseClpi = (clipId, bytes) => {
  const reader = new ByteReader(bytes, `${clipId}.clpi`);
  const magic = reader.ascii(0, 4);
  if (magic !== 'HDMV') throw new Error(`${clipId}.clpi: not a CLPI file (magic "${magic}")`);
  return {
    clipId,
    durationSec: parseClipDuration(reader, reader.u32(8)),
    streams: parseClipStreams(reader, reader.u32(12)),
  };
};

/** Fills playlist streams that carry no language with the language the clip's program info gives for the same PID. */
export function withClipLanguages(playlist: MplsPlaylist, clip: ClipInfo): MplsPlaylist {
  const byPid = new Map(clip.streams.map((stream) => [stream.pid, stream.language]));
  return {
    ...playlist,
    streams: playlist.streams.map((stream) =>
      stream.language === null ? { ...stream, language: byPid.get(stream.pid) ?? null } : stream,
    ),
  };
}
