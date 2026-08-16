// End-to-end tests for .github/scripts/build-index.mjs.
//
// The version `history` the installer resolves rollbacks from is derived from
// real git history, so these tests build throwaway git repos with real
// multi-commit plugin histories and run the real script against them. The
// emitted index is validated against schemas/index.schema.json — the same
// contract the dashboard and the C++ installer read.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { BUILD_INDEX_SCRIPT, REPO_ROOT, makeTempDir, rmDir, writeFile } from "./helpers/harness.mjs";

// ajv lives in the CI scripts' dependency tree (.github/scripts/node_modules);
// resolve it from there so the test suite needs no second install.
const scriptsRequire = createRequire(path.join(REPO_ROOT, ".github", "scripts", "package.json"));
const Ajv = scriptsRequire("ajv/dist/2020.js");
const addFormats = scriptsRequire("ajv-formats");

const ajv = new Ajv.default({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats.default(ajv);
const validateIndex = ajv.compile(
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "index.schema.json"), "utf8")),
);

function assertValidIndex(index) {
  const valid = validateIndex(index);
  assert.ok(
    valid,
    `index.json does not match index.schema.json:\n${(validateIndex.errors ?? [])
      .map((e) => `  ${e.instancePath || "/"} ${e.message}`)
      .join("\n")}`,
  );
}

function git(repo, args) {
  return execFileSync(
    "git",
    [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false",
      "-c", "core.autocrlf=false",
      ...args,
    ],
    { cwd: repo, encoding: "utf8" },
  ).trim();
}

function initRepo() {
  const repo = makeTempDir("snhub-git-");
  git(repo, ["init", "--quiet"]);
  return repo;
}

function commitAll(repo, message) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function bundleManifest(overrides = {}) {
  return {
    id: "bob.pack",
    type: "bundle",
    title: "Bob's Pack",
    tagline: "Fixture.",
    description: "Fixture plugin.",
    author: "bob",
    tags: [],
    nsfw: false,
    icon: "package",
    mods: [],
    version: "1.0.0",
    min_skyrimnet_version: "0.25.0",
    ...overrides,
  };
}

function runBuildIndex(repo) {
  const proc = spawnSync(process.execPath, [BUILD_INDEX_SCRIPT], { cwd: repo, encoding: "utf8" });
  assert.equal(proc.status, 0, `build-index failed:\n${proc.stdout}\n${proc.stderr}`);
  const index = JSON.parse(fs.readFileSync(path.join(repo, "index.json"), "utf8"));
  return { index, stdout: proc.stdout };
}

// ----- Tests ---------------------------------------------------------------

test("emits per-version history newest-first, pinned to the newest commit of each version", () => {
  const repo = initRepo();
  try {
    writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest(), null, 2));
    writeFile(repo, "plugins/bob/pack/prompts/a.prompt", "v1 content\n");
    const c1 = commitAll(repo, "add pack 1.0.0");

    // Content-only republish: same version, newer commit. Rollback to 1.0.0
    // must land on THIS commit — it is the final state of that version.
    writeFile(repo, "plugins/bob/pack/prompts/a.prompt", "v1 content, fixed typo\n");
    const c2 = commitAll(repo, "fix typo, still 1.0.0");

    writeFile(
      repo,
      "plugins/bob/pack/manifest.json",
      JSON.stringify(bundleManifest({ version: "1.1.0" }), null, 2),
    );
    const c3 = commitAll(repo, "bump to 1.1.0");

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);

    assert.equal(index.schema_version, 2);
    assert.equal(index.plugins.length, 1);
    const entry = index.plugins[0];

    assert.equal(entry.id, "plugins/bob/pack");
    assert.equal(entry.plugin_id, "bob.pack");
    assert.equal(entry.version, "1.1.0");
    assert.equal(entry.min_skyrimnet_version, "0.25.0");
    assert.deepEqual(entry.contents, { triggers: 0, actions: 0, prompts: 1 });

    assert.equal(entry.history.length, 2);
    assert.equal(entry.history[0].version, "1.1.0");
    assert.equal(entry.history[0].commit, c3);
    assert.equal(entry.history[1].version, "1.0.0");
    assert.equal(entry.history[1].commit, c2, "rollback target is the newest commit of that version");
    assert.notEqual(entry.history[1].commit, c1);

    for (const h of entry.history) {
      assert.match(h.commit, /^[0-9a-f]{40}$/);
      assert.ok(!Number.isNaN(Date.parse(h.date)), `unparseable date ${h.date}`);
    }
    // Newest first.
    assert.ok(Date.parse(entry.history[0].date) >= Date.parse(entry.history[1].date));
  } finally {
    rmDir(repo);
  }
});

test("history is capped at 20 entries", () => {
  const repo = initRepo();
  try {
    const versions = [];
    for (let i = 0; i < 25; i++) {
      const version = `1.${i}.0`;
      versions.push(version);
      writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest({ version }), null, 2));
      writeFile(repo, "plugins/bob/pack/prompts/a.prompt", `content ${i}\n`);
      commitAll(repo, `release ${version}`);
    }

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);

    const entry = index.plugins[0];
    assert.equal(entry.history.length, 20);
    assert.equal(entry.history[0].version, "1.24.0");
    assert.equal(entry.history.at(-1).version, "1.5.0");
    assert.equal(new Set(entry.history.map((h) => h.version)).size, 20, "versions are deduplicated");
  } finally {
    rmDir(repo);
  }
});

test("listings carry no history and no contents", () => {
  const repo = initRepo();
  try {
    writeFile(
      repo,
      "plugins/bob/listed/manifest.json",
      JSON.stringify(
        {
          id: "bob.listed",
          type: "listing",
          title: "Bob's Listed Mod",
          tagline: "Hosted elsewhere.",
          description: "Fixture listing.",
          author: "bob",
          tags: [],
          nsfw: false,
          icon: "package",
          mods: [],
          external_url: "https://example.com/mod",
        },
        null,
        2,
      ),
    );
    commitAll(repo, "add listing");

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);

    const entry = index.plugins[0];
    assert.equal(entry.type, "listing");
    assert.equal(entry.external_url, "https://example.com/mod");
    assert.ok(!("history" in entry));
    assert.ok(!("contents" in entry));
    assert.ok(!("min_skyrimnet_version" in entry));
  } finally {
    rmDir(repo);
  }
});

test("first_published is a single timestamp even when files arrive across commits", () => {
  const repo = initRepo();
  try {
    writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest(), null, 2));
    commitAll(repo, "add manifest");
    writeFile(repo, "plugins/bob/pack/prompts/a.prompt", "added later\n");
    commitAll(repo, "add prompt");

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);

    const entry = index.plugins[0];
    assert.ok(!entry.first_published.includes("\n"), "first_published must be one timestamp");
    assert.ok(!Number.isNaN(Date.parse(entry.first_published)));
    assert.ok(Date.parse(entry.last_updated) >= Date.parse(entry.first_published));
  } finally {
    rmDir(repo);
  }
});

test("moderation state from hidden.json / curated.json is still embedded", () => {
  const repo = initRepo();
  try {
    writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest(), null, 2));
    writeFile(repo, "plugins/bob/pack/prompts/a.prompt", "x\n");
    writeFile(
      repo,
      "hidden.json",
      JSON.stringify({ schema_version: 1, hidden: [{ id: "plugins/bob/pack", reason: "test" }] }, null, 2),
    );
    writeFile(repo, "curated.json", JSON.stringify({ schema_version: 1, curated: [] }, null, 2));
    commitAll(repo, "add pack + moderation state");

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);
    assert.equal(index.plugins[0].hidden.reason, "test");
  } finally {
    rmDir(repo);
  }
});

test("a manifest that is unparseable at an older commit does not break history", () => {
  const repo = initRepo();
  try {
    writeFile(repo, "plugins/bob/pack/manifest.json", "{ this is not json");
    writeFile(repo, "plugins/bob/pack/prompts/a.prompt", "x\n");
    commitAll(repo, "broken manifest");

    writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest({ version: "2.0.0" }), null, 2));
    const good = commitAll(repo, "fix manifest");

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);

    const entry = index.plugins[0];
    assert.equal(entry.history.length, 1);
    assert.equal(entry.history[0].version, "2.0.0");
    assert.equal(entry.history[0].commit, good);
  } finally {
    rmDir(repo);
  }
});

test("the committed index.json matches the schema and the plugins tree", () => {
  const index = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "index.json"), "utf8"));
  assertValidIndex(index);

  const pluginsDir = path.join(REPO_ROOT, "plugins");
  const onDisk = [];
  for (const author of fs.readdirSync(pluginsDir)) {
    for (const slug of fs.readdirSync(path.join(pluginsDir, author))) {
      onDisk.push(`plugins/${author}/${slug}`);
    }
  }
  assert.deepEqual(
    index.plugins.map((p) => p.id).sort(),
    onDisk.sort(),
    "index.json is stale — re-run `node .github/scripts/build-index.mjs`",
  );

  for (const entry of index.plugins) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, entry.id, "manifest.json"), "utf8"),
    );
    assert.equal(entry.plugin_id, manifest.id);
    if (entry.type === "bundle") {
      assert.ok(entry.history.length >= 1, `${entry.id} has no history`);
      assert.equal(entry.history[0].version, manifest.version);
    }
  }
});
