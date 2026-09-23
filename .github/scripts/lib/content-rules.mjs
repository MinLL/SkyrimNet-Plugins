// Portable content rules: pure functions over strings, shared with the C++ installer
// (ContentPathRules.cpp) and pinned by tests/fixtures/path-cases.json; every rejection carries a CODES entry.

// ----- Codes ---------------------------------------------------------------

export const CODES = {
  // path rules
  EMPTY_PATH: "EMPTY_PATH",
  BACKSLASH: "BACKSLASH",
  CONTROL_CHAR: "CONTROL_CHAR",
  EMPTY_SEGMENT: "EMPTY_SEGMENT",
  DOT_SEGMENT: "DOT_SEGMENT",
  DOT_DOT: "DOT_DOT",
  DRIVE_LETTER: "DRIVE_LETTER",
  ADS_COLON: "ADS_COLON",
  TRAILING_DOT_OR_SPACE: "TRAILING_DOT_OR_SPACE",
  RESERVED_DEVICE_NAME: "RESERVED_DEVICE_NAME",
  CHARSET: "CHARSET",
  SEGMENT_TOO_LONG: "SEGMENT_TOO_LONG",
  PATH_TOO_LONG: "PATH_TOO_LONG",
  UNKNOWN_ROOT: "UNKNOWN_ROOT",
  NO_FILE_IN_ROOT: "NO_FILE_IN_ROOT",
  BAD_EXTENSION: "BAD_EXTENSION",
  EMPTY_STEM: "EMPTY_STEM",
  RESERVED_DYNAMIC: "RESERVED_DYNAMIC",
  PATH_COLLISION: "PATH_COLLISION",
  // manifest identity rules
  ID_MISSING: "ID_MISSING",
  ID_FORMAT: "ID_FORMAT",
  ID_PATH_MISMATCH: "ID_PATH_MISMATCH",
  ID_AUTHOR_MISMATCH: "ID_AUTHOR_MISMATCH",
  RESERVED_AUTHOR: "RESERVED_AUTHOR",
  AUTHOR_MISSING: "AUTHOR_MISSING",
  VERSION_MISSING: "VERSION_MISSING",
  VERSION_NOT_SEMVER: "VERSION_NOT_SEMVER",
  MIN_VERSION_MISSING: "MIN_VERSION_MISSING",
  MIN_VERSION_NOT_SEMVER: "MIN_VERSION_NOT_SEMVER",
  // trigger/action in-file name
  NAME_MISSING: "NAME_MISSING",
  NAME_NOT_STEM: "NAME_NOT_STEM",
  // per-root minimum engine release
  ROOT_MIN_VERSION: "ROOT_MIN_VERSION",
  ROOT_RESERVED: "ROOT_RESERVED",
};

// ----- Constants -----------------------------------------------------------

// `minEngine` of a root no SkyrimNet release reads yet: every plugin shipping it is refused.
export const RESERVED_MIN_ENGINE = "reserved";

// One row per content root; pairs with the engine's table in ContentPaths.cpp. `minEngine` is null
// (ungated), RESERVED_MIN_ENGINE, or the oldest release that reads the root. Record rules: record-rules.mjs.
export const ROOT_TABLE = Object.freeze([
  { segment: "prompts", extension: ".prompt", minEngine: null },
  { segment: "triggers", extension: ".yaml", minEngine: null }, // `name` == stem
  { segment: "actions", extension: ".yaml", minEngine: null }, // `name` == stem
  { segment: "knowledge", extension: ".sknpack", minEngine: null },
  { segment: "entities", extension: ".entity.yaml", minEngine: null }, // stem is before the first dot
  { segment: "voice_effects", extension: ".yaml", minEngine: RESERVED_MIN_ENGINE }, // `id` == stem
  { segment: "items", extension: ".yaml", minEngine: RESERVED_MIN_ENGINE }, // formStem(form) == stem
  { segment: "spells", extension: ".yaml", minEngine: RESERVED_MIN_ENGINE }, // formStem(form) == stem
  { segment: "furniture", extension: ".yaml", minEngine: RESERVED_MIN_ENGINE }, // formStem(form) == stem
  { segment: "identity", extension: ".yaml", minEngine: RESERVED_MIN_ENGINE }, // slugOf(name) == stem
  { segment: "filters", extension: ".yaml", minEngine: RESERVED_MIN_ENGINE }, // by `kind`
  { segment: "translator", extension: ".yaml", minEngine: RESERVED_MIN_ENGINE }, // by `kind`
  { segment: "dialogue_actions", extension: ".yaml", minEngine: RESERVED_MIN_ENGINE }, // by `kind`
]);

// Content roots accepted by the hub, in table order.
export const CONTENT_ROOTS = ROOT_TABLE.map((row) => row.segment);

// Per-root extension, matched as an exact case-sensitive suffix of the final segment.
export const EXTENSION_BY_ROOT = Object.fromEntries(ROOT_TABLE.map((row) => [row.segment, row.extension]));

// Per-root `minEngine`, as the table spells it.
export const ROOT_MIN_ENGINE = Object.fromEntries(ROOT_TABLE.map((row) => [row.segment, row.minEngine]));

// Reserved plugin-id author segment (§2 / decision 12). `skyrimnet` and
// anything prefixed `skyrimnet-` is official-content-only. Slugs and titles
// containing "skyrimnet" are explicitly allowed.
export const RESERVED_AUTHOR_EXACT = "skyrimnet";
export const RESERVED_AUTHOR_PREFIX = "skyrimnet-";

// Windows reserved device names. Reserved bare AND with any extension
// (`NUL`, `nul.prompt`, `COM1.yaml` all resolve to the device).
//
// COM0 and LPT0 are included: Microsoft's current naming guidance reserves the
// full COM0-9 / LPT0-9 ranges, not 1-9. Two-digit names (COM10, LPT10) are NOT
// reserved and stay legal. CONIN$ / CONOUT$ need no entry — `$` is outside the
// allowed charset, so the charset rule rejects them before this one runs.
export const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

// Safe ASCII subset for v1 (§5 step 3). Localized display names go through the
// translation mechanism, never through filenames.
const SEGMENT_CHARSET_RE = /^[A-Za-z0-9._-]+$/;

export const MAX_SEGMENT_LENGTH = 100;
export const MAX_PATH_LENGTH = 240;

// Plugin id segments: fateless handle charset, no dots (the dot is the
// separator in `{author}.{slug}`), lowercase — ids are canonical, while the
// repo path and the manifest author field are compared case-folded.
export const ID_SEGMENT_RE = /^[a-z0-9_-]{1,64}$/;

// Repo path segments may carry display case (`plugins/Zevick/...`); they must
// case-fold onto the id segments.
export const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Official semver.org strict pattern.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// ----- Small helpers -------------------------------------------------------

/** ASCII-only case fold — path identity is compared case-insensitively (§2). */
export function foldCase(s) {
  return String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function isStrictSemver(v) {
  return typeof v === "string" && SEMVER_RE.test(v);
}

const NUMERIC_IDENTIFIER_RE = /^(0|[1-9]\d*)$/;

// Pre-release identifiers: numeric ones compare as numbers and rank below alphanumeric ones, which compare ASCII.
function comparePrereleaseIdentifier(a, b) {
  const aNumeric = NUMERIC_IDENTIFIER_RE.test(a);
  const bNumeric = NUMERIC_IDENTIFIER_RE.test(b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  if (aNumeric && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Semver precedence of two strict-semver strings (negative, zero, positive), as Core's CompareSemVer:
// numeric core, a pre-release below its release, pre-release identifiers dot by dot, build metadata ignored.
export function compareSemver(a, b) {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new TypeError(`compareSemver needs strict semver, got ${quoteValue(a)} and ${quoteValue(b)}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const preA = pa[4] ?? null;
  const preB = pb[4] ?? null;
  if (preA === null || preB === null) return preA === preB ? 0 : preA === null ? 1 : -1;
  const partsA = preA.split(".");
  const partsB = preB.split(".");
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    const d = comparePrereleaseIdentifier(partsA[i], partsB[i]);
    if (d !== 0) return d;
  }
  return partsA.length - partsB.length;
}

/** Filename stem: everything before the FIRST dot of the final segment. */
export function stemOf(pathOrName) {
  const base = String(pathOrName).split("/").pop() ?? "";
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

export const MAX_QUOTED_VALUE_LENGTH = 80;

// A YAML value as an error message shows it: a short string quoted, anything else described by shape.
export function quoteValue(value) {
  if (typeof value === "string") {
    return value.length > MAX_QUOTED_VALUE_LENGTH ? `'${value.slice(0, MAX_QUOTED_VALUE_LENGTH)}…'` : `'${value}'`;
  }
  if (value === null || value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return `the ${typeof value} ${String(value)}`;
}

export function isReservedAuthorSegment(segment) {
  const folded = foldCase(segment ?? "");
  return folded === RESERVED_AUTHOR_EXACT || folded.startsWith(RESERVED_AUTHOR_PREFIX);
}

function ok() {
  return { ok: true, code: null, message: null };
}

function reject(code, message) {
  return { ok: false, code, message };
}

// ----- Path rules (§5 step 3) ---------------------------------------------

// One plugin-relative content path (root-prefixed, `/` separators, extension included) to
// { ok } or { ok: false, code, message }. Rule order is part of the contract with the C++ port.
export function checkContentPath(rawPath) {
  const p = typeof rawPath === "string" ? rawPath : "";

  if (p.length === 0) {
    return reject(CODES.EMPTY_PATH, "Path is empty.");
  }
  if (p.length > MAX_PATH_LENGTH) {
    return reject(
      CODES.PATH_TOO_LONG,
      `Path is ${p.length} characters, exceeding the ${MAX_PATH_LENGTH} character limit.`,
    );
  }
  // Backslashes are legal inside a git path segment but act as separators on
  // Windows — they escape the sandbox. Rejected anywhere, always.
  if (p.includes("\\")) {
    return reject(CODES.BACKSLASH, "Path contains a backslash. Use '/' separators only.");
  }
  for (const ch of p) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) {
      return reject(
        CODES.CONTROL_CHAR,
        `Path contains a control character (U+${c.toString(16).padStart(4, "0").toUpperCase()}).`,
      );
    }
  }

  const segments = p.split("/");

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.length === 0) {
      return reject(
        CODES.EMPTY_SEGMENT,
        "Path has an empty segment (leading, trailing or doubled '/').",
      );
    }
    if (seg === "..") {
      return reject(CODES.DOT_DOT, "Path contains a '..' traversal segment.");
    }
    if (seg === ".") {
      return reject(CODES.DOT_SEGMENT, "Path contains a '.' segment.");
    }
    if (seg.includes(":")) {
      if (i === 0 && /^[A-Za-z]:/.test(seg)) {
        return reject(CODES.DRIVE_LETTER, "Path starts with a drive letter.");
      }
      return reject(
        CODES.ADS_COLON,
        "Path contains ':' (NTFS alternate data stream separator).",
      );
    }
    if (seg.length > MAX_SEGMENT_LENGTH) {
      return reject(
        CODES.SEGMENT_TOO_LONG,
        `Path segment '${seg}' is ${seg.length} characters, exceeding the ${MAX_SEGMENT_LENGTH} character limit.`,
      );
    }
    // Windows silently strips trailing dots and spaces on create, so
    // `foo.prompt ` and `foo.prompt.` are aliases for `foo.prompt`.
    if (/[. ]$/.test(seg)) {
      return reject(
        CODES.TRAILING_DOT_OR_SPACE,
        `Path segment '${seg}' ends with a dot or space.`,
      );
    }
    const deviceStem = seg.split(".")[0].toUpperCase();
    if (RESERVED_DEVICE_NAMES.has(deviceStem)) {
      return reject(
        CODES.RESERVED_DEVICE_NAME,
        `Path segment '${seg}' is a Windows reserved device name.`,
      );
    }
    if (!SEGMENT_CHARSET_RE.test(seg)) {
      return reject(
        CODES.CHARSET,
        `Path segment '${seg}' contains characters outside the allowed set (A-Z a-z 0-9 . _ -).`,
      );
    }
  }

  const root = segments[0];
  if (!CONTENT_ROOTS.includes(root)) {
    return reject(
      CODES.UNKNOWN_ROOT,
      `'${root}' is not a content root. Files must live under ${CONTENT_ROOTS.map((r) => `${r}/`).join(", ")}.`,
    );
  }
  if (segments.length < 2) {
    return reject(CODES.NO_FILE_IN_ROOT, "Path names a content root but no file inside it.");
  }

  const filename = segments[segments.length - 1];
  const ext = EXTENSION_BY_ROOT[root];
  if (!filename.endsWith(ext)) {
    return reject(
      CODES.BAD_EXTENSION,
      `Files under ${root}/ must end in '${ext}' (exact, lowercase). Got '${filename}'.`,
    );
  }
  if (filename.length === ext.length) {
    return reject(CODES.EMPTY_STEM, `'${filename}' has no filename before the extension.`);
  }

  // Reserved runtime-generated content (§2): dynamic bios are per-save
  // user-generated content and are never distributable.
  if (foldCase(filename).endsWith(".dynamic.prompt")) {
    return reject(
      CODES.RESERVED_DYNAMIC,
      "The '.dynamic.prompt' extension is reserved for engine-generated per-save character bios.",
    );
  }
  for (let i = 1; i < segments.length - 1; i++) {
    if (foldCase(segments[i]) === "dynamic" && foldCase(segments[i - 1]) === "characters") {
      return reject(
        CODES.RESERVED_DYNAMIC,
        "'characters/dynamic/' is reserved for engine-generated per-save character bios.",
      );
    }
  }

  return ok();
}

// Groups of paths that are one file on a case-insensitive filesystem: [{ key, paths }], empty when clean.
export function findPathCollisions(paths) {
  const byKey = new Map();
  for (const p of paths) {
    const key = foldCase(p);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const out = [];
  for (const [key, group] of byKey) {
    if (group.length > 1) out.push({ key, paths: group });
  }
  return out;
}

// ----- Trigger / action in-file name (§2, decision 5) ---------------------

// A trigger's or action's in-file `name` must equal its filename stem, case-insensitively.
export function checkNameMatchesStem(name, filenameOrPath) {
  return checkFieldMatchesStem("name", name, filenameOrPath);
}

// In-file `field` (a non-empty string) must equal the filename stem, case-insensitively.
export function checkFieldMatchesStem(field, value, filenameOrPath) {
  const stem = stemOf(filenameOrPath);
  if (typeof value !== "string" || value.length === 0) {
    return reject(CODES.NAME_MISSING, `File has no '${field}' field.`);
  }
  if (foldCase(value) !== foldCase(stem)) {
    return reject(
      CODES.NAME_NOT_STEM,
      `In-file ${field} ${quoteValue(value)} does not match the filename stem '${stem}' ` +
        `(compared case-insensitively). The filename is the identity — rename the file or the ${field} so they match.`,
    );
  }
  return ok();
}

// ----- Per-root minimum engine release ------------------------------------

// A root's `minEngine` against the manifest's `min_skyrimnet_version`: null passes, RESERVED_MIN_ENGINE
// refuses, a version requires at least itself. A non-semver `minVersion` is the manifest rules' business.
export function checkRootMinEngine(root, minVersion, minEngineByRoot = ROOT_MIN_ENGINE) {
  const required = minEngineByRoot[root] ?? null;
  if (required === null) return ok();
  if (required === RESERVED_MIN_ENGINE) {
    return reject(
      CODES.ROOT_RESERVED,
      `Files under ${root}/ cannot be published yet: no SkyrimNet release reads ${root}/. ` +
        `The root opens with the release that reads it.`,
    );
  }
  if (!isStrictSemver(minVersion)) return ok();
  if (compareSemver(minVersion, required) < 0) {
    return reject(
      CODES.ROOT_MIN_VERSION,
      `Files under ${root}/ need SkyrimNet ${required} or newer, but manifest.min_skyrimnet_version ` +
        `is '${minVersion}'. Raise it to at least ${required}.`,
    );
  }
  return ok();
}

// ----- Manifest identity (§2, §4) -----------------------------------------

// A manifest's identity fields against its `plugins/{pathAuthor}/{pathSlug}` directory:
// { ok, issues: [{ code, message }] }, every issue at once.
export function checkManifestIdentity({ manifest, pathAuthor, pathSlug }) {
  const issues = [];
  const push = (code, message) => issues.push({ code, message });

  const m = manifest ?? {};
  const isBundle = m.type !== "listing";

  // --- id ---
  let idAuthor = null;
  let idSlug = null;
  if (typeof m.id !== "string" || m.id.length === 0) {
    push(CODES.ID_MISSING, "manifest.id is required. Format: '{author}.{slug}'.");
  } else {
    const parts = m.id.split(".");
    if (parts.length !== 2 || !ID_SEGMENT_RE.test(parts[0]) || !ID_SEGMENT_RE.test(parts[1])) {
      push(
        CODES.ID_FORMAT,
        `manifest.id '${m.id}' is malformed. Expected '{author}.{slug}' where each ` +
          `segment is lowercase [a-z0-9_-] (1-64 chars) and contains no dots.`,
      );
    } else {
      idAuthor = parts[0];
      idSlug = parts[1];
    }
  }

  // --- reserved author namespace (§2) — author segment only. Checked against
  // every author-bearing surface so a mismatch can't smuggle one through.
  // Slugs and titles containing "skyrimnet" are explicitly allowed.
  const reservedHits = [idAuthor, pathAuthor, m.author].filter(
    (a) => typeof a === "string" && a.length > 0 && isReservedAuthorSegment(a),
  );
  if (reservedHits.length > 0) {
    push(
      CODES.RESERVED_AUTHOR,
      `Author '${reservedHits[0]}' is reserved: the author segment 'skyrimnet' and the ` +
        `'skyrimnet-' prefix are for official SkyrimNet content only. Plugin slugs and ` +
        `titles may freely contain "skyrimnet".`,
    );
  }

  // --- id vs path (case-folded) ---
  if (idAuthor !== null) {
    if (foldCase(idAuthor) !== foldCase(pathAuthor ?? "") || foldCase(idSlug) !== foldCase(pathSlug ?? "")) {
      push(
        CODES.ID_PATH_MISMATCH,
        `manifest.id '${m.id}' does not match its directory 'plugins/${pathAuthor}/${pathSlug}'. ` +
          `The id must be '{author}.{slug}' of the path it lives at (compared case-insensitively).`,
      );
    }
  }

  // --- id vs manifest.author (case-folded) ---
  if (typeof m.author !== "string" || m.author.length === 0) {
    push(CODES.AUTHOR_MISSING, "manifest.author is required.");
  } else if (idAuthor !== null && foldCase(idAuthor) !== foldCase(m.author)) {
    push(
      CODES.ID_AUTHOR_MISMATCH,
      `manifest.id author segment '${idAuthor}' does not match manifest.author '${m.author}'.`,
    );
  }

  // --- version (strict semver) ---
  if (m.version === undefined || m.version === null || m.version === "") {
    if (isBundle) push(CODES.VERSION_MISSING, "manifest.version is required for bundles.");
  } else if (!isStrictSemver(m.version)) {
    push(
      CODES.VERSION_NOT_SEMVER,
      `manifest.version '${m.version}' is not strict semver (MAJOR.MINOR.PATCH). ` +
        `Versions drive update, rollback and duplicate-id resolution, so they must parse.`,
    );
  }

  // --- min_skyrimnet_version (bundles only, strict semver) ---
  if (isBundle) {
    if (
      m.min_skyrimnet_version === undefined ||
      m.min_skyrimnet_version === null ||
      m.min_skyrimnet_version === ""
    ) {
      push(
        CODES.MIN_VERSION_MISSING,
        "manifest.min_skyrimnet_version is required for bundles. The dashboard stamps it " +
          "automatically with the running SkyrimNet version at publish time.",
      );
    } else if (!isStrictSemver(m.min_skyrimnet_version)) {
      push(
        CODES.MIN_VERSION_NOT_SEMVER,
        `manifest.min_skyrimnet_version '${m.min_skyrimnet_version}' is not strict semver ` +
          `(MAJOR.MINOR.PATCH). The install-time compatibility gate compares it numerically.`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
