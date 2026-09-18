// End-to-end tests for .github/scripts/build-index.mjs.
//
// The version `history` the installer resolves rollbacks from is derived from
// real git history, so these tests build throwaway git repos with real
// multi-commit plugin histories and run the real script against them. The
// emitted index is validated against schemas/index.schema.json — the same
// contract the dashboard and the C++ installer read.
//
// The popularity `stats` bake is exercised against a throwaway local HTTP
// server standing in for fateless.ai's stats document. Every run here pins
// SKYRIMNET_HUB_STATS_URL (default `none`): the script must never reach the
// real fateless.ai from a test.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

function buildIndexSpawnOptions(repo, statsUrl) {
  return { cwd: repo, encoding: "utf8", env: { ...process.env, SKYRIMNET_HUB_STATS_URL: statsUrl } };
}

function collectBuildIndex(repo, { status, stdout, stderr }) {
  assert.equal(status, 0, `build-index failed:\n${stdout}\n${stderr}`);
  const raw = fs.readFileSync(path.join(repo, "index.json"), "utf8");
  return { index: JSON.parse(raw), raw, stdout, stderr };
}

function runBuildIndex(repo, { statsUrl = "none" } = {}) {
  const proc = spawnSync(process.execPath, [BUILD_INDEX_SCRIPT], buildIndexSpawnOptions(repo, statsUrl));
  return collectBuildIndex(repo, proc);
}

/**
 * The stats tests need this one: the stand-in stats server runs on THIS
 * process's event loop, and spawnSync would block that loop for the whole
 * run — the child's fetch would sit unanswered until its timeout fired.
 */
function runBuildIndexAsync(repo, { statsUrl = "none" } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BUILD_INDEX_SCRIPT], buildIndexSpawnOptions(repo, statsUrl));
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (status) => {
      try {
        resolve(collectBuildIndex(repo, { status, stdout, stderr }));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * A local stand-in for GET https://fateless.ai/v1/hub/stats. `respond` is
 * called per request and returns { status, body } (body is JSON-encoded
 * unless it is already a string). Resolves to the URL to hand the script.
 */
async function withStatsServer(respond, fn) {
  const server = http.createServer((req, res) => {
    const { status = 200, body = {} } = respond(req);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1/hub/stats`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function statsDoc(plugins, generatedAt = "2026-09-07T10:00:00.000Z") {
  return { v: 1, generated_at: generatedAt, plugins };
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
    assert.deepEqual(entry.contents, { triggers: 0, actions: 0, prompts: 1, bios: 0, knowledge: 0, entities: 0 });

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

test("knowledge packs are counted in contents without bumping the schema version", () => {
  const repo = initRepo();
  try {
    writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest(), null, 2));
    writeFile(repo, "plugins/bob/pack/prompts/a.prompt", "x\n");
    writeFile(repo, "plugins/bob/pack/knowledge/lore.sknpack", "{}\n");
    writeFile(repo, "plugins/bob/pack/knowledge/nested/more.sknpack", "{}\n");
    commitAll(repo, "add pack with knowledge");

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);

    // Additive: the engine hard-rejects any schema_version but 2.
    assert.equal(index.schema_version, 2);
    assert.deepEqual(index.plugins[0].contents, {
      triggers: 0,
      actions: 0,
      prompts: 1,
      bios: 0,
      knowledge: 2,
      entities: 0,
    });
  } finally {
    rmDir(repo);
  }
});

test("virtual entities are counted in contents without bumping the schema version", () => {
  const repo = initRepo();
  try {
    writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest(), null, 2));
    writeFile(repo, "plugins/bob/pack/prompts/characters/voice_virtual.prompt", "bio\n");
    writeFile(repo, "plugins/bob/pack/entities/voice_virtual.entity.yaml", "entityName: Voice\n");
    writeFile(repo, "plugins/bob/pack/entities/pact/spirit.entity.yaml", "entityName: Spirit\n");
    commitAll(repo, "add pack with entities");

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);

    assert.equal(index.schema_version, 2);
    assert.deepEqual(index.plugins[0].contents, {
      triggers: 0,
      actions: 0,
      prompts: 0,
      bios: 1,
      knowledge: 0,
      entities: 2,
    });
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

test("character bios count as `bios`, not `prompts`", () => {
  const repo = initRepo();
  try {
    writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest(), null, 2));
    // One ordinary prompt, two character bios under prompts/characters/.
    writeFile(repo, "plugins/bob/pack/prompts/system.prompt", "a prompt\n");
    writeFile(repo, "plugins/bob/pack/prompts/characters/alice.prompt", "bio\n");
    writeFile(repo, "plugins/bob/pack/prompts/characters/bob.prompt", "bio\n");
    commitAll(repo, "add pack with bios");

    const { index } = runBuildIndex(repo);
    assertValidIndex(index);

    const entry = index.plugins[0];
    // prompts excludes the two under prompts/characters/; bios counts them.
    assert.deepEqual(entry.contents, { triggers: 0, actions: 0, prompts: 1, bios: 2, knowledge: 0, entities: 0 });
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

// ----- Popularity stats ----------------------------------------------------

function twoPluginRepo() {
  const repo = initRepo();
  writeFile(repo, "plugins/bob/pack/manifest.json", JSON.stringify(bundleManifest(), null, 2));
  writeFile(repo, "plugins/bob/pack/prompts/a.prompt", "x\n");
  writeFile(
    repo,
    "plugins/bob/other/manifest.json",
    JSON.stringify(bundleManifest({ id: "bob.other", title: "Bob's Other Pack" }), null, 2),
  );
  writeFile(repo, "plugins/bob/other/prompts/b.prompt", "y\n");
  commitAll(repo, "add two packs");
  return repo;
}

function entryById(index, pluginId) {
  const entry = index.plugins.find((p) => p.plugin_id === pluginId);
  assert.ok(entry, `no entry for ${pluginId}`);
  return entry;
}

test("stats from the live document are attached to every entry; unknown ids get zeros; bad values clamp", async () => {
  const repo = twoPluginRepo();
  try {
    const { index } = await withStatsServer(
      () => ({
        body: statsDoc({
          // Uppercase key on purpose: plugin_id is lowercase by contract, and
          // a stray uppercase key must still land on its plugin.
          "BOB.PACK": { downloads: 12, endorsements: 3 },
          // bob.other is deliberately absent from the document.
          "someone.else": { downloads: 99, endorsements: 99 },
        }),
      }),
      (url) => runBuildIndexAsync(repo, { statsUrl: url }),
    );
    assertValidIndex(index);

    assert.equal(index.schema_version, 2, "stats are additive within v2");
    assert.equal(index.stats_as_of, "2026-09-07T10:00:00.000Z");
    assert.deepEqual(entryById(index, "bob.pack").stats, { downloads: 12, endorsements: 3 });
    assert.deepEqual(entryById(index, "bob.other").stats, { downloads: 0, endorsements: 0 });

    // Values the document has no business sending are clamped, never trusted.
    const { index: clamped } = await withStatsServer(
      () => ({
        body: statsDoc({
          "bob.pack": { downloads: -4, endorsements: "7" },
          "bob.other": { downloads: 2.5, endorsements: 1 },
        }),
      }),
      (url) => runBuildIndexAsync(repo, { statsUrl: url }),
    );
    assertValidIndex(clamped);
    assert.deepEqual(entryById(clamped, "bob.pack").stats, { downloads: 0, endorsements: 0 });
    assert.deepEqual(entryById(clamped, "bob.other").stats, { downloads: 0, endorsements: 1 });
  } finally {
    rmDir(repo);
  }
});

test("a failed stats fetch carries the previous index's stats forward and keeps stats_as_of", async () => {
  const repo = twoPluginRepo();
  try {
    const { index: first } = await withStatsServer(
      () => ({ body: statsDoc({ "bob.pack": { downloads: 5, endorsements: 2 } }) }),
      (url) => runBuildIndexAsync(repo, { statsUrl: url }),
    );
    assertValidIndex(first);
    assert.equal(first.stats_as_of, "2026-09-07T10:00:00.000Z");

    // A plugin published since the last successful bake: the previous index
    // knows nothing about it, so it must come out with no stats at all.
    writeFile(
      repo,
      "plugins/bob/newer/manifest.json",
      JSON.stringify(bundleManifest({ id: "bob.newer", title: "Bob's Newer Pack" }), null, 2),
    );
    writeFile(repo, "plugins/bob/newer/prompts/c.prompt", "z\n");
    commitAll(repo, "add a third pack");

    // Each case pins the reason the script logged, so a fetch that silently
    // timed out (which also carries forward) cannot pass for the intended one.
    for (const failure of [
      { name: "HTTP 503", respond: () => ({ status: 503, body: { error: "down" } }), logged: /answered HTTP 503/ },
      { name: "not JSON", respond: () => ({ body: "<html>maintenance</html>" }), logged: /not JSON/ },
      { name: "no plugins map", respond: () => ({ body: { v: 1 } }), logged: /no plugins map/ },
    ]) {
      const { index, stderr } = await withStatsServer(failure.respond, (url) =>
        runBuildIndexAsync(repo, { statsUrl: url }),
      );
      assertValidIndex(index);
      assert.equal(index.plugins.length, 3, failure.name);
      assert.deepEqual(entryById(index, "bob.pack").stats, { downloads: 5, endorsements: 2 }, failure.name);
      assert.deepEqual(entryById(index, "bob.other").stats, { downloads: 0, endorsements: 0 }, failure.name);
      assert.ok(!("stats" in entryById(index, "bob.newer")), `${failure.name}: unknown plugin must not get stats`);
      assert.equal(index.stats_as_of, "2026-09-07T10:00:00.000Z", `${failure.name}: stats_as_of is kept`);
      assert.match(stderr, failure.logged, failure.name);
      assert.match(stderr, /carrying previous stats forward/, failure.name);
    }

    // The script never reaches out when told not to, and still carries forward.
    const { index: offline, stderr } = runBuildIndex(repo, { statsUrl: "none" });
    assertValidIndex(offline);
    assert.deepEqual(entryById(offline, "bob.pack").stats, { downloads: 5, endorsements: 2 });
    assert.match(stderr, /skipping the fetch/);
  } finally {
    rmDir(repo);
  }
});

test("with no live document and nothing to carry forward, stats are omitted and stats_as_of is null", () => {
  const repo = twoPluginRepo();
  try {
    const { index } = runBuildIndex(repo, { statsUrl: "none" });
    assertValidIndex(index);
    assert.equal(index.stats_as_of, null);
    for (const entry of index.plugins) {
      assert.ok(!("stats" in entry), `${entry.plugin_id} must not carry stats`);
    }
  } finally {
    rmDir(repo);
  }
});

test("a rebuild that would only move the timestamps leaves index.json untouched", async () => {
  const repo = twoPluginRepo();
  try {
    const doc = statsDoc({ "bob.pack": { downloads: 5, endorsements: 2 } });
    const first = await withStatsServer(() => ({ body: doc }), (url) => runBuildIndexAsync(repo, { statsUrl: url }));
    assertValidIndex(first.index);

    // Same figures, later document, later wall clock: byte-identical output
    // — this is what keeps the hourly cron from committing every hour.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const same = await withStatsServer(
      () => ({ body: statsDoc(doc.plugins, "2026-09-07T11:00:00.000Z") }),
      (url) => runBuildIndexAsync(repo, { statsUrl: url }),
    );
    assert.equal(same.raw, first.raw);
    assert.match(same.stdout, /left as is/);

    // One figure moves: the file is rewritten and both timestamps advance.
    const changed = await withStatsServer(
      () => ({ body: statsDoc({ "bob.pack": { downloads: 6, endorsements: 2 } }, "2026-09-07T12:00:00.000Z") }),
      (url) => runBuildIndexAsync(repo, { statsUrl: url }),
    );
    assertValidIndex(changed.index);
    assert.notEqual(changed.raw, first.raw);
    assert.equal(changed.index.stats_as_of, "2026-09-07T12:00:00.000Z");
    assert.ok(Date.parse(changed.index.generated_at) > Date.parse(first.index.generated_at));
    assert.deepEqual(entryById(changed.index, "bob.pack").stats, { downloads: 6, endorsements: 2 });
  } finally {
    rmDir(repo);
  }
});

test("the committed index.json matches the schema and the plugins tree", (t) => {
  // A push that changes plugins/ triggers build-index.yml, which rebuilds and
  // commits index.json seconds later — so at the exact commit that changed
  // plugins/, the tree being ahead of the index is by design, not drift. This
  // suite only runs on such a commit when the push ALSO touched scripts/tests
  // (a maintainer landing official packs plus CI changes), and a rerun checks
  // out the same SHA, so asserting staleness there fails permanently. The
  // guard exists for drift with no rebuild coming — a hand-edited index.json,
  // or a rebuild that silently failed — and in both of those HEAD did not
  // touch plugins/, so the assertion still bites.
  const headTouchedPlugins = execFileSync(
    "git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).split("\n").some((f) => f.startsWith("plugins/"));
  if (headTouchedPlugins) {
    t.skip("HEAD itself changed plugins/ — the index rebuild for this commit is pending by design");
    return;
  }

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
