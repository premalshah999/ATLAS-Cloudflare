// Screenshots straight from Xvfb's framebuffer (`-fbdir`, XWD format) encoded as PNG with node:zlib.
// No ImageMagick, so the same code works with Xvfb on Linux and XQuartz's Xvfb on macOS.
import { deflateSync } from 'node:zlib';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Buffer) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode 8-bit RGB pixels as PNG. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Convert an XWD image (ZPixmap, TrueColor, 24/32 bits per pixel) to PNG. */
export function xwdToPng(x: Buffer): { png: Buffer; width: number; height: number } {
  if (x.length < 100) throw new Error('XWD file too short');
  const f = (i: number) => x.readUInt32BE(i * 4);
  const headerSize = f(0), version = f(1), format = f(2), width = f(4), height = f(5), byteOrder = f(7), bpp = f(11), bpl = f(12);
  const masks = [f(14), f(15), f(16)], ncolors = f(19);
  if (version !== 7 || format !== 2) throw new Error(`Unsupported XWD (version ${version}, format ${format})`);
  if (bpp !== 32 && bpp !== 24) throw new Error(`Unsupported XWD depth ${bpp} bits per pixel`);
  const data = headerSize + ncolors * 12;
  if (x.length < data + bpl * height) throw new Error('XWD pixel data truncated');
  const shift = masks.map((m) => { let s = 0; while (m && !((m >>> s) & 1)) s++; return s; });
  const rgb = Buffer.alloc(width * height * 3);
  const step = bpp / 8;
  for (let y = 0; y < height; y++) {
    for (let col = 0; col < width; col++) {
      const o = data + y * bpl + col * step;
      const v = step === 4 ? (byteOrder === 0 ? x.readUInt32LE(o) : x.readUInt32BE(o)) : (byteOrder === 0 ? x[o] | (x[o + 1] << 8) | (x[o + 2] << 16) : (x[o] << 16) | (x[o + 1] << 8) | x[o + 2]);
      const p = (y * width + col) * 3;
      rgb[p] = (v & masks[0]) >>> shift[0]; rgb[p + 1] = (v & masks[1]) >>> shift[1]; rgb[p + 2] = (v & masks[2]) >>> shift[2];
    }
  }
  return { png: encodePng(width, height, rgb), width, height };
}
