import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { xwdToPng } from '../src/xwd';

/** Build a minimal XWD (version 7, ZPixmap, 32 bpp, LSB first) like Xvfb's -fbdir output. */
function xwd(w: number, h: number, px: (x: number, y: number) => number) {
  const name = Buffer.from('xvfb\0');
  const header = Buffer.alloc(100);
  const vals = [100 + name.length, 7, 2, 24, w, h, 0, 0, 32, 0, 32, 32, w * 4, 4, 0xff0000, 0xff00, 0xff, 8, 0, 0, w, h, 0, 0, 0];
  vals.forEach((v, i) => header.writeUInt32BE(v >>> 0, i * 4));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.writeUInt32LE(px(x, y), (y * w + x) * 4);
  return Buffer.concat([header, name, data]);
}

describe('xwd → png', () => {
  it('decodes pixel colors exactly', () => {
    const { png, width, height } = xwdToPng(xwd(3, 2, (x, y) => (y === 0 ? [0xff0000, 0x00ff00, 0x0000ff][x] : 0x123456)));
    expect([width, height]).toEqual([3, 2]);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
    const raw = inflateSync(idat);
    expect([...raw.subarray(0, 10)]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    expect([...raw.subarray(10, 14)]).toEqual([0, 0x12, 0x34, 0x56]);
  });
  it('rejects formats it cannot read', () => {
    const bad = xwd(1, 1, () => 0); bad.writeUInt32BE(6, 4);
    expect(() => xwdToPng(bad)).toThrow(/Unsupported XWD/);
    expect(() => xwdToPng(Buffer.alloc(10))).toThrow(/too short/);
  });
});
