// Synthetic image fixtures for the cover-image rules.
//
// makePng() emits a complete, decodable PNG (real chunks, real CRCs, a
// deflated one-colour body) so a fixture can also stand in for a real cover
// where something downstream might render it. makeJpeg() emits only the
// headers a JPEG parser reads dimensions from (SOI, APP0, SOFn, EOI): enough
// for the header-only sniff the hub performs, not a decodable picture.

import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** A valid RGB PNG of the given size, filled with one colour. */
export function makePng(width, height, rgb = [0x33, 0x66, 0x99]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const raw = Buffer.concat(Array(height).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker, payload) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}

/**
 * JPEG headers declaring the given size. `progressive` uses SOF2 instead of
 * SOF0; `fill` inserts 0xFF fill bytes before the frame marker, which the
 * standard permits and some encoders emit.
 */
export function makeJpeg(width, height, { progressive = false, fill = 0 } = {}) {
  const app0 = jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
  const sof = Buffer.alloc(9);
  sof[0] = 8; // precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1; // components
  sof[6] = 1; sof[7] = 0x11; sof[8] = 0;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    Buffer.alloc(fill, 0xff),
    jpegSegment(progressive ? 0xc2 : 0xc0, sof),
    Buffer.from([0xff, 0xd9]),
  ]);
}
