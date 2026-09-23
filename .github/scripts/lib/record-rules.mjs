// Per-root rules for what a record file carries: the field that must equal the filename stem, `kind`,
// `npc_usable`, list fields, `priority`, a rule's `pattern` and `npc:` references. Pure functions; validate.mjs
// wires them to files.

import { CODES, checkFieldMatchesStem, foldCase, quoteValue, stemOf } from "./content-rules.mjs";
import {
  ESL_LOCAL_ID_MASK,
  formRefToString,
  formStem,
  isEslPlugin,
  localIdHex,
  parseFormRef,
} from "./form-ref.mjs";

export const RECORD_CODES = {
  NOT_A_MAPPING: "NOT_A_MAPPING",
  KIND_MISSING: "KIND_MISSING",
  KIND_UNKNOWN: "KIND_UNKNOWN",
  FORM_MISSING: "FORM_MISSING",
  FORM_INVALID: "FORM_INVALID",
  FORM_ESL_WIDTH: "FORM_ESL_WIDTH",
  FORM_NOT_STEM: "FORM_NOT_STEM",
  ENABLED_NOT_ACTIVATION: "ENABLED_NOT_ACTIVATION",
  NPC_USABLE_NOT_BOOL: "NPC_USABLE_NOT_BOOL",
  SLUG_NOT_STEM: "SLUG_NOT_STEM",
  NPC_REF_LOAD_ORDER: "NPC_REF_LOAD_ORDER",
  NPC_REF_INVALID: "NPC_REF_INVALID",
  GLOBAL_NOT_STEM: "GLOBAL_NOT_STEM",
  CATEGORY_UNKNOWN: "CATEGORY_UNKNOWN",
  LIST_NOT_STRINGS: "LIST_NOT_STRINGS",
  PRIORITY_NOT_INTEGER: "PRIORITY_NOT_INTEGER",
  PATTERN_MISSING: "PATTERN_MISSING",
  PATTERN_TOO_LONG: "PATTERN_TOO_LONG",
  PATTERN_INVALID: "PATTERN_INVALID",
};

// The ten dialogue-action categories, as DialogueActionsConfig::Categories() names them.
export const DIALOGUE_ACTION_CATEGORIES = Object.freeze([
  "quest", "follower", "merchant", "trainer", "carriage",
  "innkeeper", "bard", "marriage", "crime", "other",
]);

// The `kind:` values each discriminated root accepts.
export const KINDS_BY_ROOT = Object.freeze({
  identity: ["link", "succession"],
  filters: ["actor", "memory", "dialogue_rule", "tts_rule"],
  translator: ["npc", "faction", "race", "global"],
  dialogue_actions: ["lists", "instruction"],
});

// The six list fields an actor or memory filter contribution may carry.
export const FILTER_LIST_FIELDS = Object.freeze([
  "FactionWhitelist", "FactionBlacklist", "RaceWhitelist", "RaceBlacklist", "GenderWhitelist", "GenderBlacklist",
]);

// The identity-link fields that may hold an `npc:` reference, per kind.
export const IDENTITY_REF_FIELDS = Object.freeze({ link: ["identityA", "identityB"], succession: ["from", "to"] });

const FORM_FIELD = "form";
const NPC_USABLE_FIELD = "npc_usable";
const TRANSLATOR_GLOBAL_STEM = "global";
const PRIORITY_FIELD = "priority";
const PATTERN_FIELD = "pattern";
// The engine's FilterRecords::kMaxPatternLength, in UTF-8 bytes.
export const MAX_PATTERN_LENGTH = 1024;
const NPC_REF_PREFIX = "npc:";
const NPC_REF_SPELLING = "npc:Plugin.esp:0xLocalID";
const RUNTIME_ID_MASK = 0x00ffffff;
const RUNTIME_ESL_PREFIX = 0xfe000000;
const RUNTIME_PREFIX_MASK = 0xff000000;

// Slug of an identity-link name: lowercase, each run outside [a-z0-9] one `_`, edges trimmed.
export function slugOf(name) {
  return foldCase(String(name)).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function issue(code, message) {
  return { code, message };
}

/** The record's `kind`, or `defaultKind` when absent; an issue and null when it is missing or unknown. */
function resolveKind(root, doc, push, defaultKind) {
  const allowed = KINDS_BY_ROOT[root];
  const kind = doc.kind === undefined ? defaultKind : doc.kind;
  if (kind === undefined) {
    push(RECORD_CODES.KIND_MISSING, `Files under ${root}/ need a 'kind' field: one of ${allowed.join(", ")}.`);
    return null;
  }
  if (typeof kind !== "string" || !allowed.includes(kind)) {
    push(
      RECORD_CODES.KIND_UNKNOWN,
      `kind is ${quoteValue(kind)}, not one a ${root}/ file may carry. Use one of ${allowed.join(", ")}.`,
    );
    return null;
  }
  return kind;
}

/** The 12-bit-masked twin of a FormRef whose `.esl` plugin got a wider id; null when the width is fine. */
function eslOverflow(ref) {
  if (!isEslPlugin(ref.plugin) || ref.localId <= ESL_LOCAL_ID_MASK) return null;
  return { plugin: ref.plugin, localId: ref.localId & ESL_LOCAL_ID_MASK };
}

function eslWidthMessage(field, raw, narrowed, spell) {
  return (
    `${field} ${quoteValue(raw)} has a local id above 0x${localIdHex(ESL_LOCAL_ID_MASK)}, but an .esl plugin's ids ` +
    `are 12 bits. Drop the load-order digits: '${spell(narrowed)}'.`
  );
}

/** `form` is a FormRef whose stem is the filename stem, exactly as the engine derives it. */
function checkFormIdentity(doc, subPath, push, why) {
  const raw = doc[FORM_FIELD];
  if (raw === undefined || raw === null || raw === "") {
    push(RECORD_CODES.FORM_MISSING, `${why} needs a '${FORM_FIELD}' field of the form 'Plugin.esp|0x01396B'.`);
    return;
  }
  const ref = typeof raw === "string" ? parseFormRef(raw) : null;
  if (ref === null) {
    push(
      RECORD_CODES.FORM_INVALID,
      `${FORM_FIELD} is ${quoteValue(raw)}, not a form reference. Expected 'Plugin.esp|0x01396B': the defining ` +
        `plugin's full filename, '|', and the plugin-relative id (up to 24 bits, 12 for an ESL)` +
        (typeof raw === "string" ? "." : ", as a quoted string."),
    );
    return;
  }
  const narrowed = eslOverflow(ref);
  if (narrowed !== null) {
    push(RECORD_CODES.FORM_ESL_WIDTH, eslWidthMessage(FORM_FIELD, raw, narrowed, formRefToString));
    return;
  }
  const expected = formStem(ref);
  const stem = stemOf(subPath);
  if (stem !== expected) {
    push(
      RECORD_CODES.FORM_NOT_STEM,
      `The filename stem '${stem}' is not the stem of ${FORM_FIELD} ${quoteValue(raw)}, which is '${expected}'. ` +
        `The filename is the identity — rename the file to '${expected}${subPath.slice(subPath.lastIndexOf("."))}'.`,
    );
  }
}

function npcRefToString({ plugin, localId }) {
  return `${NPC_REF_PREFIX}${plugin}:0x${localIdHex(localId)}`;
}

/** The plugin-relative id a runtime form id spells (FE-prefixed: 12 bits, else 24); null when it is not hex. */
function localIdOfRuntimeId(text) {
  const digits = /^0[xX]/.test(text) ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{1,8}$/.test(digits)) return null;
  const value = parseInt(digits, 16);
  if (value <= RUNTIME_ID_MASK) return value;
  const prefix = (value & RUNTIME_PREFIX_MASK) >>> 0;
  return prefix === RUNTIME_ESL_PREFIX ? value & ESL_LOCAL_ID_MASK : value & RUNTIME_ID_MASK;
}

/** An `npc:` reference is `npc:Plugin.esp:0xLocalID`; the plugin and id are a FormRef split at the last colon. */
function checkNpcRef(field, value, push) {
  if (typeof value !== "string" || !value.startsWith(NPC_REF_PREFIX)) return;
  const body = value.slice(NPC_REF_PREFIX.length);
  const lastColon = body.lastIndexOf(":");
  if (lastColon === -1) {
    const localId = localIdOfRuntimeId(body);
    const spelling = localId === null ? `'${NPC_REF_SPELLING}'` : `'npc:<Plugin.esp>:0x${localIdHex(localId)}'`;
    push(
      RECORD_CODES.NPC_REF_LOAD_ORDER,
      `${field} ${quoteValue(value)} is a runtime form id, which depends on load order. Spell it ${spelling}: ` +
        `the defining plugin's filename and the plugin-relative id.`,
    );
    return;
  }
  const ref = parseFormRef(`${body.slice(0, lastColon)}|${body.slice(lastColon + 1)}`);
  if (ref === null) {
    push(
      RECORD_CODES.NPC_REF_INVALID,
      `${field} ${quoteValue(value)} is not an NPC reference. Expected '${NPC_REF_SPELLING}': the defining ` +
        `plugin's full filename, ':', and the plugin-relative id (up to 24 bits, 12 for an ESL).`,
    );
    return;
  }
  const narrowed = eslOverflow(ref);
  if (narrowed !== null) push(RECORD_CODES.FORM_ESL_WIDTH, eslWidthMessage(field, value, narrowed, npcRefToString));
}

function pushStemCheck(field, value, subPath, push) {
  const res = checkFieldMatchesStem(field, value, subPath);
  if (!res.ok) push(res.code, res.message);
}

function checkStringList(doc, field, push) {
  const list = doc[field];
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    push(RECORD_CODES.LIST_NOT_STRINGS, `'${field}' must be a list of strings, not ${quoteValue(list)}.`);
    return;
  }
  const bad = list.findIndex((s) => typeof s !== "string");
  if (bad !== -1) {
    push(RECORD_CODES.LIST_NOT_STRINGS, `'${field}' must be a list of strings; entry ${bad + 1} is ${quoteValue(list[bad])}.`);
  }
}

function checkPriority(doc, push) {
  const value = doc[PRIORITY_FIELD];
  if (value !== undefined && !Number.isInteger(value)) {
    push(
      RECORD_CODES.PRIORITY_NOT_INTEGER,
      `'${PRIORITY_FIELD}' must be an integer (lower runs first; 100 when omitted), not ${quoteValue(value)}.`,
    );
  }
}

// A rule's `pattern`: a non-empty string within the engine's byte cap that compiles. `new RegExp` is a coarse
// stand-in for the engine's std::regex; it catches the unbalanced and the malformed, not every dialect gap.
function checkPattern(doc, kind, push) {
  const value = doc[PATTERN_FIELD];
  if (typeof value !== "string" || value.length === 0) {
    push(
      RECORD_CODES.PATTERN_MISSING,
      `A '${kind}' needs a '${PATTERN_FIELD}' field: a non-empty regular expression string` +
        (value === undefined ? "." : `, not ${quoteValue(value)}.`),
    );
    return;
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_PATTERN_LENGTH) {
    push(
      RECORD_CODES.PATTERN_TOO_LONG,
      `'${PATTERN_FIELD}' is ${bytes} bytes, over the ${MAX_PATTERN_LENGTH} byte limit the engine applies.`,
    );
    return;
  }
  try {
    new RegExp(value);
  } catch (err) {
    push(RECORD_CODES.PATTERN_INVALID, `'${PATTERN_FIELD}' ${quoteValue(value)} does not compile: ${err.message}`);
  }
}

function checkNpcUsable(doc, root, push) {
  if (doc.enabled !== undefined) {
    push(
      RECORD_CODES.ENABLED_NOT_ACTIVATION,
      `'enabled' in a ${root}/ file means record activation (the user's on/off toggle), not whether NPCs ` +
        `may use the form. Say '${NPC_USABLE_FIELD}: ${doc.enabled === false ? "false" : "true"}' instead.`,
    );
  }
  if (doc[NPC_USABLE_FIELD] !== undefined && typeof doc[NPC_USABLE_FIELD] !== "boolean") {
    push(RECORD_CODES.NPC_USABLE_NOT_BOOL, `'${NPC_USABLE_FIELD}' must be true or false.`);
  }
}

const CHECKS = {
  voice_effects(doc, subPath, push) {
    pushStemCheck("id", doc.id, subPath, push);
  },

  items(doc, subPath, push) {
    checkFormIdentity(doc, subPath, push, "An item customization");
    checkNpcUsable(doc, "items", push);
  },

  spells(doc, subPath, push) {
    checkFormIdentity(doc, subPath, push, "A spell customization");
    checkNpcUsable(doc, "spells", push);
  },

  furniture(doc, subPath, push) {
    checkFormIdentity(doc, subPath, push, "A furniture name");
  },

  identity(doc, subPath, push) {
    const kind = resolveKind("identity", doc, push, "link");
    if (kind === null) return;
    if (typeof doc.name !== "string" || doc.name.length === 0) {
      push(CODES.NAME_MISSING, "File has no 'name' field.");
      return;
    }
    const expected = slugOf(doc.name);
    const stem = stemOf(subPath);
    if (expected.length === 0 || foldCase(stem) !== expected) {
      push(
        RECORD_CODES.SLUG_NOT_STEM,
        `The filename stem '${stem}' is not the slug of name ${quoteValue(doc.name)}` +
          (expected.length > 0 ? `, which is '${expected}'` : ", which has no slug (no letters or digits)") +
          ". The filename is the identity — rename the file or the link so they match.",
      );
    }
    for (const field of IDENTITY_REF_FIELDS[kind]) checkNpcRef(field, doc[field], push);
  },

  filters(doc, subPath, push) {
    const kind = resolveKind("filters", doc, push);
    if (kind === "actor" || kind === "memory") {
      for (const field of FILTER_LIST_FIELDS) checkStringList(doc, field, push);
    } else if (kind === "dialogue_rule" || kind === "tts_rule") {
      pushStemCheck("id", doc.id, subPath, push);
      checkPattern(doc, kind, push);
      checkPriority(doc, push);
    }
  },

  translator(doc, subPath, push) {
    const kind = resolveKind("translator", doc, push);
    if (kind === null) return;
    checkPriority(doc, push);
    if (kind === "npc") {
      checkFormIdentity(doc, subPath, push, "A 'kind: npc' translator rule is keyed on the actor base and");
    } else if (kind === "faction" || kind === "race") {
      pushStemCheck("entityEditorId", doc.entityEditorId, subPath, push);
    } else if (kind === "global") {
      const stem = stemOf(subPath);
      if (foldCase(stem) !== TRANSLATOR_GLOBAL_STEM) {
        push(
          RECORD_CODES.GLOBAL_NOT_STEM,
          `A 'kind: global' translator rule lives at translator/${TRANSLATOR_GLOBAL_STEM}.yaml, not '${stem}'.`,
        );
      }
    }
  },

  dialogue_actions(doc, subPath, push) {
    const kind = resolveKind("dialogue_actions", doc, push);
    if (kind === "lists") {
      checkStringList(doc, "whitelist", push);
      checkStringList(doc, "blacklist", push);
    } else if (kind === "instruction") {
      pushStemCheck("key", doc.key, subPath, push);
      const category = typeof doc.category === "string" ? foldCase(doc.category) : null;
      if (doc.category === undefined) {
        push(
          RECORD_CODES.CATEGORY_UNKNOWN,
          `An instruction needs a 'category': one of ${DIALOGUE_ACTION_CATEGORIES.join(", ")}.`,
        );
      } else if (category === null || !DIALOGUE_ACTION_CATEGORIES.includes(category)) {
        push(
          RECORD_CODES.CATEGORY_UNKNOWN,
          `category is ${quoteValue(doc.category)}, not a dialogue-action category. Use one of ` +
            `${DIALOGUE_ACTION_CATEGORIES.join(", ")}.`,
        );
      }
    }
  },
};

/** The roots these rules cover. */
export const RECORD_ROOTS = Object.freeze(Object.keys(CHECKS));

/** One parsed record under `root` at plugin-relative `subPath`: { ok, issues: [{ code, message }] }. */
export function checkRecord(root, doc, subPath) {
  const issues = [];
  const push = (code, message) => issues.push(issue(code, message));
  const check = CHECKS[root];
  if (check === undefined) throw new TypeError(`'${root}' is not a record root`);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    push(RECORD_CODES.NOT_A_MAPPING, `${root} files must contain a YAML mapping at the top level.`);
    return { ok: false, issues };
  }
  check(doc, subPath, push);
  return { ok: issues.length === 0, issues };
}
