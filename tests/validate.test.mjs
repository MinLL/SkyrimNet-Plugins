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
  goodEntity,
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
import { makeJpeg, makePng } from "./helpers/images.mjs";

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

test("happy path: a manifest declaring a language is accepted", () => {
  const res = validatePlugin({ manifest: goodManifest({ language: "de" }) });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
});

test("happy path: a manifest carrying a changelog is accepted", () => {
  const res = validatePlugin({ manifest: goodManifest({ changelog: "Added Lydia's banter." }) });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("rejects a changelog that is blank or over the ceiling", () => {
  for (const changelog of ["", "x".repeat(2001)]) {
    assertRejected(validatePlugin({ manifest: goodManifest({ changelog }) }), /changelog/);
  }
});

test("a listing's changelog needs a version to attach to", () => {
  const listing = (over) => {
    const manifest = goodManifest({ type: "listing", external_url: "https://example.org/mod", ...over });
    delete manifest.min_skyrimnet_version;
    return manifest;
  };
  const unversioned = listing({ changelog: "First." });
  delete unversioned.version;
  assertRejected(validatePlugin({ manifest: unversioned, files: {} }), /version/);

  const res = validatePlugin({ manifest: listing({ version: "2.1.0", changelog: "Now on Nexus." }), files: {} });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("rejects a language that is not a bare lowercase ISO 639-1 code", () => {
  for (const language of ["German", "DE", "de-DE", ""]) {
    assertRejected(validatePlugin({ manifest: goodManifest({ language }) }), /language/);
  }
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

test("a knowledge entry with an empty display_name is accepted", () => {
  // SkyrimNet's entry form does not require a label and MCP-created entries may omit it;
  // the export writes "" and keys the entry "entry". Structural validation must accept
  // what the client legitimately produces.
  const res = validatePlugin({
    manifest: goodManifest(),
    files: knowledgeFiles(goodKnowledgePack({ entries: [knowledgeEntry({ display_name: "" })] })),
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
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

// ----- Virtual entities (entities/*.entity.yaml) ----------------------------
//
// The fifth content root. One record per virtual NPC; parse-only like a
// trigger, plus the rules the engine would otherwise apply silently (no name
// means never loaded, a fixed entity's plugin copy is ignored, an unknown
// mode becomes private, duplicate names collapse).

const ENTITY_PATH = "entities/the_whispering_voice_virtual.entity.yaml";

function entityFiles(record) {
  return { [ENTITY_PATH]: record };
}

test("accepts an entity-only bundle and routes it to agent review", () => {
  const res = validatePlugin({
    manifest: goodManifest(),
    files: entityFiles(goodEntity()),
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
});

test("accepts an entity alongside its bio prompt and a trigger, still agent-reviewed", () => {
  const res = validatePlugin({
    manifest: goodManifest(),
    files: {
      ...GOOD_FILES,
      ...entityFiles(goodEntity()),
      "prompts/characters/the_whispering_voice_virtual.prompt": "{% block summary %}A voice.{% endblock %}\n",
    },
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
});

test("accepts a nested entity path", () => {
  const res = validatePlugin({
    manifest: goodManifest(),
    files: { "entities/pact/spirit.entity.yaml": goodEntity({ entityName: "Pact Spirit" }) },
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("an entity's in-file name need not match the filename stem", () => {
  // The engine keys by entityName and derives the filename itself — the
  // trigger/action name==stem rule must not leak.
  const res = validatePlugin({
    manifest: goodManifest(),
    files: { "entities/anything.entity.yaml": goodEntity() },
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("accepts a public entity and one with only the required field", () => {
  const res = validatePlugin({
    manifest: goodManifest(),
    files: {
      "entities/a.entity.yaml": goodEntity({ entityName: "Town Crier", conversationMode: "public" }),
      "entities/b.entity.yaml": "entityName: Bare Minimum\n",
    },
  });
  assert.equal(res.result.success, true, errorMessages(res.result));
});

test("rejects an entity file with the wrong extension", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "entities/npc.yaml": goodEntity() } }),
    /\[BAD_EXTENSION\]/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "entities/npc.ENTITY.YAML": goodEntity() } }),
    /\[BAD_EXTENSION\]/,
  );
});

test("rejects an entity file that is not a YAML mapping", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: entityFiles("- just\n- a list\n") }),
    /YAML mapping at the top level/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: entityFiles("entityName: [unclosed\n") }),
    /YAML parse error/,
  );
});

test("rejects an entity with no entityName", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: entityFiles(goodEntity({ entityName: undefined })),
    }),
    /no 'entityName' string/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: entityFiles(goodEntity({ entityName: "  " })) }),
    /no 'entityName' string/,
  );
});

test("rejects a plugin copy of a fixed virtual entity", () => {
  for (const name of ["Player Thoughts", "Narrator", "System Voice", "Game Master"]) {
    assertRejected(
      validatePlugin({ manifest: goodManifest(), files: entityFiles(goodEntity({ entityName: name })) }),
      /fixed virtual entities/,
    );
  }
});

test("rejects an entity whose conversationMode is not private or public", () => {
  for (const mode of ["system", "loud"]) {
    assertRejected(
      validatePlugin({
        manifest: goodManifest(),
        files: entityFiles(goodEntity({ conversationMode: mode })),
      }),
      /conversationMode/,
    );
  }
});

test("rejects two entity files naming the same entity, case-insensitively", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: {
        "entities/a.entity.yaml": goodEntity({ entityName: "The Whispering Voice" }),
        "entities/b.entity.yaml": goodEntity({ entityName: "the whispering voice" }),
      },
    }),
    /is also declared by/,
  );
});

test("rejects an entity file over the 32 KB per-file limit", () => {
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: entityFiles(goodEntity({ displayName: "x".repeat(40 * 1024) })),
    }),
    /exceeds the 32\.0 KB per-file limit for entity files/,
  );
});

test("rejects a listing that ships an entity", () => {
  assertRejected(
    validatePlugin({
      pluginDir: "plugins/bob/listing-with-entity",
      manifest: {
        id: "bob.listing-with-entity",
        type: "listing",
        title: "Bob's Sneaky Entity Listing",
        tagline: "Hosted elsewhere.",
        description: "A listing entry.",
        author: "bob",
        tags: [],
        nsfw: false,
        icon: "package",
        mods: [],
        external_url: "https://example.com/mod",
      },
      files: entityFiles(goodEntity()),
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

// ----- Cover image ---------------------------------------------------------

const IMAGE_FILES = { ...GOOD_FILES, "cover.png": makePng(1280, 720) };

test("cover image: a declared PNG at the plugin root is accepted and reported", () => {
  const res = validatePlugin({ manifest: goodManifest({ image: "cover.png" }), files: IMAGE_FILES });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
  assert.equal(res.result.image_file, "plugins/bob/test-pack/cover.png");
});

test("cover image: image_file is null when the manifest names none", () => {
  const res = validatePlugin({ manifest: goodManifest() });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.equal(res.result.image_file, null);
});

test("cover image: a listing may carry a JPEG and still routes to manual review", () => {
  const manifest = goodManifest({
    type: "listing", external_url: "https://example.org/mod", image: "cover.jpg",
  });
  delete manifest.min_skyrimnet_version;
  const res = validatePlugin({ manifest, files: { "cover.jpg": makeJpeg(1280, 720) } });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["manual-review"]);
  assert.equal(res.result.image_file, "plugins/bob/test-pack/cover.jpg");
});

test("cover image: an image file the manifest does not name is refused", () => {
  const res = validatePlugin({ manifest: goodManifest(), files: IMAGE_FILES });
  assertRejected(res, /not named by manifest\.image/);
  assert.equal(res.result.image_file, null);
});

test("cover image: a second image beside the declared one is refused", () => {
  const files = { ...IMAGE_FILES, "banner.jpg": makeJpeg(800, 600) };
  assertRejected(validatePlugin({ manifest: goodManifest({ image: "cover.png" }), files }), /banner\.jpg.*not named/);
});

test("cover image: a declared image that is not in the tree is refused", () => {
  assertRejected(validatePlugin({ manifest: goodManifest({ image: "cover.png" }) }), /no such regular file exists/);
});

test("cover image: the manifest may only name a bare png/jpg/jpeg filename", () => {
  for (const image of ["cover.webp", "cover.gif", "assets/cover.png", "cover.PNG", ""]) {
    assertRejected(validatePlugin({ manifest: goodManifest({ image }), files: IMAGE_FILES }), /image/);
  }
});

test("cover image: bytes must match the extension", () => {
  const res = validatePlugin({
    manifest: goodManifest({ image: "cover.jpg" }),
    files: { ...GOOD_FILES, "cover.jpg": makePng(500, 500) },
  });
  assertRejected(res, /extension says JPEG/);
  assert.equal(res.result.image_file, null);
});

test("cover image: non-image bytes are refused", () => {
  const res = validatePlugin({
    manifest: goodManifest({ image: "cover.png" }),
    files: { ...GOOD_FILES, "cover.png": "<svg/>" },
  });
  assertRejected(res, /not a PNG or JPEG/);
});

test("cover image: over the byte cap is refused", () => {
  const big = Buffer.concat([makePng(500, 500), Buffer.alloc(5 * 1024 * 1024)]);
  const res = validatePlugin({
    manifest: goodManifest({ image: "cover.png" }),
    files: { ...GOOD_FILES, "cover.png": big },
  });
  assertRejected(res, /over the 5\.00 MB limit/);
});

test("cover image: not 16:9, or outside the width window, is refused", () => {
  const check = (w, h, re) => {
    const res = validatePlugin({
      manifest: goodManifest({ image: "cover.jpg" }),
      files: { ...GOOD_FILES, "cover.jpg": makeJpeg(w, h) },
    });
    assertRejected(res, re);
  };
  check(1122, 1402, /not 16:9/);
  check(4000, 100, /not 16:9/);
  check(320, 180, /width must be between/);
  check(4000, 2250, /width must be between/);
});

test("cover image: a directory or symlink named as the cover is refused, not a crash", POSIX_ONLY, () => {
  const prDir = makeTempDir();
  try {
    const changed = writePlugin(prDir, "plugins/bob/test-pack", {
      manifest: goodManifest({ image: "cover.png" }),
      files: { ...GOOD_FILES, "cover.png/x.prompt": "x" },
    });
    assertRejected(runValidate({ prDir, changed }), /no such regular file/);
  } finally {
    rmDir(prDir);
  }
  const linked = makeTempDir();
  try {
    const changed = writePlugin(linked, "plugins/bob/test-pack", { manifest: goodManifest({ image: "cover.png" }), files: GOOD_FILES });
    fs.symlinkSync(path.join(linked, "plugins/bob/test-pack/prompts/hello.prompt"), path.join(linked, "plugins/bob/test-pack/cover.png"));
    changed.push("plugins/bob/test-pack/cover.png");
    assertRejected(runValidate({ prDir: linked, changed }), /no such regular file/);
  } finally {
    rmDir(linked);
  }
});

test("cover image: a mis-cased root image gets the image message, not the content-root one", () => {
  const res = validatePlugin({ manifest: goodManifest(), files: { ...GOOD_FILES, "cover.PNG": makePng(500, 500) } });
  assertRejected(res, /not named by manifest\.image/);
});

// ----- Config-system roots (one record per file) ----------------------------
// Each root's record rules run end to end here (unit tests: record-rules.test.mjs). Every one of these roots
// opens at 0.25.0 in ROOT_TABLE, which goodManifest declares, so a record that passes leaves no error.

const GATED_ROOT_RE = /\[ROOT_MIN_VERSION\]$/;

function acceptsRecord(files, manifest = goodManifest()) {
  const res = validatePlugin({ manifest, files });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.errors, []);
  return res;
}

test("a gated root needs min_skyrimnet_version of at least 0.25.0, naming the root and both versions", () => {
  const files = { "spells/skyrim-esm_012FCD.yaml": "form: Skyrim.esm|0x012FCD\n" };
  const res = validatePlugin({ manifest: goodManifest({ min_skyrimnet_version: "0.24.0" }), files });
  assertRejected(
    res,
    /Files under spells\/ need SkyrimNet 0\.25\.0 or newer, but manifest\.min_skyrimnet_version is '0\.24\.0'\. Raise it to at least 0\.25\.0\. \[ROOT_MIN_VERSION\]/,
  );
  assert.equal(res.result.errors.length, 1);
  assert.equal(res.result.errors[0].file, "plugins/bob/test-pack/manifest.json");
  for (const declared of ["0.25.0", "0.25.1", "9.0.0"]) {
    acceptsRecord(files, goodManifest({ min_skyrimnet_version: declared }));
  }
});

test("voice_effects: a recipe whose id is the stem passes its record rules", () => {
  acceptsRecord({ "voice_effects/draugr.yaml": "id: draugr\nname: Draugr\nchain: []\n" });
  acceptsRecord({ "voice_effects/nested/ve_1a2b3c.yaml": "id: ve_1a2b3c\n" });
});

test("voice_effects: a recipe whose id is not the stem is refused", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "voice_effects/narrator_reverb.yaml": "id: narrator_effect\n" } }),
    /id 'narrator_effect' does not match the filename stem 'narrator_reverb'/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "voice_effects/draugr.yaml": "name: Draugr\n" } }),
    /no 'id' field/,
  );
});

test("items: a record at its form stem is accepted; enabled is refused naming npc_usable", () => {
  acceptsRecord({ "items/skyrim-esm_01396B.yaml": "form: Skyrim.esm|0x01396B\ncustomName: Wuuthrad\nnpc_usable: false\n" });
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "items/skyrim-esm_01396B.yaml": "form: Skyrim.esm|0x01396B\nenabled: false\n" } }),
    /'enabled' in a items\/ file means record activation[^\n]*npc_usable: false[^\n]*\[ENABLED_NOT_ACTIVATION\]/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "items/wuuthrad.yaml": "form: Skyrim.esm|0x01396B\n" } }),
    /stem 'wuuthrad' is not the stem of form 'Skyrim.esm\|0x01396B', which is 'skyrim-esm_01396B'/,
  );
});

test("spells: a record at its form stem is accepted; a bad form reference is refused", () => {
  acceptsRecord({ "spells/skyrim-esm_012FCD.yaml": "form: Skyrim.esm|0x012FCD\ncustomName: Flames\n" });
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "spells/skyrim-esm_012FCD.yaml": "form: 0x012FCD\n" } }),
    // YAML reads the bare hex as the integer 77773; the message says to quote it.
    /form is the number 77773, not a form reference[^\n]*as a quoted string\. \[FORM_INVALID\]/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "spells/skyrim-esm_012FCD.yaml": "form: Skyrim.esm|0x012FCD\nenabled: true\n" } }),
    /npc_usable: true/,
  );
});

test("the original roots carry no per-root minimum", () => {
  const res = validatePlugin({ manifest: goodManifest({ min_skyrimnet_version: "0.24.0" }) });
  assert.equal(res.result.success, true, errorMessages(res.result));
  assert.deepEqual(res.result.labels, ["ready-for-agent-review"]);
});

test("a plugin mixing two gated roots reports the gate once per root", () => {
  const res = validatePlugin({
    manifest: goodManifest({ min_skyrimnet_version: "0.24.0" }),
    files: {
      "spells/skyrim-esm_012FCD.yaml": "form: Skyrim.esm|0x012FCD\n",
      "voice_effects/draugr.yaml": "id: draugr\n",
    },
  });
  assertRejected(res);
  const gates = res.result.errors.filter((e) => GATED_ROOT_RE.test(e.message));
  assert.equal(gates.length, 2);
  assert.ok(gates.some((e) => /spells\//.test(e.message)));
  assert.ok(gates.some((e) => /voice_effects\//.test(e.message)));
});

test("furniture: a record at its form stem is accepted; a missing form is refused", () => {
  acceptsRecord({ "furniture/skyrim-esm_000123.yaml": "form: Skyrim.esm|0x000123\nresolved_name: Counter\n" });
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "furniture/skyrim-esm_000123.yaml": "resolved_name: Counter\n" } }),
    /needs a 'form' field of the form 'Plugin\.esp\|0x01396B'[^\n]*\[FORM_MISSING\]/,
  );
});

test("identity: a link at the slug of its name is accepted; an unknown kind is refused", () => {
  acceptsRecord({ "identity/serana_s_shadow.yaml": "name: Serana's Shadow\nidentityA: virtual:Shadow\nidentityB: npc:Dawnguard.esm:0x002B74\n" });
  acceptsRecord({ "identity/line_of_kings.yaml": "kind: succession\nname: Line of Kings\nfrom: npc:Skyrim.esm:0x0350B8\nto: npc:Skyrim.esm:0x0656E2\n" });
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "identity/serana_s_shadow.yaml": "name: Serana's Shadow\nidentityA: virtual:Shadow\nidentityB: npc:0A002B74\n" } }),
    /identityB 'npc:0A002B74' is a runtime form id, which depends on load order\. Spell it 'npc:<Plugin\.esp>:0x002B74'[^\n]*\[NPC_REF_LOAD_ORDER\]/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "identity/shadow.yaml": "name: Serana's Shadow\n" } }),
    /stem 'shadow' is not the slug of name 'Serana's Shadow', which is 'serana_s_shadow'[^\n]*\[SLUG_NOT_STEM\]/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "identity/x.yaml": "kind: merge\nname: x\n" } }),
    /kind is 'merge', not one a identity\/ file may carry\. Use one of link, succession/,
  );
});

test("filters: contributions and rules are accepted; a file without a kind is refused", () => {
  acceptsRecord({
    "filters/my_races.yaml": "kind: actor\nRaceWhitelist: [KhajiitRace]\n",
    "filters/memory.yaml": "kind: memory\nFactionBlacklist: []\n",
    "filters/strip_grunts.yaml": "kind: dialogue_rule\nid: strip_grunts\npattern: '^ugh'\nreplacement: ''\npriority: 10\n",
    "filters/numbers.yaml": "kind: tts_rule\nid: numbers\npattern: '\\d+'\nreplacement: ''\n",
  });
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "filters/my_races.yaml": "RaceWhitelist: [KhajiitRace]\n" } }),
    /Files under filters\/ need a 'kind' field: one of actor, memory, dialogue_rule, tts_rule[^\n]*\[KIND_MISSING\]/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "filters/strip_grunts.yaml": "kind: dialogue_rule\nid: grunts\n" } }),
    /id 'grunts' does not match the filename stem 'strip_grunts'/,
  );
});

test("translator: an npc rule needs the actor base's form; faction, race and global take their own stems", () => {
  acceptsRecord({
    "translator/skyrim-esm_013BBF.yaml": "kind: npc\nform: Skyrim.esm|0x013BBF\nspeechPattern: Speaks in riddles.\n",
    "translator/thalmorfaction.yaml": "kind: faction\nentityEditorId: ThalmorFaction\nspeechPattern: Haughty.\n",
    "translator/khajiitrace.yaml": "kind: race\nentityEditorId: KhajiitRace\nspeechPattern: This one.\n",
    "translator/global.yaml": "kind: global\nspeechPattern: Old Norse cadence.\n",
  });
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "translator/serana_a2c.yaml": "kind: npc\nentityId: serana_a2c\nspeechPattern: x\n" } }),
    /A 'kind: npc' translator rule is keyed on the actor base and needs a 'form' field[^\n]*\[FORM_MISSING\]/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "translator/everyone.yaml": "kind: global\nspeechPattern: x\n" } }),
    /lives at translator\/global\.yaml, not 'everyone'[^\n]*\[GLOBAL_NOT_STEM\]/,
  );
});

test("dialogue_actions: a lists contribution and an instruction are accepted; a bad category lists the ten", () => {
  acceptsRecord({
    "dialogue_actions/nff_defaults.yaml": "kind: lists\nblacklist:\n  - nwsFollowerController\n  - TIF__000C3698\n",
    "dialogue_actions/TIF__000D9B53.yaml":
      "kind: instruction\nkey: TIF__000D9B53\nname: Rent a room\ntext: Offer the room.\ncategory: innkeeper\nenabled: true\n",
  });
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: { "dialogue_actions/TIF__000D9B53.yaml": "kind: instruction\nkey: TIF__000D9B53\ntext: x\ncategory: lodging\n" },
    }),
    /category is 'lodging', not a dialogue-action category\. Use one of quest, follower, merchant, trainer, carriage, innkeeper, bard, marriage, crime, other\. \[CATEGORY_UNKNOWN\]/,
  );
  assertRejected(
    validatePlugin({
      manifest: goodManifest(),
      files: { "dialogue_actions/rent_a_room.yaml": "kind: instruction\nkey: TIF__000D9B53\ntext: x\ncategory: innkeeper\n" },
    }),
    /key 'TIF__000D9B53' does not match the filename stem 'rent_a_room'/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "dialogue_actions/nff.yaml": "kind: lists\nblacklist: nwsFollowerController\n" } }),
    /'blacklist' must be a list of strings[^\n]*\[LIST_NOT_STRINGS\]/,
  );
});

test("record roots: a file that is not a YAML mapping, or does not parse, is refused", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "voice_effects/draugr.yaml": "- just\n- a list\n" } }),
    /voice_effects files must contain a YAML mapping at the top level/,
  );
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "items/skyrim-esm_01396B.yaml": "form: [unclosed\n" } }),
    /YAML parse error/,
  );
});

test("record roots: 64 KB per voice-effect recipe, 32 KB per record elsewhere", () => {
  const filler = (bytes) => `id: draugr\ncomment: "${"x".repeat(bytes)}"\n`;
  acceptsRecord({ "voice_effects/draugr.yaml": filler(48 * 1024) });
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "voice_effects/draugr.yaml": filler(64 * 1024) } }),
    /exceeds the 64\.0 KB per-file limit for voice_effects\/ files/,
  );
  const item = (bytes) => `form: Skyrim.esm|0x01396B\ncomment: "${"x".repeat(bytes)}"\n`;
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "items/skyrim-esm_01396B.yaml": item(32 * 1024) } }),
    /exceeds the 32\.0 KB per-file limit for items\/ files/,
  );
});

test("record roots: the wrong extension is refused by the path rules", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "spells/skyrim-esm_012FCD.yml": "form: Skyrim.esm|0x012FCD\n" } }),
    /\[BAD_EXTENSION\]/,
  );
});

test("a listing that ships a record file is refused as content", () => {
  const manifest = goodManifest({ type: "listing", external_url: "https://example.org/mod" });
  delete manifest.min_skyrimnet_version;
  assertRejected(
    validatePlugin({ manifest, files: { "voice_effects/draugr.yaml": "id: draugr\n" } }),
    /Listing plugins must not contain any content files, but this plugin has 1/,
  );
});
