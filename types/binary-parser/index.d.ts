declare module "binary-parser" {
  export class Parser<TParsed = any> {
    constructor();
    uint16le(this: this, name: string): this;
    uint32le(this: this, name: string): this;
    buffer(
      this: this,
      name: string,
      opts: {
        length?: number
        readUntil?: "eof" | ((item: any, buffer: Buffer) => boolean)
      },
    ): this;
    nest(this: this, name: string, opts: { type: Parser<any> }): this;
    parse(buffer: Buffer): TParsed;
    sizeOf(): number;
  }
}

