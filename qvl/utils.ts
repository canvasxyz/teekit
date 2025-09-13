export const hex = (b: Buffer) => b.toString("hex")

export const reverseHexBytes = (h: string) => {
  return Buffer.from(h, "hex").reverse().toString("hex")
}
