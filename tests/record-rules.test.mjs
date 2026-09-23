// Unit tests for .github/scripts/lib/record-rules.mjs on parsed documents: a passing and a failing
// document per rule. tests/validate.test.mjs runs the same rules end to end against files on disk.

import test from "node:test";
import assert from "node:assert/strict";

import { CODES } from "../.github/scripts/lib/content-rules.mjs";
import {
  DIALOGUE_ACTION_CATEGORIES,
  FILTER_LIST_FIELDS,
  IDENTITY_REF_FIELDS,
  KINDS_BY_ROOT,
  MAX_PATTERN_LENGTH,
  RECORD_CODES,
  RECORD_ROOTS,
  checkRecord,
  slugOf,
} from "../.github/scripts/lib/record-rules.mjs";

// Skyrim.esm|0x01396B has the stem skyrim-esm_01396B; Mod A.esp|0x000123 takes a hash.
const SKYRIM_FORM = "Skyrim.esm|0x01396B";
const SKYRIM_STEM = "skyrim-esm_01396B";
const HASHED_FORM = "Mod A.esp|0x000123";
const HASHED_STEM = "mod_a-a44f2ca6_000123";

function codes(res) {
  return res.issues.map((i) => i.code);
}

function assertOk(res) {
  assert.equal(res.ok, true, `expected no issues, got ${JSON.stringify(res.issues)}`);
}

function assertCode(res, code, needle) {
  assert.equal(res.ok, false, `expected ${code}, record was accepted`);
  assert.ok(codes(res).includes(code), `expected ${code}, got ${codes(res).join(", ")}`);
  if (needle) {
    const issue = res.issues.find((i) => i.code === code);
    assert.match(issue.message, needle);
  }
}

test("the record roots are the eight config-system roots", () => {
  assert.deepEqual(
    [...RECORD_ROOTS].sort(),
    ["dialogue_actions", "filters", "furniture", "identity", "items", "spells", "translator", "voice_effects"],
  );
  assert.throws(() => checkRecord("triggers", { name: "x" }, "triggers/x.yaml"), TypeError);
});

test("a record must be a YAML mapping", () => {
  for (const doc of [null, "text", 42, ["a", "b"]]) {
    assertCode(checkRecord("voice_effects", doc, "voice_effects/x.yaml"), RECORD_CODES.NOT_A_MAPPING);
  }
});

// ----- voice_effects: id == stem ------------------------------------------

test("voice_effects: id equals the stem, case-insensitively", () => {
  assertOk(checkRecord("voice_effects", { id: "draugr", name: "Draugr" }, "voice_effects/draugr.yaml"));
  assertOk(checkRecord("voice_effects", { id: "Draugr" }, "voice_effects/draugr.yaml"));
  assertOk(checkRecord("voice_effects", { id: "ve_1a2b3c" }, "voice_effects/nested/ve_1a2b3c.yaml"));
  assertCode(checkRecord("voice_effects", { id: "narrator_effect" }, "voice_effects/narrator_reverb.yaml"), CODES.NAME_NOT_STEM, /id 'narrator_effect'/);
  assertCode(checkRecord("voice_effects", { name: "Draugr" }, "voice_effects/draugr.yaml"), CODES.NAME_MISSING, /'id'/);
  // enabled is record activation on this root and is not refused.
  assertOk(checkRecord("voice_effects", { id: "draugr", enabled: false }, "voice_effects/draugr.yaml"));
});

// ----- items / spells / furniture: form stem -------------------------------

for (const root of ["items", "spells", "furniture"]) {
  test(`${root}: the filename stem is formStem(form)`, () => {
    assertOk(checkRecord(root, { form: SKYRIM_FORM, customName: "x" }, `${root}/${SKYRIM_STEM}.yaml`));
    assertOk(checkRecord(root, { form: HASHED_FORM }, `${root}/sub/${HASHED_STEM}.yaml`));
    assertOk(checkRecord(root, { form: " skyrim.esm | 1396b " }, `${root}/${SKYRIM_STEM}.yaml`));
    assertCode(checkRecord(root, { form: SKYRIM_FORM }, `${root}/${HASHED_STEM}.yaml`), RECORD_CODES.FORM_NOT_STEM, /skyrim-esm_01396B\.yaml/);
    // The form stem is exact: the engine derives the filename, so its case is not the author's.
    assertCode(checkRecord(root, { form: SKYRIM_FORM }, `${root}/${SKYRIM_STEM.toLowerCase()}.yaml`), RECORD_CODES.FORM_NOT_STEM);
    assertCode(checkRecord(root, { customName: "x" }, `${root}/${SKYRIM_STEM}.yaml`), RECORD_CODES.FORM_MISSING, /'form'/);
    assertCode(checkRecord(root, { form: "Skyrim.esm" }, `${root}/${SKYRIM_STEM}.yaml`), RECORD_CODES.FORM_INVALID, /Plugin\.esp\|0x01396B/);
    assertCode(checkRecord(root, { form: "0x01396B" }, `${root}/${SKYRIM_STEM}.yaml`), RECORD_CODES.FORM_INVALID);
    assertCode(checkRecord(root, { form: ".esp|0x1" }, `${root}/${SKYRIM_STEM}.yaml`), RECORD_CODES.FORM_INVALID);
  });

  test(`${root}: an .esl plugin's local id is 12 bits`, () => {
    assertOk(checkRecord(root, { form: "MyLight.esl|0xFFF" }, `${root}/mylight-esl_000FFF.yaml`));
    const wide = checkRecord(root, { form: "MyLight.esl|0x01ABCD" }, `${root}/mylight-esl_01ABCD.yaml`);
    assertCode(wide, RECORD_CODES.FORM_ESL_WIDTH, /12 bits\. Drop the load-order digits: 'MyLight\.esl\|0x000BCD'/);
    assert.equal(wide.issues.length, 1);
    // An .esp with the same id is a full-width 24-bit id.
    assertOk(checkRecord(root, { form: "MyMod.esp|0x01ABCD" }, `${root}/mymod_01ABCD.yaml`));
  });
}

test("a YAML value is never echoed raw: a list or mapping is described, a long string is cut", () => {
  const list = checkRecord("items", { form: ["Skyrim.esm", "0x01396B"] }, `items/${SKYRIM_STEM}.yaml`);
  assertCode(list, RECORD_CODES.FORM_INVALID, /^form is a list, not a form reference/);
  const mapping = checkRecord("items", { form: { plugin: "Skyrim.esm" } }, `items/${SKYRIM_STEM}.yaml`);
  assertCode(mapping, RECORD_CODES.FORM_INVALID, /^form is a mapping, not a form reference/);
  const number = checkRecord("items", { form: 77773 }, `items/${SKYRIM_STEM}.yaml`);
  assertCode(number, RECORD_CODES.FORM_INVALID, /^form is the number 77773, not a form reference[^\n]*as a quoted string\.$/);
  const kind = checkRecord("filters", { kind: ["actor"] }, "filters/x.yaml");
  assertCode(kind, RECORD_CODES.KIND_UNKNOWN, /^kind is a list, not one a filters\/ file may carry/);
  const category = checkRecord(
    "dialogue_actions",
    { kind: "instruction", key: "x", category: { a: 1 } },
    "dialogue_actions/x.yaml",
  );
  assertCode(category, RECORD_CODES.CATEGORY_UNKNOWN, /^category is a mapping, not a dialogue-action category/);
  const long = "Long Name ".repeat(20);
  const name = checkRecord("identity", { name: long }, "identity/x.yaml");
  assertCode(name, RECORD_CODES.SLUG_NOT_STEM, /'(Long Name ){8}…'/);
  assert.ok(!name.issues[0].message.includes(long));
});

for (const root of ["items", "spells"]) {
  test(`${root}: 'enabled' is refused in favour of npc_usable`, () => {
    assertOk(checkRecord(root, { form: SKYRIM_FORM, npc_usable: false }, `${root}/${SKYRIM_STEM}.yaml`));
    assertOk(checkRecord(root, { form: SKYRIM_FORM, npc_usable: true }, `${root}/${SKYRIM_STEM}.yaml`));
    const off = checkRecord(root, { form: SKYRIM_FORM, enabled: false }, `${root}/${SKYRIM_STEM}.yaml`);
    assertCode(off, RECORD_CODES.ENABLED_NOT_ACTIVATION, /npc_usable: false/);
    const on = checkRecord(root, { form: SKYRIM_FORM, enabled: true }, `${root}/${SKYRIM_STEM}.yaml`);
    assertCode(on, RECORD_CODES.ENABLED_NOT_ACTIVATION, /npc_usable: true/);
    assertCode(checkRecord(root, { form: SKYRIM_FORM, npc_usable: "no" }, `${root}/${SKYRIM_STEM}.yaml`), RECORD_CODES.NPC_USABLE_NOT_BOOL);
  });
}

test("furniture: enabled is not refused (the registry toggle is the only activation)", () => {
  assertOk(checkRecord("furniture", { form: SKYRIM_FORM, enabled: false }, `furniture/${SKYRIM_STEM}.yaml`));
});

// ----- identity: slug(name) == stem, kind link | succession ----------------

test("slugOf folds to lowercase and collapses runs outside [a-z0-9] to one underscore", () => {
  assert.equal(slugOf("Serana's Shadow"), "serana_s_shadow");
  assert.equal(slugOf("  The Whispering Voice  "), "the_whispering_voice");
  assert.equal(slugOf("Link-2.0 (alt)"), "link_2_0_alt");
  assert.equal(slugOf("already_a_slug"), "already_a_slug");
  assert.equal(slugOf("Мод"), "");
});

test("identity: the stem is the slug of the link name; kind defaults to link", () => {
  assert.deepEqual(KINDS_BY_ROOT.identity, ["link", "succession"]);
  assertOk(checkRecord("identity", { name: "Serana's Shadow", identityA: "virtual:Shadow", identityB: "npc:Dawnguard.esm:0x002B74" }, "identity/serana_s_shadow.yaml"));
  assertOk(checkRecord("identity", { kind: "link", name: "Whispering Voice" }, "identity/Whispering_Voice.yaml"));
  assertOk(checkRecord("identity", { kind: "succession", name: "Line of Kings", from: "npc:Skyrim.esm:0x0350B8", to: "npc:Skyrim.esm:0x0656E2" }, "identity/line_of_kings.yaml"));
  assertCode(checkRecord("identity", { name: "Serana's Shadow" }, "identity/shadow.yaml"), RECORD_CODES.SLUG_NOT_STEM, /'serana_s_shadow'/);
  assertCode(checkRecord("identity", { name: "Мод" }, "identity/mod.yaml"), RECORD_CODES.SLUG_NOT_STEM, /no slug/);
  assertCode(checkRecord("identity", { kind: "link" }, "identity/x.yaml"), CODES.NAME_MISSING);
  assertCode(checkRecord("identity", { kind: "merge", name: "x" }, "identity/x.yaml"), RECORD_CODES.KIND_UNKNOWN, /kind is 'merge'[^\n]*link, succession/);
});

test("identity: an npc: reference is npc:Plugin.esp:0xLocalID; the runtime-id spelling is refused", () => {
  assert.deepEqual(IDENTITY_REF_FIELDS, { link: ["identityA", "identityB"], succession: ["from", "to"] });
  const link = (fields) => checkRecord("identity", { name: "L", ...fields }, "identity/l.yaml");
  assertOk(link({ identityA: "npc:Skyrim.esm:0x01A66D", identityB: "npc: Dawnguard.esm : 2B74" }));
  assertOk(link({ identityA: "npc:MyLight.esl:0xFFF" }));
  const legacy = link({ identityA: "npc:0A012345" });
  assertCode(legacy, RECORD_CODES.NPC_REF_LOAD_ORDER, /^identityA 'npc:0A012345' is a runtime form id[^\n]*'npc:<Plugin\.esp>:0x012345'/);
  assertCode(link({ identityB: "npc:0xFE01ABCD" }), RECORD_CODES.NPC_REF_LOAD_ORDER, /identityB[^\n]*'npc:<Plugin\.esp>:0x000BCD'/);
  assertCode(link({ identityA: "npc:serana" }), RECORD_CODES.NPC_REF_LOAD_ORDER, /'npc:Plugin\.esp:0xLocalID'/);
  assertCode(link({ identityA: "npc:Skyrim.esm:0x0A01A66D" }), RECORD_CODES.NPC_REF_INVALID, /^identityA 'npc:Skyrim\.esm:0x0A01A66D' is not an NPC reference/);
  assertCode(link({ identityA: "npc::0x1" }), RECORD_CODES.NPC_REF_INVALID);
  assertCode(link({ identityA: "npc:MyLight.esl:0x01ABCD" }), RECORD_CODES.FORM_ESL_WIDTH, /Drop the load-order digits: 'npc:MyLight\.esl:0x000BCD'/);
  // Succession fields get the same check; other spellings and non-strings are not this rule's business.
  const succession = (fields) => checkRecord("identity", { kind: "succession", name: "S", ...fields }, "identity/s.yaml");
  assertCode(succession({ from: "npc:0350B8", to: "npc:Skyrim.esm:0x0656E2" }), RECORD_CODES.NPC_REF_LOAD_ORDER, /^from /);
  assertOk(succession({ from: "virtual:Old King", to: 42 }));
  assertOk(link({ identityA: "npc:0A012345", kind: "succession" }));
});

// ----- filters: contributions any stem, rules id == stem -------------------

test("filters: kind is required; contributions take any stem, rules need id == stem", () => {
  assert.deepEqual(KINDS_BY_ROOT.filters, ["actor", "memory", "dialogue_rule", "tts_rule"]);
  assertOk(checkRecord("filters", { kind: "actor", RaceWhitelist: ["KhajiitRace"] }, "filters/my_races.yaml"));
  assertOk(checkRecord("filters", { kind: "memory", FactionBlacklist: [] }, "filters/anything.yaml"));
  assertOk(checkRecord("filters", { kind: "dialogue_rule", id: "strip_grunts", pattern: "^ugh", replacement: "" }, "filters/strip_grunts.yaml"));
  assertOk(checkRecord("filters", { kind: "tts_rule", id: "Numbers", pattern: "\\d+" }, "filters/numbers.yaml"));
  assertCode(checkRecord("filters", { RaceWhitelist: [] }, "filters/x.yaml"), RECORD_CODES.KIND_MISSING, /actor, memory, dialogue_rule, tts_rule/);
  assertCode(checkRecord("filters", { kind: "npc" }, "filters/x.yaml"), RECORD_CODES.KIND_UNKNOWN);
  assertCode(checkRecord("filters", { kind: "dialogue_rule", id: "other", pattern: "x" }, "filters/strip_grunts.yaml"), CODES.NAME_NOT_STEM, /id 'other'/);
  assertCode(checkRecord("filters", { kind: "tts_rule", pattern: "x" }, "filters/numbers.yaml"), CODES.NAME_MISSING);
});

test("filter rules need a pattern: a non-empty string within the engine's byte cap that compiles", () => {
  assert.equal(MAX_PATTERN_LENGTH, 1024);
  for (const kind of ["dialogue_rule", "tts_rule"]) {
    const rule = (fields) => checkRecord("filters", { kind, id: "x", ...fields }, "filters/x.yaml");
    assertOk(rule({ pattern: "^ugh" }));
    assertOk(rule({ pattern: "\\d+" }));
    assertOk(rule({ pattern: "a".repeat(MAX_PATTERN_LENGTH) }));
    assertCode(rule({}), RECORD_CODES.PATTERN_MISSING, new RegExp(`^A '${kind}' needs a 'pattern' field: a non-empty regular expression string\\.$`));
    assertCode(rule({ pattern: "" }), RECORD_CODES.PATTERN_MISSING, /needs a 'pattern' field[^\n]*, not ''\.$/);
    assertCode(rule({ pattern: 42 }), RECORD_CODES.PATTERN_MISSING, /not the number 42\.$/);
    assertCode(rule({ pattern: ["^ugh"] }), RECORD_CODES.PATTERN_MISSING, /not a list\.$/);
    assertCode(rule({ pattern: "(ugh" }), RECORD_CODES.PATTERN_INVALID, /^'pattern' '\(ugh' does not compile: /);
    assertCode(rule({ pattern: "a".repeat(MAX_PATTERN_LENGTH + 1) }), RECORD_CODES.PATTERN_TOO_LONG, /^'pattern' is 1025 bytes, over the 1024 byte limit/);
    // The cap is in UTF-8 bytes, as the engine measures it; an over-long pattern is not compiled.
    assertCode(rule({ pattern: "\u00e9".repeat(513) }), RECORD_CODES.PATTERN_TOO_LONG, /is 1026 bytes/);
    assert.deepEqual(codes(rule({ pattern: "(".repeat(MAX_PATTERN_LENGTH + 1) })), [RECORD_CODES.PATTERN_TOO_LONG]);
  }
  // Contributions carry no pattern; the field is not checked there.
  assertOk(checkRecord("filters", { kind: "actor", pattern: 42 }, "filters/x.yaml"));
});

test("filters: a contribution's six list fields must be lists of strings", () => {
  assert.deepEqual(FILTER_LIST_FIELDS, [
    "FactionWhitelist", "FactionBlacklist", "RaceWhitelist", "RaceBlacklist", "GenderWhitelist", "GenderBlacklist",
  ]);
  for (const kind of ["actor", "memory"]) {
    const all = Object.fromEntries(FILTER_LIST_FIELDS.map((f) => [f, ["x"]]));
    assertOk(checkRecord("filters", { kind, ...all }, "filters/x.yaml"));
    for (const field of FILTER_LIST_FIELDS) {
      const scalar = checkRecord("filters", { kind, [field]: "KhajiitRace" }, "filters/x.yaml");
      assertCode(scalar, RECORD_CODES.LIST_NOT_STRINGS, new RegExp(`^'${field}' must be a list of strings, not 'KhajiitRace'\\.$`));
      assertCode(checkRecord("filters", { kind, [field]: { a: 1 } }, "filters/x.yaml"), RECORD_CODES.LIST_NOT_STRINGS, /not a mapping/);
      assertCode(checkRecord("filters", { kind, [field]: ["a", 2] }, "filters/x.yaml"), RECORD_CODES.LIST_NOT_STRINGS, /entry 2 is the number 2/);
    }
  }
  // A rule's list-named field is not a contribution list.
  assertOk(checkRecord("filters", { kind: "dialogue_rule", id: "x", pattern: "x", RaceWhitelist: "no" }, "filters/x.yaml"));
});

test("filter rules and translator records carry an integer priority when they carry one", () => {
  for (const doc of [
    { kind: "dialogue_rule", id: "x", pattern: "x" },
    { kind: "tts_rule", id: "x", pattern: "x" },
  ]) {
    assertOk(checkRecord("filters", { ...doc, priority: 10 }, "filters/x.yaml"));
    assertOk(checkRecord("filters", { ...doc, priority: 0 }, "filters/x.yaml"));
    assertOk(checkRecord("filters", { ...doc, priority: -5 }, "filters/x.yaml"));
    assertOk(checkRecord("filters", doc, "filters/x.yaml"));
    assertCode(checkRecord("filters", { ...doc, priority: 1.5 }, "filters/x.yaml"), RECORD_CODES.PRIORITY_NOT_INTEGER, /'priority' must be an integer[^\n]*the number 1\.5/);
    assertCode(checkRecord("filters", { ...doc, priority: "10" }, "filters/x.yaml"), RECORD_CODES.PRIORITY_NOT_INTEGER, /'10'/);
  }
  // Contributions carry no priority; the field is not checked there.
  assertOk(checkRecord("filters", { kind: "actor", priority: "x" }, "filters/x.yaml"));
  assertOk(checkRecord("translator", { kind: "global", priority: 100 }, "translator/global.yaml"));
  assertOk(checkRecord("translator", { kind: "faction", entityEditorId: "X", priority: 1 }, "translator/x.yaml"));
  assertOk(checkRecord("translator", { kind: "npc", form: SKYRIM_FORM, priority: 1 }, `translator/${SKYRIM_STEM}.yaml`));
  assertCode(checkRecord("translator", { kind: "global", priority: true }, "translator/global.yaml"), RECORD_CODES.PRIORITY_NOT_INTEGER, /the boolean true/);
  assertCode(checkRecord("translator", { kind: "race", entityEditorId: "X", priority: [1] }, "translator/x.yaml"), RECORD_CODES.PRIORITY_NOT_INTEGER, /a list/);
});

// ----- translator: npc form stem, faction/race editor id, one global --------

test("translator: kind npc requires the actor base's form and takes its stem", () => {
  assert.deepEqual(KINDS_BY_ROOT.translator, ["npc", "faction", "race", "global"]);
  assertOk(checkRecord("translator", { kind: "npc", form: SKYRIM_FORM, speechPattern: "x" }, `translator/${SKYRIM_STEM}.yaml`));
  assertCode(checkRecord("translator", { kind: "npc", entityId: "serana_a2c" }, "translator/serana_a2c.yaml"), RECORD_CODES.FORM_MISSING, /kind: npc/);
  assertCode(checkRecord("translator", { kind: "npc", form: "0x0A2C" }, "translator/serana_a2c.yaml"), RECORD_CODES.FORM_INVALID);
  assertCode(checkRecord("translator", { kind: "npc", form: SKYRIM_FORM }, "translator/serana.yaml"), RECORD_CODES.FORM_NOT_STEM);
});

test("translator: faction and race rules are keyed on entityEditorId, global lives at global.yaml", () => {
  assertOk(checkRecord("translator", { kind: "faction", entityEditorId: "ThalmorFaction" }, "translator/thalmorfaction.yaml"));
  assertOk(checkRecord("translator", { kind: "race", entityEditorId: "KhajiitRace" }, "translator/KhajiitRace.yaml"));
  assertOk(checkRecord("translator", { kind: "global", speechPattern: "x" }, "translator/global.yaml"));
  assertCode(checkRecord("translator", { kind: "faction", entityEditorId: "ThalmorFaction" }, "translator/thalmorfaction_a2c.yaml"), CODES.NAME_NOT_STEM, /entityEditorId/);
  assertCode(checkRecord("translator", { kind: "race" }, "translator/khajiitrace.yaml"), CODES.NAME_MISSING, /'entityEditorId'/);
  assertCode(checkRecord("translator", { kind: "global" }, "translator/everyone.yaml"), RECORD_CODES.GLOBAL_NOT_STEM, /translator\/global\.yaml/);
  assertCode(checkRecord("translator", { speechPattern: "x" }, "translator/global.yaml"), RECORD_CODES.KIND_MISSING);
  assertCode(checkRecord("translator", { kind: "quest" }, "translator/x.yaml"), RECORD_CODES.KIND_UNKNOWN);
});

// ----- dialogue_actions: lists contribution, instruction key == stem --------

test("dialogue_actions: the ten categories match DialogueActionsConfig::Categories()", () => {
  assert.deepEqual(DIALOGUE_ACTION_CATEGORIES, [
    "quest", "follower", "merchant", "trainer", "carriage", "innkeeper", "bard", "marriage", "crime", "other",
  ]);
  assert.deepEqual(KINDS_BY_ROOT.dialogue_actions, ["lists", "instruction"]);
});

test("dialogue_actions: a lists contribution carries string lists under any stem", () => {
  assertOk(checkRecord("dialogue_actions", { kind: "lists", blacklist: ["nwsFollowerController", "TIF__000C3698"] }, "dialogue_actions/nff_defaults.yaml"));
  assertOk(checkRecord("dialogue_actions", { kind: "lists", whitelist: ["MyMod.esp|MyQuest"], blacklist: [] }, "dialogue_actions/any.yaml"));
  assertOk(checkRecord("dialogue_actions", { kind: "lists" }, "dialogue_actions/empty.yaml"));
  assertCode(checkRecord("dialogue_actions", { kind: "lists", blacklist: "nwsFollowerController" }, "dialogue_actions/x.yaml"), RECORD_CODES.LIST_NOT_STRINGS, /'blacklist'/);
  assertCode(checkRecord("dialogue_actions", { kind: "lists", whitelist: [1, 2] }, "dialogue_actions/x.yaml"), RECORD_CODES.LIST_NOT_STRINGS, /'whitelist'/);
  assertCode(checkRecord("dialogue_actions", { blacklist: [] }, "dialogue_actions/x.yaml"), RECORD_CODES.KIND_MISSING, /lists, instruction/);
  assertCode(checkRecord("dialogue_actions", { kind: "rules" }, "dialogue_actions/x.yaml"), RECORD_CODES.KIND_UNKNOWN);
});

test("dialogue_actions: an instruction is keyed on its TIF script name and names a category", () => {
  const good = { kind: "instruction", key: "TIF__000D9B53", name: "Rent a room", text: "Offer the room.", category: "innkeeper", enabled: true };
  assertOk(checkRecord("dialogue_actions", good, "dialogue_actions/TIF__000D9B53.yaml"));
  assertOk(checkRecord("dialogue_actions", { ...good, category: "Innkeeper" }, "dialogue_actions/tif__000d9b53.yaml"));
  assertCode(checkRecord("dialogue_actions", good, "dialogue_actions/rent_a_room.yaml"), CODES.NAME_NOT_STEM, /key 'TIF__000D9B53'/);
  assertCode(checkRecord("dialogue_actions", { ...good, key: undefined }, "dialogue_actions/TIF__000D9B53.yaml"), CODES.NAME_MISSING, /'key'/);
  const badCategory = checkRecord("dialogue_actions", { ...good, category: "lodging" }, "dialogue_actions/TIF__000D9B53.yaml");
  assertCode(badCategory, RECORD_CODES.CATEGORY_UNKNOWN, /quest, follower, merchant, trainer, carriage, innkeeper, bard, marriage, crime, other/);
  assertCode(checkRecord("dialogue_actions", { ...good, category: undefined }, "dialogue_actions/TIF__000D9B53.yaml"), RECORD_CODES.CATEGORY_UNKNOWN);
  assertCode(checkRecord("dialogue_actions", { ...good, category: 3 }, "dialogue_actions/TIF__000D9B53.yaml"), RECORD_CODES.CATEGORY_UNKNOWN);
});

test("every issue is reported, not just the first", () => {
  const res = checkRecord("spells", { enabled: false, npc_usable: "no" }, "spells/x.yaml");
  assert.deepEqual(codes(res).sort(), [
    RECORD_CODES.ENABLED_NOT_ACTIVATION, RECORD_CODES.FORM_MISSING, RECORD_CODES.NPC_USABLE_NOT_BOOL,
  ].sort());
});
