// Corpus-driven tests for the portable content rules.
//
// Every case comes from tests/fixtures/path-cases.json — the shared corpus the
// C++ installer validator is expected to port verbatim (see TESTING.md). Add
// attacks to the corpus, not to this file.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODES,
  CONTENT_ROOTS,
  EXTENSION_BY_ROOT,
  MAX_QUOTED_VALUE_LENGTH,
  RESERVED_MIN_ENGINE,
  ROOT_MIN_ENGINE,
  ROOT_TABLE,
  checkContentPath,
  checkFieldMatchesStem,
  checkManifestIdentity,
  checkNameMatchesStem,
  checkRootMinEngine,
  compareSemver,
  findPathCollisions,
  foldCase,
  isReservedAuthorSegment,
  isStrictSemver,
  quoteValue,
  stemOf,
} from "../.github/scripts/lib/content-rules.mjs";
import {
  fnv1a32Hex,
  formRefKey,
  formRefToString,
  formStem,
  parseFormRef,
} from "../.github/scripts/lib/form-ref.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "path-cases.json"), "utf8"),
);
// Copied verbatim from SkyrimNet-Core tests/test_data/form-ref-cases.json; the
// engine's FormRef suite runs the same file.
const formRefCorpus = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "form-ref-cases.json"), "utf8"),
);

function describePath(p) {
  return JSON.stringify(p);
}

test("corpus is well formed", () => {
  assert.ok(corpus.path_cases.length > 0);
  assert.ok(corpus.manifest_cases.length > 0);
  assert.ok(corpus.collision_cases.length > 0);
  assert.ok(corpus.name_stem_cases.length > 0);

  const knownCodes = new Set(Object.values(CODES));
  for (const c of [...corpus.path_cases, ...corpus.manifest_cases, ...corpus.name_stem_cases]) {
    assert.ok(c.expect === "accept" || c.expect === "reject", `bad expect on ${JSON.stringify(c)}`);
    if (c.expect === "reject") {
      assert.ok(
        knownCodes.has(c.reason),
        `reject case ${JSON.stringify(c.path ?? c.name ?? c.file)} names unknown code '${c.reason}'`,
      );
    }
  }
  for (const c of corpus.collision_cases) {
    if (c.expect === "reject") assert.equal(c.reason, CODES.PATH_COLLISION);
  }
});

test("path corpus", async (t) => {
  for (const c of corpus.path_cases) {
    await t.test(`${c.expect}: ${describePath(c.path)} (${c.reason})`, () => {
      const res = checkContentPath(c.path);
      if (c.expect === "accept") {
        assert.equal(res.ok, true, `expected accept but got ${res.code}: ${res.message}`);
      } else {
        assert.equal(res.ok, false, "expected reject but path was accepted");
        assert.equal(res.code, c.reason);
        assert.ok(typeof res.message === "string" && res.message.length > 0);
      }
    });
  }
});

test("collision corpus", async (t) => {
  for (const c of corpus.collision_cases) {
    await t.test(`${c.expect}: ${c.paths.join(", ")}`, () => {
      const collisions = findPathCollisions(c.paths);
      if (c.expect === "accept") {
        assert.deepEqual(collisions, []);
      } else {
        assert.ok(collisions.length > 0, "expected a case-folded collision");
        for (const group of collisions) {
          assert.ok(group.paths.length > 1);
        }
      }
    });
  }
});

test("manifest identity corpus", async (t) => {
  for (const c of corpus.manifest_cases) {
    await t.test(`${c.expect}: ${c.name}`, () => {
      const res = checkManifestIdentity({
        manifest: c.manifest,
        pathAuthor: c.path_author,
        pathSlug: c.path_slug,
      });
      const codes = res.issues.map((i) => i.code);
      if (c.expect === "accept") {
        assert.equal(res.ok, true, `expected accept but got ${codes.join(", ")}`);
      } else {
        assert.equal(res.ok, false, "expected reject but manifest was accepted");
        assert.ok(
          codes.includes(c.reason),
          `expected code ${c.reason} but got ${codes.join(", ") || "(none)"}`,
        );
      }
    });
  }
});

test("name==stem corpus", async (t) => {
  for (const c of corpus.name_stem_cases) {
    await t.test(`${c.expect}: ${c.file} name=${JSON.stringify(c.name)}`, () => {
      const res = checkNameMatchesStem(c.name, c.file);
      if (c.expect === "accept") {
        assert.equal(res.ok, true, `expected accept but got ${res.code}`);
      } else {
        assert.equal(res.ok, false);
        assert.equal(res.code, c.reason);
      }
    });
  }
});

// ----- Targeted unit checks the corpus shape can't express -----------------

test("the reserved namespace covers the author segment only", () => {
  assert.equal(isReservedAuthorSegment("skyrimnet"), true);
  assert.equal(isReservedAuthorSegment("SkyrimNet"), true);
  assert.equal(isReservedAuthorSegment("skyrimnet-official"), true);
  assert.equal(isReservedAuthorSegment("skyrimnet-bios-3dnpc"), true);
  assert.equal(isReservedAuthorSegment("skyrimnetfan"), false);
  assert.equal(isReservedAuthorSegment("notskyrimnet"), false);
  assert.equal(isReservedAuthorSegment("bob"), false);
});

test("'SkyrimNet FooBar Integration' by bob publishes cleanly", () => {
  const res = checkManifestIdentity({
    manifest: {
      id: "bob.skyrimnet-foobar-integration",
      type: "bundle",
      title: "SkyrimNet FooBar Integration",
      author: "bob",
      version: "0.1.0",
      min_skyrimnet_version: "0.25.0",
    },
    pathAuthor: "bob",
    pathSlug: "skyrimnet-foobar-integration",
  });
  assert.deepEqual(res.issues, []);
});

test("strict semver", () => {
  for (const good of ["0.0.0", "1.2.3", "10.20.30", "1.0.0-beta.1", "1.0.0+build.5", "1.0.0-rc.1+exp"]) {
    assert.equal(isStrictSemver(good), true, good);
  }
  for (const bad of ["1", "1.0", "1.0.0.0", "v1.0.0", "01.0.0", "1.0.0-", "0-19-0-0", "", null, 1]) {
    assert.equal(isStrictSemver(bad), false, String(bad));
  }
});

test("stem is everything before the first dot", () => {
  assert.equal(stemOf("triggers/combat_banter.yaml"), "combat_banter");
  assert.equal(stemOf("prompts/a.b.c.prompt"), "a");
  assert.equal(stemOf("noext"), "noext");
});

test("case folding is ASCII only", () => {
  assert.equal(foldCase("Prompts/Characters/LYDIA.prompt"), "prompts/characters/lydia.prompt");
  // Non-ASCII is left alone — such paths are rejected by the charset rule
  // before identity ever matters, and Windows case folding of non-ASCII is
  // locale-dependent (the C++ port must behave identically).
  assert.equal(foldCase("É"), "É");
});

test("every content root has an extension rule and rejects the others", () => {
  for (const root of CONTENT_ROOTS) {
    const ext = EXTENSION_BY_ROOT[root];
    assert.ok(typeof ext === "string" && ext.startsWith("."), `${root} has no extension rule`);
    assert.equal(checkContentPath(`${root}/ok${ext}`).ok, true);
    assert.equal(checkContentPath(`${root}/bad.exe`).code, CODES.BAD_EXTENSION);
  }
});

// ----- Root table ----------------------------------------------------------

const NEW_ROOTS = [
  "voice_effects", "items", "spells", "furniture", "identity", "filters", "translator", "dialogue_actions",
];

test("the root table has the five original roots and the eight config-system roots", () => {
  assert.deepEqual(CONTENT_ROOTS, ["prompts", "triggers", "actions", "knowledge", "entities", ...NEW_ROOTS]);
  for (const row of ROOT_TABLE) {
    assert.ok(
      row.minEngine === null || row.minEngine === RESERVED_MIN_ENGINE || isStrictSemver(row.minEngine),
      `${row.segment} minEngine`,
    );
    assert.equal(EXTENSION_BY_ROOT[row.segment], row.extension);
    assert.equal(ROOT_MIN_ENGINE[row.segment], row.minEngine);
  }
  for (const root of ["prompts", "triggers", "actions", "knowledge", "entities"]) {
    assert.equal(ROOT_MIN_ENGINE[root], null);
  }
  for (const root of NEW_ROOTS) {
    assert.equal(ROOT_MIN_ENGINE[root], RESERVED_MIN_ENGINE);
    assert.equal(EXTENSION_BY_ROOT[root], ".yaml");
  }
});

test("a new root's path is accepted and the unknown-root message names every root", () => {
  for (const root of NEW_ROOTS) {
    assert.equal(checkContentPath(`${root}/record.yaml`).ok, true);
    assert.equal(checkContentPath(`${root}/nested/record.yaml`).ok, true);
    assert.equal(checkContentPath(`${root}/record.yml`).code, CODES.BAD_EXTENSION);
  }
  const res = checkContentPath("catalogs/x.yaml");
  assert.equal(res.code, CODES.UNKNOWN_ROOT);
  for (const root of CONTENT_ROOTS) assert.ok(res.message.includes(`${root}/`), root);
});

test("semver comparison is numeric, pre-release sorts below release", () => {
  assert.ok(compareSemver("0.24.0", "0.25.0") < 0);
  assert.equal(compareSemver("0.25.0", "0.25.0"), 0);
  assert.ok(compareSemver("0.26.0", "0.25.0") > 0);
  assert.ok(compareSemver("0.25.10", "0.25.9") > 0);
  assert.ok(compareSemver("1.0.0", "0.99.99") > 0);
  assert.ok(compareSemver("1.0.0-rc.1", "1.0.0") < 0);
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0"), 0);
  assert.throws(() => compareSemver("1.0", "1.0.0"), TypeError);
});

test("semver pre-release identifiers compare dot by dot, numerically where numeric, as Core's CompareSemVer", () => {
  assert.ok(compareSemver("1.0.0-rc.9", "1.0.0-rc.10") < 0);
  assert.ok(compareSemver("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert.ok(compareSemver("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0);
  assert.ok(compareSemver("1.0.0-alpha.beta", "1.0.0-beta") < 0);
  assert.ok(compareSemver("1.0.0-beta.11", "1.0.0-beta.2") > 0);
  assert.ok(compareSemver("1.0.0-beta.2", "1.0.0-rc.1") < 0);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0-rc.1"), 0);
  assert.equal(compareSemver("1.0.0-rc.1+a", "1.0.0-rc.1+b"), 0);
});

test("per-root minimum: a reserved root is refused whatever the manifest declares", () => {
  for (const root of NEW_ROOTS) {
    for (const declared of ["0.24.0", "0.25.0", "9.0.0", undefined]) {
      const res = checkRootMinEngine(root, declared);
      assert.equal(res.code, CODES.ROOT_RESERVED, `${root} ${declared}`);
      assert.match(res.message, new RegExp(`no SkyrimNet release reads ${root}/`));
    }
  }
});

test("per-root minimum: a versioned root needs at least its release, an ungated root needs nothing", () => {
  const table = { spells: "0.25.0", prompts: null };
  const tooLow = checkRootMinEngine("spells", "0.24.0", table);
  assert.equal(tooLow.ok, false);
  assert.equal(tooLow.code, CODES.ROOT_MIN_VERSION);
  assert.match(tooLow.message, /spells\//);
  assert.match(tooLow.message, /0\.25\.0/);
  assert.match(tooLow.message, /'0\.24\.0'/);
  assert.equal(checkRootMinEngine("spells", "0.25.0-rc.1", table).code, CODES.ROOT_MIN_VERSION);
  assert.equal(checkRootMinEngine("spells", "0.25.0", table).ok, true);
  assert.equal(checkRootMinEngine("spells", "9.0.0", table).ok, true);
  assert.equal(checkRootMinEngine("prompts", "0.1.0", table).ok, true);
  assert.equal(checkRootMinEngine("unknown", "0.1.0", table).ok, true);
  for (const root of ["prompts", "triggers", "actions", "knowledge", "entities"]) {
    assert.equal(checkRootMinEngine(root, "0.1.0").ok, true, root);
  }
  // A version the manifest rules already reject is not this rule's business.
  assert.equal(checkRootMinEngine("spells", "0-19-0-0", table).ok, true);
  assert.equal(checkRootMinEngine("spells", undefined, table).ok, true);
});

test("quoteValue quotes a short string and describes anything else by shape", () => {
  assert.equal(quoteValue("draugr"), "'draugr'");
  const long = "x".repeat(MAX_QUOTED_VALUE_LENGTH + 20);
  assert.equal(quoteValue(long), `'${"x".repeat(MAX_QUOTED_VALUE_LENGTH)}…'`);
  assert.equal(quoteValue(["a", "b"]), "a list");
  assert.equal(quoteValue({ a: 1 }), "a mapping");
  assert.equal(quoteValue(77773), "the number 77773");
  assert.equal(quoteValue(true), "the boolean true");
  assert.equal(quoteValue(null), "nothing");
  const res = checkFieldMatchesStem("id", long, "voice_effects/draugr.yaml");
  assert.equal(res.code, CODES.NAME_NOT_STEM);
  assert.ok(res.message.includes("…"));
  assert.ok(!res.message.includes(long));
});

test("field==stem generalizes name==stem: any field, case-insensitively", () => {
  assert.equal(checkFieldMatchesStem("id", "draugr", "voice_effects/draugr.yaml").ok, true);
  assert.equal(checkFieldMatchesStem("key", "TIF__000D9B53", "dialogue_actions/tif__000d9b53.yaml").ok, true);
  const missing = checkFieldMatchesStem("id", undefined, "voice_effects/draugr.yaml");
  assert.equal(missing.code, CODES.NAME_MISSING);
  assert.match(missing.message, /'id'/);
  const wrong = checkFieldMatchesStem("id", "ghost", "voice_effects/draugr.yaml");
  assert.equal(wrong.code, CODES.NAME_NOT_STEM);
  assert.match(wrong.message, /id 'ghost'/);
  assert.match(wrong.message, /'draugr'/);
  assert.deepEqual(checkNameMatchesStem("x", "triggers/x.yaml"), checkFieldMatchesStem("name", "x", "triggers/x.yaml"));
});

// ----- FormRef corpus ------------------------------------------------------

test("form-ref corpus is the engine's copy", () => {
  // The literal counts pin the copy: a fixture that gained or lost a case on
  // one side fails here until the other side is synced by hand.
  assert.equal(formRefCorpus.stemCases.length, 22);
  assert.equal(formRefCorpus.parseCases.length, 5);
  assert.equal(formRefCorpus.malformedCases.length, 15);
  assert.match(formRefCorpus.hash, /FNV-1a 32-bit/);
});

test("form-ref stem corpus", async (t) => {
  for (const c of formRefCorpus.stemCases) {
    await t.test(`${c.plugin}|${c.localId} -> ${c.expectedStem}`, () => {
      const ref = { plugin: c.plugin, localId: parseInt(c.localId, 16) };
      assert.equal(formStem(ref), c.expectedStem, c.note);
      assert.equal(formRefKey(ref), c.expectedKey, c.note);
      assert.equal(formRefToString(ref), c.expectedToString, c.note);
      // The canonical spelling round-trips through Parse.
      assert.deepEqual(parseFormRef(c.expectedToString), ref, c.note);
    });
  }
});

test("form-ref parse corpus", async (t) => {
  for (const c of formRefCorpus.parseCases) {
    await t.test(JSON.stringify(c.input), () => {
      const ref = parseFormRef(c.input);
      assert.deepEqual(ref, { plugin: c.plugin, localId: parseInt(c.localId, 16) }, c.note);
      assert.equal(formRefToString(ref), c.expectedToString, c.note);
    });
  }
});

test("form-ref malformed corpus", async (t) => {
  for (const c of formRefCorpus.malformedCases) {
    await t.test(`${JSON.stringify(c.input)} (${c.note})`, () => {
      assert.equal(parseFormRef(c.input), null);
    });
  }
  assert.equal(parseFormRef(null), null);
  assert.equal(parseFormRef(42), null);
});

test("fnv1a32 over UTF-8 bytes, 8 lowercase hex digits", () => {
  assert.equal(fnv1a32Hex(""), "811c9dc5");
  assert.equal(fnv1a32Hex("a"), "e40c292c");
  assert.equal(fnv1a32Hex("mod a.esp"), "a44f2ca6");
  // Folding is ASCII-only, so the Cyrillic capital stays and the hash is the corpus's.
  assert.equal(fnv1a32Hex("Мод.esp"), "4077c7b5");
});

test("stem prefix never splits a UTF-8 sequence at the 40-byte cut", () => {
  const stem = formStem({ plugin: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaéz.esp", localId: 0x123 });
  assert.match(stem, /^a{39}-[0-9a-f]{8}_000123$/);
  // An ESL id prints six digits like any other; the mask keeps 24 bits.
  assert.equal(formStem({ plugin: "x.esl", localId: 0xfff }), "x-esl_000FFF");
});

test("parseFormRef trims only space, tab, CR and LF, as Core's TrimWhitespace", () => {
  assert.deepEqual(parseFormRef("\t Skyrim.esm \r\n| 0x1 \n"), { plugin: "Skyrim.esm", localId: 1 });
  assert.deepEqual(parseFormRef("Skyrim.esm |0x1"), { plugin: "Skyrim.esm ", localId: 1 });
  assert.equal(parseFormRef("\u000BSkyrim.esm|0x1"), null);
  assert.equal(parseFormRef("Skyrim.esm|0x1 "), null);
});
