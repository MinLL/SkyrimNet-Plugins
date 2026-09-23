// SkyrimNet Plugins — FormRef: one form reference, one normalizer
//
// Mirrors SkyrimNet's Content::FormRef (include/Content/FormRef.h) byte for
// byte: the spelling a record file carries (`Plugin.esp|0x01396B`), its map
// key, and the filename stem the engine derives from it. Dependency-free
// beyond the ASCII fold shared with the path rules, so the C++ side and this
// file can be pinned by one corpus, tests/fixtures/form-ref-cases.json.

import { foldCase } from "./content-rules.mjs";

const FORM_REF_SEPARATOR = "|";
const LOCAL_ID_MASK = 0x00ffffff;
const MAX_LOCAL_ID_HEX_DIGITS = 8;
const STEM_PREFIX_BYTES = 40;
const FNV1A32_OFFSET = 0x811c9dc5;
const FNV1A32_PRIME = 0x01000193;

const STEM_EXTENSION_MARKERS = { ".esp": "", ".esm": "-esm", ".esl": "-esl" };

/** FNV-1a 32-bit over UTF-8 bytes, as 8 lowercase hex digits. */
export function fnv1a32Hex(text) {
  let h = FNV1A32_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    h = Math.imul(h ^ byte, FNV1A32_PRIME) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function localIdSuffix(localId) {
  return `${FORM_REF_SEPARATOR}0x${(localId & LOCAL_ID_MASK).toString(16).toUpperCase().padStart(6, "0")}`;
}

/** `Plugin.esp|0x01396B`, the plugin as written: the canonical spelling for file bodies. */
export function formRefToString({ plugin, localId }) {
  return plugin + localIdSuffix(localId);
}

/** Map key: ASCII-folded plugin plus the six-digit local id. */
export function formRefKey({ plugin, localId }) {
  return foldCase(plugin) + localIdSuffix(localId);
}

/**
 * Parse `Plugin.esp|0x01396B` into { plugin, localId } or null. Outer
 * whitespace is trimmed, `0x` is optional, hex case is free; a missing or
 * doubled separator, an empty half, a non-hex or over-24-bit id, or a plugin
 * containing a path separator or being a bare extension all refuse.
 */
export function parseFormRef(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const bar = trimmed.indexOf(FORM_REF_SEPARATOR);
  if (bar === -1) return null;
  const plugin = trimmed.slice(0, bar).trim();
  const id = trimmed.slice(bar + 1).trim();
  if (!isPluginNameShaped(plugin)) return null;
  const localId = parseLocalId(id);
  if (localId === null) return null;
  return { plugin, localId };
}

function isPluginNameShaped(plugin) {
  if (plugin.length === 0 || plugin.lastIndexOf(".") === 0) return false;
  for (const ch of plugin) {
    const c = ch.codePointAt(0);
    if (ch === "/" || ch === "\\" || ch === FORM_REF_SEPARATOR || c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function parseLocalId(text) {
  const digits = /^0[xX]/.test(text) ? text.slice(2) : text;
  if (digits.length === 0 || digits.length > MAX_LOCAL_ID_HEX_DIGITS || !/^[0-9a-fA-F]+$/.test(digits)) {
    return null;
  }
  const value = parseInt(digits, 16);
  return value > LOCAL_ID_MASK ? null : value;
}

/**
 * Filename stem of a FormRef: `{prefix}{-esm|-esl}{-fnv1a32}_{LOCALID6}`.
 * The prefix is the ASCII-folded plugin name minus its extension (split on the
 * LAST dot), every byte outside [a-z0-9_] replaced by `_`, cut at 40 UTF-8
 * bytes without splitting a sequence. The hash of the folded full filename is
 * appended when a byte was replaced, the prefix was cut or is empty, or the
 * extension is not .esp/.esm/.esl.
 */
export function formStem({ plugin, localId }) {
  const folded = foldCase(plugin);
  const dot = folded.lastIndexOf(".");
  const name = dot === -1 ? folded : folded.slice(0, dot);
  const extension = dot === -1 ? "" : folded.slice(dot);

  let needHash = false;
  let marker = STEM_EXTENSION_MARKERS[extension];
  if (marker === undefined) {
    marker = "";
    needHash = true;
  }

  const bytes = new TextEncoder().encode(name);
  let cut = bytes.length;
  if (cut > STEM_PREFIX_BYTES) {
    cut = STEM_PREFIX_BYTES;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
    needHash = true;
  }
  let prefix = "";
  for (let i = 0; i < cut; i++) {
    const b = bytes[i];
    const isStemByte = (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x5f;
    if (isStemByte) {
      prefix += String.fromCharCode(b);
    } else {
      prefix += "_";
      needHash = true;
    }
  }
  if (prefix.length === 0) needHash = true;

  const hash = needHash ? `-${fnv1a32Hex(folded)}` : "";
  const id = (localId & LOCAL_ID_MASK).toString(16).toUpperCase().padStart(6, "0");
  return `${prefix}${marker}${hash}_${id}`;
}
