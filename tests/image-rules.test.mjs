// Unit tests for .github/scripts/lib/image-rules.mjs: the header-only
// format/size/dimension checks on a plugin's cover image.

import test from "node:test";
import assert from "node:assert/strict";

import {
  IMAGE_CODES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MIN_DIMENSION,
  checkImage,
  formatFromName,
  isImageName,
  sniffImage,
} from "../.github/scripts/lib/image-rules.mjs";
import { makeJpeg, makePng } from "./helpers/images.mjs";

const codes = (res) => res.issues.map((i) => i.code);

test("image names: bare filename, lowercase png/jpg/jpeg only", () => {
  for (const ok of ["cover.png", "cover.jpg", "cover.jpeg", "My_Cover-2.png"]) {
    assert.equal(isImageName(ok), true, ok);
  }
  for (const bad of [
    "cover.PNG", "cover.webp", "cover.gif", "cover", "assets/cover.png", ".png",
    "cover.png.jpg", "cov er.png", "ünicode.png", "", undefined, null, 42,
  ]) {
    assert.equal(isImageName(bad), false, String(bad));
  }
  assert.equal(formatFromName("a.png"), "png");
  assert.equal(formatFromName("a.jpg"), "jpeg");
  assert.equal(formatFromName("a.jpeg"), "jpeg");
  assert.equal(formatFromName("a.webp"), null);
});

test("sniff reads PNG dimensions from IHDR", () => {
  assert.deepEqual(sniffImage(makePng(640, 360)), { format: "png", width: 640, height: 360 });
});

test("sniff reads JPEG dimensions from baseline, progressive and fill-padded frames", () => {
  assert.deepEqual(sniffImage(makeJpeg(1280, 720)), { format: "jpeg", width: 1280, height: 720 });
  assert.deepEqual(sniffImage(makeJpeg(300, 200, { progressive: true })), { format: "jpeg", width: 300, height: 200 });
  assert.deepEqual(sniffImage(makeJpeg(300, 200, { fill: 3 })), { format: "jpeg", width: 300, height: 200 });
});

test("sniff returns null for anything that is not a PNG or JPEG header", () => {
  assert.equal(sniffImage(Buffer.from("GIF89a")), null);
  assert.equal(sniffImage(Buffer.from("RIFF....WEBPVP8 ")), null);
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  // A PNG signature with no IHDR behind it.
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), null);
  // A JPEG that hits SOS before any frame header, and one truncated mid-segment.
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])), null);
  assert.equal(sniffImage(makeJpeg(10, 10).subarray(0, 8)), null);
});

test("checkImage accepts a well-formed cover", () => {
  const res = checkImage({ name: "cover.png", bytes: makePng(1280, 720) });
  assert.equal(res.ok, true, JSON.stringify(res.issues));
  assert.deepEqual(res.info, { format: "png", width: 1280, height: 720 });
  assert.equal(checkImage({ name: "cover.jpg", bytes: makeJpeg(1920, 1080) }).ok, true);
  assert.equal(checkImage({ name: "cover.jpeg", bytes: makeJpeg(1920, 1080) }).ok, true);
});

test("checkImage refuses a bad name before reading bytes", () => {
  const res = checkImage({ name: "cover.webp", bytes: makePng(500, 500) });
  assert.deepEqual(codes(res), [IMAGE_CODES.IMAGE_NAME]);
  assert.equal(res.info, null);
});

test("checkImage refuses bytes that are not an image", () => {
  const res = checkImage({ name: "cover.png", bytes: Buffer.from("not an image") });
  assert.deepEqual(codes(res), [IMAGE_CODES.IMAGE_FORMAT]);
});

test("checkImage refuses an extension that lies about the format", () => {
  assert.deepEqual(codes(checkImage({ name: "cover.jpg", bytes: makePng(500, 500) })), [IMAGE_CODES.IMAGE_EXT_MISMATCH]);
  assert.deepEqual(codes(checkImage({ name: "cover.png", bytes: makeJpeg(500, 500) })), [IMAGE_CODES.IMAGE_EXT_MISMATCH]);
});

test("checkImage enforces the byte cap", () => {
  const padded = Buffer.concat([makePng(500, 500), Buffer.alloc(IMAGE_MAX_BYTES)]);
  assert.deepEqual(codes(checkImage({ name: "cover.png", bytes: padded })), [IMAGE_CODES.IMAGE_TOO_LARGE]);
  const exact = Buffer.concat([makeJpeg(500, 500)]);
  assert.ok(exact.length < IMAGE_MAX_BYTES);
  assert.equal(checkImage({ name: "cover.jpg", bytes: exact }).ok, true);
});

test("checkImage enforces the dimension window on both sides", () => {
  const max = IMAGE_MAX_DIMENSION;
  const min = IMAGE_MIN_DIMENSION;
  assert.equal(checkImage({ name: "c.jpg", bytes: makeJpeg(max, max) }).ok, true);
  assert.equal(checkImage({ name: "c.jpg", bytes: makeJpeg(min, min) }).ok, true);
  for (const [w, h] of [[max + 1, 100], [100, max + 1], [min - 1, 500], [500, min - 1], [0, 0]]) {
    assert.deepEqual(codes(checkImage({ name: "c.jpg", bytes: makeJpeg(w, h) })), [IMAGE_CODES.IMAGE_DIMENSIONS], `${w}x${h}`);
  }
});

test("checkImage reports every failing rule at once", () => {
  const huge = Buffer.concat([makePng(IMAGE_MAX_DIMENSION + 1, 10), Buffer.alloc(IMAGE_MAX_BYTES)]);
  const res = checkImage({ name: "cover.jpg", bytes: huge });
  assert.deepEqual(codes(res).sort(), [
    IMAGE_CODES.IMAGE_DIMENSIONS, IMAGE_CODES.IMAGE_EXT_MISMATCH, IMAGE_CODES.IMAGE_TOO_LARGE,
  ].sort());
});
