// Shared helpers for the CI-script tests.
//
// validate.mjs is a CI entry point, not a library: it reads env vars, walks
// two checkouts and writes a result JSON. These helpers reproduce exactly the
// shape review-pipeline.yml hands it (a trusted BASE_DIR checkout, an
// untrusted PR_DIR containing only plugins/, and a status\tfilename list from
// the GitHub Pulls API) so the tests exercise the real script, not a copy of
// its logic.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCRIPTS_DIR = path.join(REPO_ROOT, ".github", "scripts");
export const VALIDATE_SCRIPT = path.join(SCRIPTS_DIR, "validate.mjs");
export const BUILD_INDEX_SCRIPT = path.join(SCRIPTS_DIR, "build-index.mjs");

export const DASHBOARD_MARKER = "<!-- skyrimnet-hub: dashboard-submitted -->";
export const BOT_AUTHOR = "skyrimnet-hub[bot]";

/** Windows cannot create files with backslashes, colons, trailing dots or
 *  case-colliding names, so the tests that need such files only run on
 *  POSIX. The rule itself is covered on every platform by the corpus test. */
export const POSIX_ONLY = { skip: process.platform === "win32" ? "requires a POSIX filesystem" : false };

export function makeTempDir(prefix = "snhub-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeFile(root, relPath, content) {
  const abs = path.join(root, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/**
 * Materialize a plugin into `root` and return the repo-relative paths written.
 *
 * @param {string} root      checkout root (acts as PR_DIR)
 * @param {string} pluginDir "plugins/{author}/{slug}"
 * @param {object} spec      { manifest, files: { "prompts/x.prompt": "..." } }
 */
export function writePlugin(root, pluginDir, { manifest, files = {} }) {
  const written = [];
  if (manifest !== undefined) {
    const rel = `${pluginDir}/manifest.json`;
    writeFile(root, rel, typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
    written.push(rel);
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = `${pluginDir}/${rel}`;
    writeFile(root, full, content);
    written.push(full);
  }
  return written;
}

/**
 * Run validate.mjs the way the workflow does.
 *
 * @returns {{ status: number, result: object, stdout: string, stderr: string }}
 */
export function runValidate({
  baseDir = REPO_ROOT,
  prDir,
  changed = [],
  removed = [],
  prAuthor = BOT_AUTHOR,
  prBody = DASHBOARD_MARKER,
  workDir = null,
}) {
  const scratch = workDir ?? makeTempDir("snhub-run-");
  const filesList = path.join(scratch, "pr-files.txt");
  const resultFile = path.join(scratch, "validate-result.json");

  const lines = [
    ...changed.map((f) => `changed\t${f}`),
    ...removed.map((f) => `removed\t${f}`),
  ];
  fs.writeFileSync(filesList, lines.join("\n"));

  const proc = spawnSync(process.execPath, [VALIDATE_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      BASE_DIR: baseDir,
      PR_DIR: prDir,
      PR_FILES_FILE: filesList,
      RESULT_FILE: resultFile,
      PR_AUTHOR: prAuthor,
      PR_BODY: prBody,
      PR_NUMBER: "1",
    },
  });

  let result = null;
  if (fs.existsSync(resultFile)) {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  }
  return { status: proc.status, result, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

/** A manifest that passes every rule, for tests to mutate. */
export function goodManifest(overrides = {}) {
  return {
    id: "bob.test-pack",
    type: "bundle",
    title: "Bob's Validator Test Pack",
    tagline: "A fixture plugin.",
    description: "A fixture plugin used by the validator test suite.",
    author: "bob",
    tags: ["test"],
    nsfw: false,
    icon: "package",
    mods: [],
    version: "1.0.0",
    min_skyrimnet_version: "0.25.0",
    ...overrides,
  };
}

export const GOOD_FILES = {
  "prompts/characters/test_npc.prompt": "You are a test NPC.\n",
  "triggers/test_trigger.yaml": "name: test_trigger\nenabled: true\ndescription: fixture\n",
};

export function errorMessages(result) {
  return (result?.errors ?? []).map((e) => e.message).join("\n");
}
