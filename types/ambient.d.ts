declare module "uint8arrays" {
  export function fromString(
    input: string,
    encoding?: "utf8" | "hex" | "base64" | "base64url" | "base64pad",
  ): Uint8Array
  export function toString(
    input: Uint8Array,
    encoding?: "utf8" | "hex" | "base64" | "base64url" | "base64pad",
  ): string
  export function concat(chunks: Uint8Array[], length?: number): Uint8Array
}

declare module "pkijs" {
  export const Certificate: any
  export const BasicConstraints: any
  export type RelativeDistinguishedNames = any
}

declare module "asn1js" {
  export function fromBER(input: ArrayBuffer | Uint8Array): any
}

