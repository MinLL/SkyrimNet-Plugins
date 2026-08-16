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
  checkContentPath,
  checkManifestIdentity,
  checkNameMatchesStem,
  findPathCollisions,
  foldCase,
  isReservedAuthorSegment,
  isStrictSemver,
  stemOf,
} from "../.github/scripts/lib/content-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "path-cases.json"), "utf8"),
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
    assert.equal(checkContentPath(`${root}/ok.${root === "prompts" ? "prompt" : "yaml"}`).ok, true);
    assert.equal(checkContentPath(`${root}/bad.exe`).code, CODES.BAD_EXTENSION);
  }
});
