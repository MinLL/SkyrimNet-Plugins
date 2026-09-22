// Rules for the one optional cover image a plugin may ship.
//
// The image is hub metadata, not content: it sits at the plugin root beside
// manifest.json, is named by `manifest.image`, is never installed by the
// engine, and is served to the hub pages, the in-game browse view and the
// Discord bot straight from the repo. Everything here is header-only — no
// decoder, no dependency — so the validator can refuse a file that is not the
// image it claims to be without ever executing anything from the PR.
//
// PNG and JPEG only. WebP is excluded because the in-game dashboard renders
// under Ultralight, whose image decoder has no WebP; GIF is excluded and an
// animated PNG (an `acTL` chunk) refused, so a cover is always a still. The
// extension must match the bytes, so a renamed file is refused rather than
// sniffed into acceptance.

import { RESERVED_DEVICE_NAMES } from "./content-rules.mjs";

export const IMAGE_MAX_BYTES = 1024 * 1024; // 1 MB
export const IMAGE_MAX_DIMENSION = 2048; // px, each side
export const IMAGE_MIN_DIMENSION = 128; // px, each side

// A bare filename at the plugin root: the same charset as content paths, no
// directories, an exact lowercase extension. Stem length matches
// MAX_SEGMENT_LENGTH's spirit without importing it — 64 is plenty for a cover.
export const IMAGE_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.(png|jpg|jpeg)$/;

export const IMAGE_CODES = {
  IMAGE_NAME: "IMAGE_NAME",
  IMAGE_ANIMATED: "IMAGE_ANIMATED",
  IMAGE_MISSING: "IMAGE_MISSING",
  IMAGE_UNDECLARED: "IMAGE_UNDECLARED",
  IMAGE_FORMAT: "IMAGE_FORMAT",
  IMAGE_EXT_MISMATCH: "IMAGE_EXT_MISMATCH",
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
  IMAGE_DIMENSIONS: "IMAGE_DIMENSIONS",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Is this bare filename an acceptable cover-image name? The shared path
 * rules never see the cover, so their Windows device-name refusal (`nul.png`
 * is the NUL device, and a checkout with that path fails for the whole tree)
 * is repeated here.
 */
export function isImageName(name) {
  if (typeof name !== "string" || !IMAGE_NAME_RE.test(name)) return false;
  return !RESERVED_DEVICE_NAMES.has(name.slice(0, name.indexOf(".")).toUpperCase());
}

/** The format a filename's extension claims: "png", "jpeg", or null. */
export function formatFromName(name) {
  if (!isImageName(name)) return null;
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return ext === "png" ? "png" : "jpeg";
}

/**
 * Read the format and pixel size out of an image's header.
 *
 * Returns `{ format: "png" | "jpeg", width, height }` or `null` when the
 * bytes are neither a PNG nor a JPEG with a readable frame header. Only the
 * header is inspected; a truncated or corrupt body is the renderer's problem,
 * not a hub concern.
 */
export function sniffImage(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return sniffPng(buf) ?? sniffJpeg(buf);
}

function sniffPng(buf) {
  // Signature, then the IHDR chunk must come first: length(4) "IHDR"(4)
  // width(4) height(4).
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { format: "png", width, height };
}

/**
 * An APNG declares itself with an `acTL` chunk between IHDR and the first
 * IDAT. Walk the chunk list that far; a malformed list reads as "not animated"
 * and the decoder is left to refuse it.
 */
function hasApngControl(buf) {
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + length; // length, type, data, crc
  }
  return false;
}

function sniffJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    // Fill bytes: any number of 0xFF may pad a marker.
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset += 1;
      marker = buf[offset + 1];
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any frame header
    if (offset + 4 > buf.length) return null;
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // SOFn: length(2) precision(1) height(2) width(2) components(1); a frame
      // header shorter than that is not one.
      if (length < 8 || offset + 9 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { format: "jpeg", width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Check one cover image: the declared name against its bytes.
 *
 * @param {{ name: string, bytes: Buffer | Uint8Array }} image
 * @returns {{ ok: boolean, issues: {code: string, message: string}[], info: object | null }}
 */
export function checkImage({ name, bytes }) {
  const issues = [];
  const reject = (code, message) => issues.push({ code, message });

  if (!isImageName(name)) {
    reject(
      IMAGE_CODES.IMAGE_NAME,
      `'${name}' is not a valid image filename. Use a bare filename at the plugin root ending in .png, .jpg or .jpeg (letters, digits, '_' and '-' only).`,
    );
    return { ok: false, issues, info: null };
  }

  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > IMAGE_MAX_BYTES) {
    reject(
      IMAGE_CODES.IMAGE_TOO_LARGE,
      `Image is ${formatBytes(buf.length)}, over the ${formatBytes(IMAGE_MAX_BYTES)} limit. Re-encode it as a JPEG or downscale it.`,
    );
  }

  const info = sniffImage(buf);
  if (!info) {
    reject(
      IMAGE_CODES.IMAGE_FORMAT,
      `'${name}' is not a PNG or JPEG image (the file header does not match either format).`,
    );
    return { ok: false, issues, info: null };
  }

  if (info.format === "png" && hasApngControl(buf)) {
    reject(IMAGE_CODES.IMAGE_ANIMATED, `'${name}' is an animated PNG; a cover must be a still image.`);
  }

  const claimed = formatFromName(name);
  if (claimed !== info.format) {
    reject(
      IMAGE_CODES.IMAGE_EXT_MISMATCH,
      `'${name}' is a ${info.format.toUpperCase()} file but its extension says ${claimed.toUpperCase()}. Rename it to match its contents.`,
    );
  }

  const { width, height } = info;
  if (
    width < IMAGE_MIN_DIMENSION || height < IMAGE_MIN_DIMENSION ||
    width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION
  ) {
    reject(
      IMAGE_CODES.IMAGE_DIMENSIONS,
      `Image is ${width}×${height}px; each side must be between ${IMAGE_MIN_DIMENSION} and ${IMAGE_MAX_DIMENSION}px.`,
    );
  }

  return { ok: issues.length === 0, issues, info };
}
