/** Writers for synthetic MPLS / CLPI / PGS (.sup) binaries, so parser tests need no disc. Layout mirrors libbluray. */

class ByteWriter {
  private readonly bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value >>> 8).u8(value);
  }

  u32(value: number): this {
    return this.u16(value >>> 16).u16(value);
  }

  ascii(text: string, size = text.length): this {
    for (let i = 0; i < size; i++) this.u8(text.charCodeAt(i) || 0);
    return this;
  }

  zeros(count: number): this {
    for (let i = 0; i < count; i++) this.u8(0);
    return this;
  }

  append(other: ByteWriter | Uint8Array): this {
    for (const byte of other instanceof ByteWriter ? other.toBytes() : other) this.u8(byte);
    return this;
  }

  patchU32(offset: number, value: number): this {
    this.bytes[offset] = (value >>> 24) & 0xff;
    this.bytes[offset + 1] = (value >>> 16) & 0xff;
    this.bytes[offset + 2] = (value >>> 8) & 0xff;
    this.bytes[offset + 3] = value & 0xff;
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export interface StreamSpec {
  pid: number;
  codingType: number;
  language?: string;
  /** 1 = play item (default), 2/4 = sub path + sub clip, 3 = sub path. */
  entryType?: 1 | 2 | 3 | 4;
}

export interface StnSpec {
  video?: StreamSpec[];
  audio?: StreamSpec[];
  pg?: StreamSpec[];
  ig?: StreamSpec[];
  secondaryAudio?: StreamSpec[];
  secondaryVideo?: StreamSpec[];
  pipPg?: StreamSpec[];
  dolbyVision?: StreamSpec[];
}

export interface PlayItemSpec {
  clipId: string;
  inTime: number;
  outTime: number;
  angleClipIds?: string[];
  connectionCondition?: number;
  stn?: StnSpec;
}

export interface MarkSpec {
  playItem: number;
  time: number;
  /** 1 = entry mark (chapter), 2 = link point. */
  type?: number;
}

export interface MplsSpec {
  version?: '0100' | '0200' | '0300';
  playItems: PlayItemSpec[];
  marks?: MarkSpec[];
}

const AUDIO = new Set([0x03, 0x04, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0xa1, 0xa2]);

function streamEntry(spec: StreamSpec): ByteWriter {
  const body = new ByteWriter().u8(spec.entryType ?? 1);
  if (spec.entryType === 2 || spec.entryType === 4) body.u8(1).u8(0).u16(spec.pid);
  else if (spec.entryType === 3) body.u8(1).u16(spec.pid);
  else body.u16(spec.pid);
  body.zeros(9 - body.length);
  return new ByteWriter().u8(body.length).append(body);
}

function streamAttributes(spec: StreamSpec): ByteWriter {
  const body = new ByteWriter().u8(spec.codingType);
  const language = spec.language ?? 'und';
  if (AUDIO.has(spec.codingType)) body.u8(0x61).ascii(language, 3);
  else if (spec.codingType === 0x90 || spec.codingType === 0x91) body.ascii(language, 3);
  else if (spec.codingType === 0x92) body.u8(1).ascii(language, 3);
  else body.u8(0x61);
  body.zeros(5 - Math.min(5, body.length));
  return new ByteWriter().u8(body.length).append(body);
}

function stnTable(spec: StnSpec = {}): ByteWriter {
  const body = new ByteWriter()
    .zeros(2)
    .u8(spec.video?.length ?? 0)
    .u8(spec.audio?.length ?? 0)
    .u8(spec.pg?.length ?? 0)
    .u8(spec.ig?.length ?? 0)
    .u8(spec.secondaryAudio?.length ?? 0)
    .u8(spec.secondaryVideo?.length ?? 0)
    .u8(spec.pipPg?.length ?? 0)
    .u8(spec.dolbyVision?.length ?? 0)
    .zeros(4);
  const write = (streams: StreamSpec[] = [], references = 0) => {
    for (const stream of streams) {
      body.append(streamEntry(stream)).append(streamAttributes(stream));
      for (let i = 0; i < references; i++) body.u8(1).u8(0).u8(0).u8(0);
    }
  };
  write(spec.video);
  write(spec.audio);
  write([...(spec.pg ?? []), ...(spec.pipPg ?? [])]);
  write(spec.ig);
  write(spec.secondaryAudio, 1);
  write(spec.secondaryVideo, 2);
  write(spec.dolbyVision);
  return new ByteWriter().u16(body.length).append(body);
}

function playItem(spec: PlayItemSpec): ByteWriter {
  const angles = spec.angleClipIds ?? [];
  const body = new ByteWriter()
    .ascii(spec.clipId, 5)
    .ascii('M2TS')
    .u16(((angles.length > 0 ? 1 : 0) << 4) | (spec.connectionCondition ?? 1))
    .u8(0)
    .u32(spec.inTime)
    .u32(spec.outTime)
    .zeros(8)
    .u8(0)
    .u8(0)
    .u16(0);
  if (angles.length > 0) {
    body.u8(angles.length + 1).u8(0);
    for (const angle of angles) body.ascii(angle, 5).ascii('M2TS').u8(0);
  }
  body.append(stnTable(spec.stn));
  return new ByteWriter().u16(body.length).append(body);
}

export function writeMpls(spec: MplsSpec): Uint8Array {
  const out = new ByteWriter()
    .ascii('MPLS')
    .ascii(spec.version ?? '0200')
    .u32(0)
    .u32(0)
    .u32(0)
    .zeros(20);
  out.u32(14).zeros(14);

  const playlistOffset = out.length;
  const items = new ByteWriter().zeros(2).u16(spec.playItems.length).u16(0);
  for (const item of spec.playItems) items.append(playItem(item));
  out.u32(items.length).append(items);

  const marksOffset = out.length;
  const marks = spec.marks ?? [];
  const markBody = new ByteWriter().u16(marks.length);
  for (const mark of marks)
    markBody
      .u8(0)
      .u8(mark.type ?? 1)
      .u16(mark.playItem)
      .u32(mark.time)
      .u16(0xffff)
      .u32(0);
  out.u32(markBody.length).append(markBody);

  return out.patchU32(8, playlistOffset).patchU32(12, marksOffset).toBytes();
}

export interface ClpiSpec {
  /** Presentation start/end per STC sequence, 45 kHz ticks (one ATC sequence). */
  stc?: { start: number; end: number }[];
  streams?: StreamSpec[];
}

export function writeClpi(spec: ClpiSpec): Uint8Array {
  const out = new ByteWriter().ascii('HDMV').ascii('0200').zeros(20).zeros(12);
  const stc = spec.stc ?? [];
  const sequenceOffset = out.length;
  const sequence = new ByteWriter().u8(0).u8(1).u32(0).u8(stc.length).u8(0);
  for (const range of stc) sequence.u16(0x1001).u32(0).u32(range.start).u32(range.end);
  out.u32(sequence.length).append(sequence);

  const programOffset = out.length;
  const streams = spec.streams ?? [];
  const program = new ByteWriter().u8(0).u8(1).u32(0).u16(0x100).u8(streams.length).u8(0);
  for (const stream of streams) program.u16(stream.pid).append(streamAttributes(stream));
  out.u32(program.length).append(program);

  return out.patchU32(8, sequenceOffset).patchU32(12, programOffset).toBytes();
}

export interface PgsCompositionSpec {
  objects: { forced?: boolean; cropped?: boolean }[];
}

function pgsSegment(type: number, data: ByteWriter): ByteWriter {
  return new ByteWriter().ascii('PG').u32(90_000).u32(0).u8(type).u16(data.length).append(data);
}

/** A .sup stream: per composition a PCS (0x16) followed by an END segment (0x80). */
export function writeSup(compositions: PgsCompositionSpec[]): Uint8Array {
  const out = new ByteWriter();
  compositions.forEach((composition, index) => {
    const pcs = new ByteWriter().u16(1920).u16(1080).u8(0x10).u16(index).u8(0x80).u8(0).u8(0);
    pcs.u8(composition.objects.length);
    for (const object of composition.objects) {
      pcs
        .u16(0)
        .u8(0)
        .u8((object.cropped ? 0x80 : 0) | (object.forced ? 0x40 : 0))
        .u16(100)
        .u16(900);
      if (object.cropped) pcs.u16(0).u16(0).u16(10).u16(10);
    }
    out.append(pgsSegment(0x16, pcs)).append(pgsSegment(0x80, new ByteWriter()));
  });
  return out.toBytes();
}
