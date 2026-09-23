// The shared record corpus: tests/fixtures/records/<root>/{valid,base,invalid}/*.yaml, a byte-for-byte mirror of
// SkyrimNet-Core's tests/test_data/records/. Valid and base files (the shipped base content, verbatim) must pass
// checkRecord; each invalid file must report exactly the code its `# refuse:` header names. A case that looks
// wrong is a cross-repo change landing in both copies, never a local edit.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "../.github/scripts/node_modules/js-yaml/dist/js-yaml.mjs";
import { CODES } from "../.github/scripts/lib/content-rules.mjs";
import { RECORD_CODES, checkRecord } from "../.github/scripts/lib/record-rules.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "records");
const ROOTS = ["voice_effects", "items", "spells", "furniture", "identity", "filters", "dialogue_actions"];
// The roots the base package ships records under.
const BASE_ROOTS = ["voice_effects", "furniture", "filters", "dialogue_actions"];
const KNOWN_CODES = new Set([...Object.values(RECORD_CODES), CODES.NAME_MISSING, CODES.NAME_NOT_STEM]);
const HEADER_RE = /^#\s*([a-z]+):\s*(.*)$/;

/** The value of a leading `# key: value` comment line, or null. */
function headerValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("#")) break;
    const match = HEADER_RE.exec(line);
    if (match && match[1] === key) return match[2].trim();
  }
  return null;
}

function fixtures(root, group) {
  const dir = path.join(FIXTURES, root, group);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, subPath: `${root}/${name}`, text: fs.readFileSync(path.join(dir, name), "utf8") }));
}

test("the corpus covers the seven config-system roots, each with valid and invalid fixtures", () => {
  assert.deepEqual(fs.readdirSync(FIXTURES).sort(), [...ROOTS].sort());
  for (const root of ROOTS) {
    assert.ok(fixtures(root, "valid").length > 0, `${root}/valid is empty`);
    assert.ok(fixtures(root, "invalid").length > 0, `${root}/invalid is empty`);
    assert.equal(fixtures(root, "base").length > 0, BASE_ROOTS.includes(root), `${root}/base`);
  }
});

for (const root of ROOTS) {
  test(`${root}: every valid and base fixture is accepted; a valid one says what it pins`, () => {
    for (const group of ["valid", "base"]) {
      for (const fixture of fixtures(root, group)) {
        const res = checkRecord(root, yaml.load(fixture.text), fixture.subPath);
        assert.equal(res.ok, true, `${group}/${fixture.name}: ${JSON.stringify(res.issues)}`);
        if (group === "valid") assert.ok(headerValue(fixture.text, "why"), `${group}/${fixture.name} has no '# why:' header`);
      }
    }
  });

  test(`${root}: every invalid fixture is refused with exactly the code its header names`, () => {
    for (const fixture of fixtures(root, "invalid")) {
      const code = headerValue(fixture.text, "refuse");
      assert.ok(code !== null && KNOWN_CODES.has(code), `invalid/${fixture.name}: '# refuse:' names no hub code (${code})`);
      const res = checkRecord(root, yaml.load(fixture.text), fixture.subPath);
      assert.deepEqual(res.issues.map((issue) => issue.code), [code], `invalid/${fixture.name}: ${JSON.stringify(res.issues)}`);
    }
  });
}
