declare module "binary-parser" {
  export type Endian = "little" | "big";

  export class Parser<T = any> {
    constructor();
    endianess(endian: Endian): this;
    uint8(name: string): this;
    uint16(name: string): this;
    uint32(name: string): this;
    int8(name: string): this;
    int16(name: string): this;
    int32(name: string): this;
    buffer(name: string, opts: { length?: number; readUntil?: string | ((item: number, buf: Buffer) => boolean) }): this;
    string(name: string, opts: { length?: number; zeroTerminated?: boolean; encoding?: string }): this;
    nest(name: string, opts: { type: Parser }): this;
    array(name: string, opts: { type: Parser | string; length: number }): this;
    parse(buffer: Buffer): T;
    sizeOf(): number;
  }
}

