/** Big-endian reads with bounds checks; every Blu-ray structure (MPLS, CLPI, PGS) is big-endian. */
export class ByteReader {
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    private readonly label: string,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  private check(offset: number, size: number): void {
    if (offset < 0 || offset + size > this.bytes.byteLength)
      throw new Error(
        `${this.label}: truncated (needs ${size} bytes at offset ${offset}, has ${this.bytes.byteLength})`,
      );
  }

  u8(offset: number): number {
    this.check(offset, 1);
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset);
  }

  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset);
  }

  ascii(offset: number, size: number): string {
    this.check(offset, size);
    return String.fromCharCode(...this.bytes.subarray(offset, offset + size));
  }
}
