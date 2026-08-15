// The repo's own plugins/ tree must satisfy the rules CI enforces.
//
// Every plugin currently on the branch is replayed through validate.mjs as if
// it were being submitted today (base = this checkout, PR = this checkout).
// This is the check that catches "we tightened a rule and forgot to migrate
// the entries already in the repo".

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT, errorMessages, runValidate } from "./helpers/harness.mjs";
import { checkContentPath, findPathCollisions } from "../.github/scripts/lib/content-rules.mjs";

const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");

function listPlugins() {
  const out = [];
  for (const author of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!author.isDirectory()) continue;
    for (const slug of fs.readdirSync(path.join(PLUGINS_DIR, author.name), { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      out.push(`plugins/${author.name}/${slug.name}`);
    }
  }
  return out;
}

function listFiles(pluginRoot) {
  const abs = path.join(REPO_ROOT, pluginRoot);
  const out = [];
  const stack = [abs];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
    }
  }
  return out;
}

const plugins = listPlugins();

test("the repo has at least one plugin to validate", () => {
  assert.ok(plugins.length > 0);
});

test("every plugin in the repo passes validation", async (t) => {
  for (const pluginRoot of plugins) {
    await t.test(pluginRoot, () => {
      const changed = listFiles(pluginRoot);
      const res = runValidate({ baseDir: REPO_ROOT, prDir: REPO_ROOT, changed });
      assert.equal(res.result.success, true, `${pluginRoot} failed validation:\n${errorMessages(res.result)}`);
      assert.equal(res.result.plugin_root, pluginRoot);
      assert.deepEqual(res.result.warnings, []);
    });
  }
});

test("every content path in the repo satisfies the path rules", () => {
  for (const pluginRoot of plugins) {
    const contentPaths = listFiles(pluginRoot)
      .map((f) => f.slice(pluginRoot.length + 1))
      .filter((f) => f !== "manifest.json");
    for (const rel of contentPaths) {
      const res = checkContentPath(rel);
      assert.equal(res.ok, true, `${pluginRoot}/${rel}: ${res.code} ${res.message}`);
    }
    assert.deepEqual(findPathCollisions(contentPaths), [], `${pluginRoot} has case-folded path collisions`);
  }
});
