declare module "restructure" {
  export class Base {
    fromBuffer<T = any>(buffer: Uint8Array): T
    toBuffer(value: any): Uint8Array
    size(value?: any): number
  }

  export class Struct<T = any> extends Base {
    constructor(fields?: Record<string, any>)
  }

  export class Buffer extends Base {
    constructor(length: number | string | ((parent: any) => number))
  }

  export class String extends Base {
    constructor(length: number | string | ((parent: any) => number) | null, encoding?: string)
  }

  export class Array<T = any> extends Base {
    constructor(type: any, length: number | string | ((parent: any) => number), mode?: "bytes")
  }

  export class VersionedStruct<T = any> extends Base {
    constructor(versionType: any, versions: Record<string | number, any>)
  }

  export class Optional<T = any> extends Base {
    constructor(type: any, condition: boolean | (() => boolean))
  }

  export class Enum<T = any> extends Base {
    constructor(type: any, values: T[])
  }

  export class Bitfield<T = any> extends Base {
    constructor(type: any, fields: string[])
  }

  export const uint8: any
  export const uint16: any
  export const uint16le: any
  export const uint24: any
  export const uint24le: any
  export const uint32: any
  export const uint32le: any
  export const int8: any
  export const int16: any
  export const int16le: any
  export const int24: any
  export const int24le: any
  export const int32: any
  export const int32le: any
  export const float: any
  export const floatle: any
  export const double: any
  export const doublele: any
  export const fixed16: any
  export const fixed16le: any
  export const fixed32: any
  export const fixed32le: any

  export const EncodeStream: any
  export const DecodeStream: any
  export const Reserved: any
  export const Pointer: any
  export const LazyArray: any
  export const Boolean: any
  export * from "restructure"
}

