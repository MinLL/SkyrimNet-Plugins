// SkyrimNet Plugins — per-root record rules
//
// The config-system roots (voice_effects, items, spells, furniture, identity,
// filters, translator, dialogue_actions) hold one YAML record per file, and
// the record's identity is its filename stem. These rules say, per root,
// which in-file field must equal the stem and what else the engine would
// otherwise skip or misread. Pure functions over the parsed document and the
// plugin-relative path; validate.mjs wires them to files and reporting.
//
// The engine skips a record that breaks these rules with a warning; the hub
// refuses it, so nothing that cannot load gets published.

import {
  CODES,
  IDENTITY,
  IDENTITY_BY_ROOT,
  checkFieldMatchesStem,
  foldCase,
  stemOf,
} from "./content-rules.mjs";
import { formStem, parseFormRef } from "./form-ref.mjs";

export const RECORD_CODES = {
  NOT_A_MAPPING: "NOT_A_MAPPING",
  KIND_MISSING: "KIND_MISSING",
  KIND_UNKNOWN: "KIND_UNKNOWN",
  FORM_MISSING: "FORM_MISSING",
  FORM_INVALID: "FORM_INVALID",
  FORM_NOT_STEM: "FORM_NOT_STEM",
  ENABLED_NOT_ACTIVATION: "ENABLED_NOT_ACTIVATION",
  NPC_USABLE_NOT_BOOL: "NPC_USABLE_NOT_BOOL",
  SLUG_NOT_STEM: "SLUG_NOT_STEM",
  GLOBAL_NOT_STEM: "GLOBAL_NOT_STEM",
  CATEGORY_UNKNOWN: "CATEGORY_UNKNOWN",
  LIST_NOT_STRINGS: "LIST_NOT_STRINGS",
};

// The ten dialogue-action categories, as DialogueActionsConfig::Categories() names them.
export const DIALOGUE_ACTION_CATEGORIES = Object.freeze([
  "quest", "follower", "merchant", "trainer", "carriage",
  "innkeeper", "bard", "marriage", "crime", "other",
]);

// The `kind:` values each discriminated root accepts, and the default where one exists.
export const KINDS_BY_ROOT = Object.freeze({
  identity: ["link", "succession"],
  filters: ["actor", "memory", "dialogue_rule", "tts_rule"],
  translator: ["npc", "faction", "race", "global"],
  dialogue_actions: ["lists", "instruction"],
});
export const DEFAULT_KIND_BY_ROOT = Object.freeze({ identity: "link" });

// The in-file field that carries a form-keyed record's FormRef (`Plugin.esp|0x01396B`).
export const FORM_FIELD = "form";
// The spell/item payload flag; `enabled:` on those roots is refused in its favour.
export const NPC_USABLE_FIELD = "npc_usable";
export const TRANSLATOR_GLOBAL_STEM = "global";

/**
 * Slug of an identity-link name: ASCII-folded to lowercase, every run of
 * characters outside [a-z0-9] becomes one `_`, edges trimmed.
 */
export function slugOf(name) {
  return foldCase(String(name)).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function issue(code, message) {
  return { code, message };
}

/** The record's `kind`, defaulted per root; an issue when it is missing or unknown. */
function resolveKind(root, doc, push) {
  const allowed = KINDS_BY_ROOT[root];
  const kind = doc.kind === undefined ? DEFAULT_KIND_BY_ROOT[root] : doc.kind;
  if (kind === undefined) {
    push(RECORD_CODES.KIND_MISSING, `Files under ${root}/ need a 'kind' field: one of ${allowed.join(", ")}.`);
    return null;
  }
  if (!allowed.includes(kind)) {
    push(
      RECORD_CODES.KIND_UNKNOWN,
      `kind '${kind}' is not one a ${root}/ file may carry. Use one of ${allowed.join(", ")}.`,
    );
    return null;
  }
  return kind;
}

/** `form` is a FormRef whose stem is the filename stem, exactly as the engine derives it. */
function checkFormIdentity(doc, subPath, push, why) {
  const raw = doc[FORM_FIELD];
  if (raw === undefined || raw === null || raw === "") {
    push(RECORD_CODES.FORM_MISSING, `${why} needs a '${FORM_FIELD}' field of the form 'Plugin.esp|0x01396B'.`);
    return;
  }
  // A bare `0x01396B` parses as a YAML integer; say so rather than "missing".
  const ref = typeof raw === "string" ? parseFormRef(raw) : null;
  if (ref === null) {
    push(
      RECORD_CODES.FORM_INVALID,
      `${FORM_FIELD} ${JSON.stringify(raw)} is not a form reference. Expected 'Plugin.esp|0x01396B': the defining ` +
        `plugin's full filename, '|', and the plugin-relative id (up to 24 bits, 12 for an ESL)` +
        (typeof raw === "string" ? "." : ", as a quoted string."),
    );
    return;
  }
  const expected = formStem(ref);
  const stem = stemOf(subPath);
  if (stem !== expected) {
    push(
      RECORD_CODES.FORM_NOT_STEM,
      `The filename stem '${stem}' is not the stem of ${FORM_FIELD} '${raw}', which is '${expected}'. ` +
        `The filename is the identity — rename the file to '${expected}${subPath.slice(subPath.lastIndexOf("."))}'.`,
    );
  }
}

function pushStemCheck(field, value, subPath, push) {
  const res = checkFieldMatchesStem(field, value, subPath);
  if (!res.ok) push(res.code, res.message);
}

function checkStringList(doc, field, push) {
  const list = doc[field];
  if (list === undefined) return;
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
    push(RECORD_CODES.LIST_NOT_STRINGS, `'${field}' must be a list of strings.`);
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
    if (resolveKind("identity", doc, push) === null) return;
    if (typeof doc.name !== "string" || doc.name.length === 0) {
      push(CODES.NAME_MISSING, "File has no 'name' field.");
      return;
    }
    const expected = slugOf(doc.name);
    const stem = stemOf(subPath);
    if (expected.length === 0 || foldCase(stem) !== expected) {
      push(
        RECORD_CODES.SLUG_NOT_STEM,
        `The filename stem '${stem}' is not the slug of name '${doc.name}'` +
          (expected.length > 0 ? `, which is '${expected}'` : ", which has no slug (no letters or digits)") +
          ". The filename is the identity — rename the file or the link so they match.",
      );
    }
  },

  filters(doc, subPath, push) {
    const kind = resolveKind("filters", doc, push);
    if (kind === "dialogue_rule" || kind === "tts_rule") {
      pushStemCheck("id", doc.id, subPath, push);
    }
  },

  translator(doc, subPath, push) {
    const kind = resolveKind("translator", doc, push);
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
      if (category === null || !DIALOGUE_ACTION_CATEGORIES.includes(category)) {
        push(
          RECORD_CODES.CATEGORY_UNKNOWN,
          `category '${doc.category ?? ""}' is not a dialogue-action category. Use one of ` +
            `${DIALOGUE_ACTION_CATEGORIES.join(", ")}.`,
        );
      }
    }
  },
};

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

/** The roots these rules cover: every root whose identity is not the bare path or `name`. */
export const RECORD_ROOTS = Object.freeze(Object.keys(CHECKS));

/**
 * Check one parsed record under `root` at plugin-relative `subPath`.
 * Returns { ok, issues: [{ code, message }] } with every issue found.
 */
export function checkRecord(root, doc, subPath) {
  const issues = [];
  const push = (code, message) => issues.push(issue(code, message));
  const check = CHECKS[root];
  if (check === undefined) {
    throw new TypeError(`'${root}' is not a record root (identity: ${IDENTITY_BY_ROOT[root] ?? "unknown"})`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    push(RECORD_CODES.NOT_A_MAPPING, `${root} files must contain a YAML mapping at the top level.`);
    return { ok: false, issues };
  }
  check(doc, subPath, push);
  return { ok: issues.length === 0, issues };
}

// Every table row whose identity is per-root or form-keyed has a check here.
for (const [root, identity] of Object.entries(IDENTITY_BY_ROOT)) {
  const covered = RECORD_ROOTS.includes(root);
  const needsCheck = identity !== IDENTITY.NONE && identity !== IDENTITY.NAME;
  if (covered !== needsCheck) {
    throw new Error(`record-rules.mjs and ROOT_TABLE disagree on '${root}' (identity ${identity})`);
  }
}
