// Mirror of SkyrimNet's Content::FormRef (src/Content/FormRef.cpp): the `Plugin.esp|0x01396B` spelling,
// its map key and its filename stem, pinned on both sides by tests/fixtures/form-ref-cases.json.

import { foldCase } from "./content-rules.mjs";

const FORM_REF_SEPARATOR = "|";
const LOCAL_ID_MASK = 0x00ffffff;
export const ESL_LOCAL_ID_MASK = 0x00000fff;
const MAX_LOCAL_ID_HEX_DIGITS = 8;
const LOCAL_ID_HEX_DIGITS = 6;
const STEM_PREFIX_BYTES = 40;
const FNV1A32_OFFSET = 0x811c9dc5;
const FNV1A32_PRIME = 0x01000193;

const STEM_EXTENSION_MARKERS = { ".esp": "", ".esm": "-esm", ".esl": "-esl" };
const ESL_EXTENSION = ".esl";

// Core's TrimWhitespace: space, tab, CR and LF only.
const OUTER_WHITESPACE_RE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/** FNV-1a 32-bit over UTF-8 bytes, as 8 lowercase hex digits. */
export function fnv1a32Hex(text) {
  let h = FNV1A32_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    h = Math.imul(h ^ byte, FNV1A32_PRIME) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The 24-bit local id as six upper-case hex digits. */
export function localIdHex(localId) {
  return (localId & LOCAL_ID_MASK).toString(16).toUpperCase().padStart(LOCAL_ID_HEX_DIGITS, "0");
}

function localIdSuffix(localId) {
  return `${FORM_REF_SEPARATOR}0x${localIdHex(localId)}`;
}

/** `Plugin.esp|0x01396B`, the plugin as written: the canonical spelling for file bodies. */
export function formRefToString({ plugin, localId }) {
  return plugin + localIdSuffix(localId);
}

/** Map key: ASCII-folded plugin plus the six-digit local id. */
export function formRefKey({ plugin, localId }) {
  return foldCase(plugin) + localIdSuffix(localId);
}

/** The plugin's extension from its last dot, ASCII-folded; empty without a dot. */
export function pluginExtension(plugin) {
  const folded = foldCase(plugin);
  const dot = folded.lastIndexOf(".");
  return dot === -1 ? "" : folded.slice(dot);
}

/** True when the plugin is an `.esl` file, whose local ids are 12 bits. */
export function isEslPlugin(plugin) {
  return pluginExtension(plugin) === ESL_EXTENSION;
}

function trimOuter(text) {
  return text.replace(OUTER_WHITESPACE_RE, "");
}

// `Plugin.esp|0x01396B` to { plugin, localId } or null: outer [ \t\r\n] trimmed, `0x` optional, hex case
// free; a missing or doubled separator, an empty half, a non-hex or over-24-bit id or a bad plugin name refuse.
export function parseFormRef(text) {
  if (typeof text !== "string") return null;
  const trimmed = trimOuter(text);
  const bar = trimmed.indexOf(FORM_REF_SEPARATOR);
  if (bar === -1) return null;
  const plugin = trimOuter(trimmed.slice(0, bar));
  const id = trimOuter(trimmed.slice(bar + 1));
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

// Filename stem `{prefix}{-esm|-esl}{-fnv1a32}_{LOCALID6}`: the folded name before the last dot with bytes outside
// [a-z0-9_] as `_`, cut at 40 bytes; the hash of the folded full filename when a byte was replaced, the prefix was cut or empty, or the extension is not .esp/.esm/.esl.
export function formStem({ plugin, localId }) {
  const folded = foldCase(plugin);
  const extension = pluginExtension(plugin);
  const name = folded.slice(0, folded.length - extension.length);

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
  return `${prefix}${marker}${hash}_${localIdHex(localId)}`;
}
