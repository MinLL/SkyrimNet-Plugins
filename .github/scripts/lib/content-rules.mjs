// SkyrimNet Plugins — portable content rules
//
// The single source of truth for the structural rules that decide whether a
// plugin's content paths and manifest identity are acceptable. Deliberately
// dependency-free and side-effect-free: every export is a pure function over
// plain strings so the exact same rule set can be ported to the C++ installer
// (which never trusts CI — it re-validates every path before anything touches
// disk).
//
// The rules mirror CONTENT_STORE_DESIGN.md:
//   §5 step 3 — path sanitization (separators, traversal, ADS, device names,
//               control characters, trailing dot/space, charset, root
//               whitelist, per-root exact-suffix extension whitelist)
//   §2        — reserved author namespace (author segment only), reserved
//               `characters/dynamic/` paths and `.dynamic.prompt` extension,
//               case-folded path identity
//   §4        — manifest identity: `id` = {author}.{slug}, strict semver,
//               `min_skyrimnet_version` required for bundles
//
// Every rejection carries a stable machine code (see CODES). The test corpus
// in tests/fixtures/path-cases.json asserts against those codes, and the C++
// port is expected to consume the same corpus so both sides provably reject
// the same attacks.

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
};

// ----- Constants -----------------------------------------------------------

// Content roots accepted in v1 (§5 step 3 / §1 scope: prompts, triggers,
// actions). Knowledge packs are punted (§13) — `knowledge/` is deliberately
// NOT a root: the installer would refuse it, so the hub must too.
export const CONTENT_ROOTS = ["prompts", "triggers", "actions"];

// Per-root extension whitelist. Matched as an EXACT (byte-for-byte, case
// sensitive) suffix on the raw final segment — `.PROMPT`, `.yml`,
// `.prompt.bak` and `.yaml.txt` all fail.
export const EXTENSION_BY_ROOT = {
  prompts: ".prompt",
  triggers: ".yaml",
  actions: ".yaml",
};

// Reserved plugin-id author segment (§2 / decision 12). `skyrimnet` and
// anything prefixed `skyrimnet-` is official-content-only. Slugs and titles
// containing "skyrimnet" are explicitly allowed.
export const RESERVED_AUTHOR_EXACT = "skyrimnet";
export const RESERVED_AUTHOR_PREFIX = "skyrimnet-";

// Windows reserved device names. Reserved bare AND with any extension
// (`NUL`, `nul.prompt`, `COM1.yaml` all resolve to the device).
export const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
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

/** Filename stem: everything before the FIRST dot of the final segment. */
export function stemOf(pathOrName) {
  const base = String(pathOrName).split("/").pop() ?? "";
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
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

/**
 * Validate one plugin-relative content path (canonical logical form:
 * root-prefixed, `/` separators, extension included).
 *
 * Returns { ok: true } or { ok: false, code, message }. The first failing rule
 * wins, and rule order is part of the contract — the C++ port must evaluate
 * the same rules in the same order so rejection codes agree.
 */
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

/**
 * Case-folded collision detection across one plugin's content paths. Windows
 * filesystems are case-insensitive, so two paths differing only in case are
 * one file at install time — the loser silently disappears.
 *
 * Returns an array of { key, paths } groups (empty when clean).
 */
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

/**
 * The in-file `name` of a trigger or action must equal its filename stem —
 * path is the only identity, so a divergent in-file name is a second identity.
 */
export function checkNameMatchesStem(name, filenameOrPath) {
  const stem = stemOf(filenameOrPath);
  if (typeof name !== "string" || name.length === 0) {
    return reject(CODES.NAME_MISSING, "File has no 'name' field.");
  }
  if (name !== stem) {
    return reject(
      CODES.NAME_NOT_STEM,
      `In-file name '${name}' does not match the filename stem '${stem}'. ` +
        `The filename is the identity — rename the file or the name so they match.`,
    );
  }
  return ok();
}

// ----- Manifest identity (§2, §4) -----------------------------------------

/**
 * Validate the identity fields of a manifest against the repo path it lives
 * at. `pathAuthor`/`pathSlug` are the `plugins/{author}/{slug}` segments.
 *
 * Returns { ok, issues: [{ code, message }] } — all issues, not just the
 * first, so a submitter sees everything wrong in one round trip.
 */
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
