// Unit tests for the per-root record rules in .github/scripts/lib/record-rules.mjs.
//
// One passing and one failing document per rule, checked on the parsed
// document directly; tests/validate.test.mjs runs the same rules end to end
// through validate.mjs against files on disk.

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, IDENTITY_BY_ROOT } from "../.github/scripts/lib/content-rules.mjs";
import {
  DEFAULT_KIND_BY_ROOT,
  DIALOGUE_ACTION_CATEGORIES,
  KINDS_BY_ROOT,
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

test("the record roots are exactly the table rows with a per-root identity", () => {
  assert.deepEqual(
    [...RECORD_ROOTS].sort(),
    ["dialogue_actions", "filters", "furniture", "identity", "items", "spells", "translator", "voice_effects"],
  );
  for (const root of RECORD_ROOTS) assert.notEqual(IDENTITY_BY_ROOT[root], undefined);
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
}

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
  assert.equal(DEFAULT_KIND_BY_ROOT.identity, "link");
  assert.deepEqual(KINDS_BY_ROOT.identity, ["link", "succession"]);
  assertOk(checkRecord("identity", { name: "Serana's Shadow", npc: "Dawnguard.esm|0x002B74" }, "identity/serana_s_shadow.yaml"));
  assertOk(checkRecord("identity", { kind: "link", name: "Whispering Voice" }, "identity/Whispering_Voice.yaml"));
  assertOk(checkRecord("identity", { kind: "succession", name: "Line of Kings", from: "a", to: "b" }, "identity/line_of_kings.yaml"));
  assertCode(checkRecord("identity", { name: "Serana's Shadow" }, "identity/shadow.yaml"), RECORD_CODES.SLUG_NOT_STEM, /'serana_s_shadow'/);
  assertCode(checkRecord("identity", { name: "Мод" }, "identity/mod.yaml"), RECORD_CODES.SLUG_NOT_STEM, /no slug/);
  assertCode(checkRecord("identity", { kind: "link" }, "identity/x.yaml"), CODES.NAME_MISSING);
  assertCode(checkRecord("identity", { kind: "merge", name: "x" }, "identity/x.yaml"), RECORD_CODES.KIND_UNKNOWN, /link, succession/);
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
  assertCode(checkRecord("filters", { kind: "dialogue_rule", id: "other" }, "filters/strip_grunts.yaml"), CODES.NAME_NOT_STEM, /id 'other'/);
  assertCode(checkRecord("filters", { kind: "tts_rule", pattern: "x" }, "filters/numbers.yaml"), CODES.NAME_MISSING);
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
