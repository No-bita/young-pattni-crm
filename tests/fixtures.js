// Local image fixtures. Real, decodable PNGs are built with zlib; JPEG fixtures are minimal
// byte sequences with a real SOF header (enough for format checks; never sent anywhere).
import { deflateSync, crc32 } from "node:zlib";

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

// colorType 2 = RGB, 6 = RGBA, 0 = greyscale, 3 = palette
export function png({ width = 64, height = 40, bitDepth = 8, colorType = 2, padTo = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const channels = { 2: 3, 6: 4, 0: 1, 3: 1 }[colorType];
  const rowLen = 1 + Math.ceil((width * channels * bitDepth) / 8);
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < width && bitDepth === 8; x++) {
      const o = y * rowLen + 1 + x * channels;
      if (channels >= 3) { raw[o] = 227; raw[o + 1] = 107 + ((x * 2) % 100); raw[o + 2] = 44 + y; if (channels === 4) raw[o + 3] = 255; }
    }
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (colorType === 3) parts.push(chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255])));
  parts.push(chunk("IDAT", deflateSync(raw)));
  if (padTo) parts.push(chunk("tEXt", Buffer.alloc(Math.max(0, padTo - 200), 65)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

export function jpeg({ components = 3, precision = 8, width = 120, height = 80 } = {}) {
  const sof = [0xff, 0xc0, 0x00, 8 + 3 * components, precision, height >> 8, height & 255, width >> 8, width & 255, components];
  for (let i = 0; i < components; i++) sof.push(i + 1, 0x11, 0);
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00, 0xff, 0xd9, ...new Array(16).fill(0)]);
}

export const gif = () => new Uint8Array([...Buffer.from("GIF89a"), ...new Array(40).fill(0)]);
export const textFile = () => new Uint8Array(Buffer.from("this is definitely not an image, just text pretending ".repeat(2)));
