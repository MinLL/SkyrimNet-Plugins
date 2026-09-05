// End-to-end tests for .github/scripts/validate.mjs.
//
// Each test builds a synthetic PR checkout and runs the real script the way
// skyrimnet-ops' hub-review.yml does. BASE_DIR is this repo (the trusted side: schemas,
// bans.json, index.json), PR_DIR is a throwaway tree.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  BOT_AUTHOR,
  GOOD_FILES,
  POSIX_ONLY,
  errorMessages,
  goodKnowledgePack,
  goodManifest,
  knowledgeEntry,
  makeBaseDir,
  makeTempDir,
  rmDir,
  runValidate,
  writeFile,
  writePlugin,
} from "./helpers/harness.mjs";

/** Build a PR checkout containing exactly one plugin and validate it. */
function validatePlugin({ pluginDir = "plugins/bob/test-pack", manifest, files = GOOD_FILES, ...rest }) {
  const prDir = makeTempDir();
  try {
    const changed = writePlugin(prDir, pluginDir, { manifest, files });
    return runValidate({ prDir, changed, ...rest });
  } finally {
    rmDir(prDir);
  }
}

function assertRejected(res, needle) {
  assert.equal(res.result.success, false, `expected rejection, got success. errors: ${errorMessages(res.result)}`);
  assert.equal(res.status, 1);
  assert.deepEqual(res.result.labels, ["validation-failed"]);
  if (needle) {
    assert.match(errorMessages(res.result), needle);
  }
}

// ----- Happy paths ---------------------------------------------------------

test("happy path: dashboard-submitted prompt+trigger bundle passes", () => {
  const res = validatePlugin({ manifest: goodManifest() });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
  assert.equal(res.result.plugin_root, "plugins/bob/test-pack");
  assert.deepEqual(res.result.errors, []);
});

test("another installed [bot] with the marker is NOT dashboard-submitted", () => {
  // The gate is the hub App's exact login. A different App (Dependabot, the
  // reviewer App) plus a copy-pasted marker must route to a human.
  const res = validatePlugin({ manifest: goodManifest(), prAuthor: "some-other-app[bot]" });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["manual-review"]);
});

test("happy path: 'SkyrimNet FooBar Integration' by bob is accepted end to end", () => {
  // The reserved namespace covers the AUTHOR segment only (§2, decision 12).
  // A community plugin whose slug and title advertise SkyrimNet integration is
  // expected and welcome.
  const res = validatePlugin({
    pluginDir: "plugins/bob/skyrimnet-foobar-integration",
    manifest: goodManifest({
      id: "bob.skyrimnet-foobar-integration",
      title: "SkyrimNet FooBar Integration",
      tagline: "Makes FooBar talk to SkyrimNet.",
    }),
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
});

test("happy path: mixed-case author directory case-folds onto a lowercase id", () => {
  const res = validatePlugin({
    pluginDir: "plugins/BobTheAuthor/test-pack",
    manifest: goodManifest({ id: "bobtheauthor.test-pack", author: "BobTheAuthor" }),
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("happy path: listing with no content files passes and routes to manual review", () => {
  const res = validatePlugin({
    pluginDir: "plugins/bob/some-external-mod",
    manifest: {
      id: "bob.some-external-mod",
      type: "listing",
      title: "Bob's External Mod Listing",
      tagline: "Hosted elsewhere.",
      description: "A listing entry.",
      author: "bob",
      tags: [],
      nsfw: false,
      icon: "package",
      mods: [],
      external_url: "https://example.com/mod",
    },
    files: {},
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["manual-review"]);
});

test("non-dashboard submissions still validate but route to manual review", () => {
  const res = validatePlugin({ manifest: goodManifest(), prAuthor: "somebody", prBody: "" });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["manual-review"]);
});

// ----- Manifest identity rejections ---------------------------------------

test("rejects a manifest with no id", () => {
  const m = goodManifest();
  delete m.id;
  assertRejected(validatePlugin({ manifest: m }), /manifest\.id is required/);
});

test("rejects an id that does not match the directory", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest({ id: "bob.other-pack" }) }),
    /does not match its directory/,
  );
});

test("rejects an id whose author segment disagrees with manifest.author", () => {
  assertRejected(
    validatePlugin({
      pluginDir: "plugins/bob/test-pack",
      manifest: goodManifest({ author: "alice" }),
    }),
    /author segment|manifest\.author is 'alice'/,
  );
});

test("rejects a malformed id (uppercase / extra dots)", () => {
  assertRejected(validatePlugin({ manifest: goodManifest({ id: "Bob.Test-Pack" }) }), /malformed|Schema/);
  assertRejected(validatePlugin({ manifest: goodManifest({ id: "bob.test.pack" }) }), /malformed|Schema/);
});

test("rejects the reserved skyrimnet author namespace", () => {
  const res = validatePlugin({
    pluginDir: "plugins/skyrimnet/base",
    manifest: goodManifest({ id: "skyrimnet.base", author: "skyrimnet", title: "Fake Base", version: "99.0.0" }),
  });
  assertRejected(res, /reserved/i);
});

test("rejects the reserved skyrimnet- author prefix", () => {
  const res = validatePlugin({
    pluginDir: "plugins/skyrimnet-official/bios-3dnpc",
    manifest: goodManifest({
      id: "skyrimnet-official.bios-3dnpc",
      author: "skyrimnet-official",
      title: "Fake Official Bios",
    }),
  });
  assertRejected(res, /reserved/i);
});

// ----- Official content (reserved author, ruling 26) -----------------------
//
// Official packs (`plugins/skyrimnet/bios-{mod}`) land on main by maintainer
// push, never through a PR. Once one exists there, a PR may update it — every
// other identity rule still applies and the PR is always human-reviewed.

const OFFICIAL_PACK_FILES = {
  "prompts/characters/hagravi_gray-wave_8C4.prompt": "{% block summary %}Hagravi.{% endblock %}\n",
};
const OFFICIAL_PACK_MANIFEST = goodManifest({
  id: "skyrimnet.bios-3dnpc",
  author: "skyrimnet",
  title: "3DNPC - Character Bios",
  tagline: "Bios for Interesting NPCs.",
  mods: [{ name: "3DNPC", file: "3DNPC.esp", required: true }],
});
const OFFICIAL_PACK_ON_MAIN = {
  plugins: {
    "plugins/skyrimnet/bios-3dnpc": { manifest: OFFICIAL_PACK_MANIFEST, files: OFFICIAL_PACK_FILES },
  },
};

test("official pack update: a reserved-author plugin already on main accepts a PR and routes to manual review", () => {
  const baseDir = makeBaseDir(OFFICIAL_PACK_ON_MAIN);
  const prDir = makeTempDir();
  try {
    const changed = writePlugin(prDir, "plugins/skyrimnet/bios-3dnpc", {
      manifest: { ...OFFICIAL_PACK_MANIFEST, version: "1.0.1" },
      files: { ...OFFICIAL_PACK_FILES, "prompts/characters/dar_rakki_911.prompt": "{% block summary %}Dar.{% endblock %}\n" },
    });
    // Even a dashboard-shaped submission is never auto-merged into official content.
    const res = runValidate({ baseDir, prDir, changed });
    assert.equal(res.result.success, true, errorMessages(res.result));
    assert.deepEqual(res.result.labels, ["manual-review"]);
    assert.match(res.result.manualReason, /official SkyrimNet content/i);
    assert.equal(res.result.plugin_root, "plugins/skyrimnet/bios-3dnpc");
  } finally {
    rmDir(prDir);
    rmDir(baseDir);
  }
});

test("official pack update: every other identity rule still applies", () => {
  const baseDir = makeBaseDir(OFFICIAL_PACK_ON_MAIN);
  const prDir = makeTempDir();
  try {
    // The manifest's id no longer matches the directory it lives at.
    const changed = writePlugin(prDir, "plugins/skyrimnet/bios-3dnpc", {
      manifest: { ...OFFICIAL_PACK_MANIFEST, id: "skyrimnet.bios-other" },
      files: OFFICIAL_PACK_FILES,
    });
    const res = runValidate({ baseDir, prDir, changed });
    assertRejected(res, /ID_PATH_MISMATCH|does not match|directory/i);
  } finally {
    rmDir(prDir);
    rmDir(baseDir);
  }
});

test("official pack: a NEW reserved-author plugin is still refused even when a sibling exists on main", () => {
  const baseDir = makeBaseDir(OFFICIAL_PACK_ON_MAIN);
  const prDir = makeTempDir();
  try {
    const changed = writePlugin(prDir, "plugins/skyrimnet/bios-inigo", {
      manifest: goodManifest({ id: "skyrimnet.bios-inigo", author: "skyrimnet", title: "Inigo - Character Bios" }),
      files: OFFICIAL_PACK_FILES,
    });
    const res = runValidate({ baseDir, prDir, changed });
    assertRejected(res, /reserved/i);
  } finally {
    rmDir(prDir);
    rmDir(baseDir);
  }
});

test("rejects a non-semver version", () => {
  assertRejected(validatePlugin({ manifest: goodManifest({ version: "1.0" }) }), /strict semver/);
  assertRejected(validatePlugin({ manifest: goodManifest({ version: "v1.0.0" }) }), /strict semver/);
});

test("rejects a bundle with no min_skyrimnet_version", () => {
  const m = goodManifest();
  delete m.min_skyrimnet_version;
  assertRejected(validatePlugin({ manifest: m }), /min_skyrimnet_version is required/);
});

test("rejects a non-semver min_skyrimnet_version (the legacy dashed format)", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest({ min_skyrimnet_version: "0-19-0-0" }) }),
    /min_skyrimnet_version '0-19-0-0' is not strict semver/,
  );
});

test("rejects the dropped files[] field", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest({ files: ["prompts/characters/test_npc.prompt"] }) }),
    /Schema/,
  );
});

test("rejects an action-bearing plugin with no invocation block", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: { "actions/do_thing.yaml": "name: do_thing\ndescription: fixture\n" },
    }),
    /invocation is missing/,
  );
});

test("rejects a listing that ships content files", () => {
  assertRejected(
    validatePlugin({
      pluginDir: "plugins/bob/listing-with-content",
      manifest: {
        id: "bob.listing-with-content",
        type: "listing",
        title: "Bob's Sneaky Listing",
        tagline: "Hosted elsewhere.",
        description: "A listing entry.",
        author: "bob",
        tags: [],
        nsfw: false,
        icon: "package",
        mods: [],
        external_url: "https://example.com/mod",
      },
    }),
    /Listing plugins must not contain any content files/,
  );
});

// ----- Cross-plugin id uniqueness -----------------------------------------
//
// git is case-sensitive, the install directory is not: two plugin directories
// differing only in case both fold to one id and would overwrite each other on
// the user's disk. Staged with a custom BASE_DIR so the two directories live
// in different checkouts — a single checkout could not hold both on Windows,
// which is the whole reason only the hub can catch this.

const COOL_PACK_ON_MAIN = {
  plugins: {
    "plugins/bob/cool-pack": {
      manifest: goodManifest({ id: "bob.cool-pack", title: "Bob's Cool Pack" }),
      files: GOOD_FILES,
    },
  },
};

const COOL_PACK_INDEX = {
  schema_version: 2,
  generated_at: "2026-08-14T00:00:00Z",
  plugins: [
    {
      id: "plugins/bob/cool-pack",
      plugin_id: "bob.cool-pack",
      type: "bundle",
      title: "Bob's Cool Pack",
    },
  ],
};

test("rejects a plugin whose id case-folds onto an existing plugin's id", () => {
  const baseDir = makeBaseDir({ ...COOL_PACK_ON_MAIN, index: COOL_PACK_INDEX });
  const prDir = makeTempDir();
  try {
    // Self-consistent on its own terms: 'Cool-Pack' case-folds onto the id,
    // so every per-plugin identity rule passes. Only a cross-plugin check
    // catches it.
    const changed = writePlugin(prDir, "plugins/bob/Cool-Pack", {
      manifest: goodManifest({ id: "bob.cool-pack", title: "Bob's Sneaky Homoglyph Pack" }),
      files: GOOD_FILES,
    });
    const res = runValidate({ baseDir, prDir, changed });
    assertRejected(res, /Plugin id 'bob\.cool-pack' collides with existing plugin 'plugins\/bob\/cool-pack'/);
  } finally {
    rmDir(prDir);
    rmDir(baseDir);
  }
});

test("catches an id collision even when index.json has not been rebuilt yet", () => {
  // index.json is regenerated only after a plugin merges, so the base
  // directory tree is the fresher source and must be the primary one.
  const baseDir = makeBaseDir(COOL_PACK_ON_MAIN);
  const prDir = makeTempDir();
  try {
    const changed = writePlugin(prDir, "plugins/bob/COOL-PACK", {
      manifest: goodManifest({ id: "bob.cool-pack", title: "Bob's Shouty Pack" }),
      files: GOOD_FILES,
    });
    const res = runValidate({ baseDir, prDir, changed });
    assertRejected(res, /collides with existing plugin/);
  } finally {
    rmDir(prDir);
    rmDir(baseDir);
  }
});

test("a plugin updating itself is not an id collision", () => {
  const baseDir = makeBaseDir({ ...COOL_PACK_ON_MAIN, index: COOL_PACK_INDEX });
  const prDir = makeTempDir();
  try {
    const changed = writePlugin(prDir, "plugins/bob/cool-pack", {
      manifest: goodManifest({ id: "bob.cool-pack", title: "Bob's Cool Pack", version: "1.1.0" }),
      files: GOOD_FILES,
    });
    const res = runValidate({ baseDir, prDir, changed });
    assert.equal(res.result.success, true, errorMessages(res.result));
  } finally {
    rmDir(prDir);
    rmDir(baseDir);
  }
});

// ----- Path rejections -----------------------------------------------------

test("rejects a file outside the content roots", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "lore/pack.txt": "{}" } }),
    /\[UNKNOWN_ROOT\]/,
  );
});

test("rejects a wrong extension for the root", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "prompts/readme.txt": "hi" } }),
    /\[BAD_EXTENSION\]/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "triggers/thing.yml": "name: thing\n" } }),
    /\[BAD_EXTENSION\]/,
  );
});

test("rejects reserved dynamic-bio paths and the .dynamic.prompt extension", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: { "prompts/characters/dynamic/lydia_a2c94.prompt": "bio" },
    }),
    /\[RESERVED_DYNAMIC\]/,
  );
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: { "prompts/characters/lydia_a2c94.dynamic.prompt": "bio" },
    }),
    /\[RESERVED_DYNAMIC\]/,
  );
});

test("rejects a Windows reserved device name", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "prompts/nul.prompt": "x" } }),
    /\[RESERVED_DEVICE_NAME\]/,
  );
});

test("rejects a non-ASCII filename", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "prompts/café.prompt": "x" } }),
    /\[CHARSET\]/,
  );
});

test("rejects a backslash in a git path", POSIX_ONLY, () => {
  // On POSIX a git path containing a literal backslash checks out as a
  // filename containing that backslash. On Windows it would act as a
  // separator and escape the plugin sandbox — so it is refused outright.
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "prompts\\evil.prompt": "x" } }),
    /\[BACKSLASH\]/,
  );
});

test("rejects an alternate-data-stream suffix", POSIX_ONLY, () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "prompts/ok.prompt:Zone.Identifier": "x" } }),
    /\[ADS_COLON\]/,
  );
});

test("rejects a trailing space in a segment", POSIX_ONLY, () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "prompts/sneaky.prompt ": "x" } }),
    /\[TRAILING_DOT_OR_SPACE\]/,
  );
});

test("rejects case-folded path collisions inside one plugin", POSIX_ONLY, () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: {
        "prompts/characters/Lydia.prompt": "a",
        "prompts/characters/lydia.prompt": "b",
      },
    }),
    /collide when compared case-insensitively/,
  );
});

// ----- Trigger / action name == stem --------------------------------------

test("rejects a trigger whose in-file name is not the filename stem", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: { "triggers/combat_banter.yaml": "name: Combat Banter\nenabled: true\n" },
    }),
    /does not match the filename stem/,
  );
});

test("rejects an action with no name field", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest({
        invocation: {
          purpose: "fixture",
          actions: [{ file: "actions/do_thing.yaml", vanilla: true }],
          attestation: "tested",
        },
      }),
      files: { "actions/do_thing.yaml": "description: fixture\n" },
    }),
    /has no 'name' field/,
  );
});

test("accepts an action whose name equals its stem", () => {
  const res = validatePlugin({
    manifest: goodManifest({
      invocation: {
        purpose: "fixture",
        actions: [{ file: "actions/do_thing.yaml", vanilla: true }],
        attestation: "tested",
      },
    }),
    files: { "actions/do_thing.yaml": "name: do_thing\ndescription: fixture\n" },
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
  // Action-bearing plugins always go to a human.
  assert.deepEqual(res.result.labels, ["manual-review"]);
});

// ----- Knowledge packs (knowledge/*.sknpack) -------------------------------
//
// The fourth content root. Packs are schema-checked (unlike trigger/action
// YAML) because the engine's store sync parses them on every save load and an
// entry with no `key` can never be updated in place.

const KNOWLEDGE_PATH = "knowledge/lore.sknpack";

function knowledgeFiles(pack) {
  return { [KNOWLEDGE_PATH]: JSON.stringify(pack, null, 2) };
}

test("accepts a knowledge-only bundle and routes it to agent review", () => {
  const res = validatePlugin({
    manifest: goodManifest(),
    files: knowledgeFiles(goodKnowledgePack()),
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
});

test("accepts knowledge alongside prompts and triggers, still agent-reviewed", () => {
  const res = validatePlugin({
    manifest: goodManifest(),
    files: { ...GOOD_FILES, ...knowledgeFiles(goodKnowledgePack()) },
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
});

test("accepts a nested knowledge pack path", () => {
  const res = validatePlugin({
    manifest: goodManifest(),
    files: { "knowledge/lore/deep_pack.sknpack": JSON.stringify(goodKnowledgePack()) },
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("a pack that still carries an in-file author (pre-0.25 export) is accepted, even empty", () => {
  // SkyrimNet dropped the field; the schema keeps it optional and unconstrained so older
  // clients, which wrote whatever the UI held (often ""), are not turned away on it.
  for (const author of ["bob", ""]) {
    const res = validatePlugin({
      manifest: goodManifest(),
      files: knowledgeFiles(goodKnowledgePack({ author })),
    });
    assert.equal(res.result.success, true, errorMessages(res.result));
  }
});

test("a knowledge pack's in-file name need not match the filename stem", () => {
  // Packs have no name==stem contract — the trigger/action rule must not leak.
  const res = validatePlugin({
    manifest: goodManifest(),
    files: knowledgeFiles(goodKnowledgePack({ name: "Something Else Entirely" })),
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("rejects a knowledge file with the wrong extension", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: { "knowledge/pack.yaml": "name: pack\n" },
    }),
    /\[BAD_EXTENSION\]/,
  );
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: { "knowledge/pack.SKNPACK": "{}" },
    }),
    /\[BAD_EXTENSION\]/,
  );
});

test("rejects a knowledge pack that is not valid JSON", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { [KNOWLEDGE_PATH]: "{ nope" } }),
    /not valid JSON/,
  );
});

test("rejects a knowledge pack at an older format_version", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: knowledgeFiles(goodKnowledgePack({ format_version: 1 })),
    }),
    /Knowledge pack schema/,
  );
});

test("rejects a knowledge entry with no key", () => {
  const entry = knowledgeEntry();
  delete entry.key;
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: knowledgeFiles(goodKnowledgePack({ entries: [entry] })),
    }),
    /Knowledge pack schema.*key/s,
  );
});

test("rejects a knowledge entry whose key is malformed", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: knowledgeFiles(goodKnowledgePack({ entries: [knowledgeEntry({ key: "Not A Key" })] })),
    }),
    /Knowledge pack schema/,
  );
});

test("rejects duplicate entry keys within one knowledge pack", () => {
  // Schema-legal but identity-broken: JSON Schema cannot express uniqueness
  // across a field, so the validator checks it by hand.
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: knowledgeFiles(
        goodKnowledgePack({
          entries: [
            knowledgeEntry({ key: "same_key" }),
            knowledgeEntry({ key: "same_key", display_name: "Another entry" }),
          ],
        }),
      ),
    }),
    /duplicate entry key 'same_key'/,
  );
});

test("the same key in two different packs is fine — uniqueness is per file", () => {
  const res = validatePlugin({
    manifest: goodManifest(),
    files: {
      "knowledge/a.sknpack": JSON.stringify(goodKnowledgePack()),
      "knowledge/b.sknpack": JSON.stringify(goodKnowledgePack()),
    },
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("rejects a knowledge pack over the 1 MB per-file limit", () => {
  const huge = goodKnowledgePack({
    entries: Array.from({ length: 400 }, (_, i) =>
      knowledgeEntry({ key: `entry_${i}`, content: "x".repeat(3900) }),
    ),
  });
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: knowledgeFiles(huge) }),
    /exceeds the 1\.00 MB per-file limit for knowledge packs/,
  );
});

test("rejects a listing that ships a knowledge pack", () => {
  assertRejected(
    validatePlugin({
      pluginDir: "plugins/bob/listing-with-knowledge",
      manifest: {
        id: "bob.listing-with-knowledge",
        type: "listing",
        title: "Bob's Sneaky Knowledge Listing",
        tagline: "Hosted elsewhere.",
        description: "A listing entry.",
        author: "bob",
        tags: [],
        nsfw: false,
        icon: "package",
        mods: [],
        external_url: "https://example.com/mod",
      },
      files: knowledgeFiles(goodKnowledgePack()),
    }),
    /Listing plugins must not contain any content files/,
  );
});

// ----- Structural PR shape (unchanged behaviour, guarded) ------------------

test("rejects a PR that touches two plugin directories", () => {
  const prDir = makeTempDir();
  try {
    const a = writePlugin(prDir, "plugins/bob/test-pack", { manifest: goodManifest(), files: GOOD_FILES });
    const b = writePlugin(prDir, "plugins/bob/other-pack", {
      manifest: goodManifest({ id: "bob.other-pack", title: "Bob's Other Pack" }),
      files: GOOD_FILES,
    });
    const res = runValidate({ prDir, changed: [...a, ...b] });
    assertRejected(res, /touches 2 plugin directories/);
  } finally {
    rmDir(prDir);
  }
});

test("rejects a plugin path segment containing a dot", () => {
  const res = validatePlugin({
    pluginDir: "plugins/bob/test.pack",
    manifest: goodManifest({ id: "bob.test-pack" }),
  });
  assertRejected(res, /not a valid id segment/);
});

test("infra-only PRs short-circuit with the infra-only label", () => {
  const prDir = makeTempDir();
  try {
    writeFile(prDir, "hidden.json", "{}\n");
    const res = runValidate({ prDir, changed: ["hidden.json"] });
    assert.equal(res.result.success, true);
    assert.deepEqual(res.result.labels, ["infra-only"]);
  } finally {
    rmDir(prDir);
  }
});

test("rejects a PR mixing plugin and infrastructure files", () => {
  const prDir = makeTempDir();
  try {
    const changed = writePlugin(prDir, "plugins/bob/test-pack", {
      manifest: goodManifest(),
      files: GOOD_FILES,
    });
    writeFile(prDir, "hidden.json", "{}\n");
    const res = runValidate({ prDir, changed: [...changed, "hidden.json"] });
    assertRejected(res, /mixes plugin files/);
  } finally {
    rmDir(prDir);
  }
});

test("the PR author is never used to resolve code — no node_modules in PR_DIR is fine", () => {
  // Regression guard for the trust model: validate.mjs must import only from
  // BASE_DIR-side files. If it ever started resolving anything relative to
  // PR_DIR, this test (whose PR_DIR has nothing but plugins/) would fail.
  const res = validatePlugin({ manifest: goodManifest() });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.ok(!fs.existsSync(path.join(process.cwd(), "pr-files.txt")));
});
