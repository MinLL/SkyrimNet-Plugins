// End-to-end tests for .github/scripts/validate.mjs.
//
// Each test builds a synthetic PR checkout and runs the real script the way
// review-pipeline.yml does. BASE_DIR is this repo (the trusted side: schemas,
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
  goodManifest,
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

// ----- Path rejections -----------------------------------------------------

test("rejects a file outside the content roots", () => {
  assertRejected(
    validatePlugin({ manifest: goodManifest(), files: { "knowledge/pack.sknpack": "{}" } }),
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
