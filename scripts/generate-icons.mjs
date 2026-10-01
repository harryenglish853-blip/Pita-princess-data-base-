// Generates the PWA icons (plain PNGs, no dependencies): teal tile with a white crate glyph.
import fs from 'node:fs';
import zlib from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, maskable) {
  const teal = [15, 118, 110], white = [255, 255, 255];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const pad = maskable ? 0.28 : 0.22;
  const a = size * pad, b = size * (1 - pad);
  const stroke = Math.max(2, Math.round(size * 0.045));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let col = teal;
      const inBox = x >= a && x <= b && y >= a && y <= b;
      const edge = inBox && (x < a + stroke || x > b - stroke || y < a + stroke || y > b - stroke);
      const lid = inBox && Math.abs(y - (a + (b - a) * 0.33)) < stroke / 2;
      const slot = inBox && Math.abs(x - size / 2) < stroke / 2 && y < a + (b - a) * 0.33;
      if (edge || lid || slot) col = white;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync('public/icons/icon-192.png', png(192));
fs.writeFileSync('public/icons/icon-512.png', png(512));
fs.writeFileSync('public/icons/icon-512-maskable.png', png(512, true));
fs.writeFileSync('public/icons/apple-touch-icon.png', png(180, true));
console.log('icons written');
