#!/usr/bin/env node
// Structural validator run by skyrimnet-ops' hub-review.yml from main (env: BASE_DIR trusted, PR_DIR untrusted,
// PR_FILES_FILE, PR_AUTHOR, PR_BODY, PR_NUMBER, RESULT_FILE); the PR side is data only, never executed.

import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import yaml from "js-yaml";

// Path and identity rules shared with the C++ installer; this file wires them to PR data and reporting.
import {
  CODES,
  CONTENT_ROOTS,
  PATH_SEGMENT_RE,
  checkContentPath,
  checkManifestIdentity,
  checkNameMatchesStem,
  checkRootMinEngine,
  findPathCollisions,
  foldCase,
  isReservedAuthorSegment,
} from "./lib/content-rules.mjs";
// What one record file carries, per one-record-per-file root.
import { RECORD_ROOTS, checkRecord } from "./lib/record-rules.mjs";
// The one optional cover image (manifest.image): hub metadata, never installed, so it has no C++ twin.
import { IMAGE_CODES, checkImage, isImageName } from "./lib/image-rules.mjs";

// ----- Configuration -------------------------------------------------------

// One YAML record (a trigger, an action, an entity, a config-system record): a handful of scalars.
const RECORD_FILE_CAP = 32 * 1024;

// Per-file caps in bytes; prompts have only the bundle-level cap.
const PER_FILE_SIZE_LIMITS = {
  trigger: RECORD_FILE_CAP,
  action: RECORD_FILE_CAP,
  // Whole collections of entries; matches MAX_FILE_BYTES on the fateless publish path.
  knowledge: 1024 * 1024,
  entity: RECORD_FILE_CAP,
  ...Object.fromEntries(RECORD_ROOTS.map((root) => [root, RECORD_FILE_CAP])),
  // A recipe carries a whole effect chain.
  voice_effects: 2 * RECORD_FILE_CAP,
  // A plugin's whole Settings page: every field with its description and options.
  settings: 2 * RECORD_FILE_CAP,
};

// Virtual entities the engine itself defines. The engine honours only the
// user's own overlay copy of these (to re-voice or rename them) and ignores a
// plugin's, so a plugin shipping one is refused rather than merged as dead
// weight. Mirrors VirtualEntityRecords::Defaults() in SkyrimNet.
const FIXED_ENTITY_NAMES = new Set(["Player Thoughts", "Narrator", "System Voice", "Game Master"]);

// The modes a shipped entity may declare. `system` belongs to the fixed
// entities only; the engine coerces anything else to `private` silently.
const ENTITY_CONVERSATION_MODES = new Set(["private", "public"]);

const BUNDLE_TOTAL_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB
const BUNDLE_FILE_COUNT_LIMIT = 1500;

const DASHBOARD_MARKER = "<!-- skyrimnet-hub: dashboard-submitted -->";

// ----- Environment ---------------------------------------------------------

const env = {
  BASE_DIR: requireEnv("BASE_DIR"),
  PR_DIR: requireEnv("PR_DIR"),
  PR_FILES_FILE: requireEnv("PR_FILES_FILE"),
  PR_AUTHOR: requireEnv("PR_AUTHOR"),
  PR_BODY: process.env.PR_BODY ?? "",
  PR_NUMBER: process.env.PR_NUMBER ?? "unknown",
  RESULT_FILE: requireEnv("RESULT_FILE"),
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ----- Result collector ----------------------------------------------------

const result = {
  success: false,
  labels: [],
  errors: [],
  warnings: [],
  comment: null,
  // Identified plugin directory (plugins/{author}/{slug}) relative to the
  // repo root, populated once path-scope parsing succeeds. Consumed by the
  // reviewer (skyrimnet-ops hub-review.yml) so it reviews exactly this dir and
  // never re-walks the PR checkout, which also holds every other plugin.
  plugin_root: null,
  // Repo-relative path of the cover image the manifest names, once it has
  // been found on disk (null otherwise). The reviewer workflow excludes it
  // from the agent byte gate, which measures text content only.
  image_file: null,
};

// Set once the plugin directory is known: the PR targets the reserved author
// namespace (official SkyrimNet content). Declared up front because routeOrFail()
// can run from the early-exit paths before the identity section assigns it.
let isOfficialPath = false;

// Set once the manifest is parsed and the PR is a listing: how this listing
// relates to the one on the base branch. "same-url" is the only value that
// lets a listing reach the agent; the other two are a human's call.
//   null          - not a listing
//   "new"         - no listing at this path on main
//   "url-changed" - on main, but external_url differs
//   "same-url"    - on main with the identical external_url
let listingUpdate = null;

function addError(file, message) {
  result.errors.push({ file, message });
  // Emit GitHub Actions annotation so it shows inline in the PR diff
  const escaped = message.replace(/\n/g, "%0A").replace(/\r/g, "");
  if (file) {
    console.log(`::error file=${file}::${escaped}`);
  } else {
    console.log(`::error::${escaped}`);
  }
}

function addWarning(file, message) {
  result.warnings.push({ file, message });
  const escaped = message.replace(/\n/g, "%0A").replace(/\r/g, "");
  if (file) {
    console.log(`::warning file=${file}::${escaped}`);
  } else {
    console.log(`::warning::${escaped}`);
  }
}

function finish() {
  result.success = result.errors.length === 0;

  // Build the comment for the PR (omit if nothing interesting to say)
  const parts = [];
  if (result.errors.length > 0) {
    parts.push(`### Validation failed (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})`);
    parts.push("");
    for (const err of result.errors) {
      parts.push(`- **${err.file ?? "(general)"}** — ${err.message}`);
    }
    parts.push("");
    parts.push("See the inline annotations in the diff for exact locations.");
  }
  if (result.labels.includes("manual-review") && result.errors.length === 0) {
    parts.push(
      "### Routed to manual review",
      "",
      result.manualReason ?? "This PR will be reviewed by a human. Expect up to a week for action-containing submissions.",
    );
  }
  if (result.labels.includes("infra-only") && result.errors.length === 0) {
    parts.push(
      "### Repository infrastructure change",
      "",
      result.manualReason ?? "This PR only modifies repository infrastructure.",
    );
  }
  if (parts.length > 0) {
    result.comment = parts.join("\n");
  }

  fs.writeFileSync(env.RESULT_FILE, JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

// ----- Schema loading ------------------------------------------------------

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
});
addFormats.default(ajv);

// The manifest schema and the knowledge-pack schema are enforced in CI.
// Trigger/action/entity YAMLs are
// generated by the SkyrimNet dashboard and validated by SkyrimNet's own
// in-game validators at publish time — we trust that pipeline and only
// re-check that each content file parses cleanly and that its in-file `name`
// equals the filename stem. The schemas for those file types exist in the
// repo as reference/documentation for third-party tooling, but we do not
// compile or enforce them from the validator.
const schemasDir = path.join(env.BASE_DIR, "schemas");
const schemas = {};

const manifestSchemaPath = path.join(schemasDir, "manifest.schema.json");
if (!fs.existsSync(manifestSchemaPath)) {
  console.error(`Missing schema: ${manifestSchemaPath}`);
  process.exit(1);
}
const manifestSchemaRaw = JSON.parse(fs.readFileSync(manifestSchemaPath, "utf8"));
schemas.manifest = {
  raw: manifestSchemaRaw,
  validate: ajv.compile(manifestSchemaRaw),
};

// Knowledge packs ARE schema-checked: unlike triggers and actions, a malformed
// pack is not merely inert — the engine's store sync parses it on every save
// load, and a pack missing per-entry keys can never be updated in place.
const knowledgeSchemaPath = path.join(schemasDir, "knowledge-pack.schema.json");
if (!fs.existsSync(knowledgeSchemaPath)) {
  console.error(`Missing schema: ${knowledgeSchemaPath}`);
  process.exit(1);
}
const knowledgeSchemaRaw = JSON.parse(fs.readFileSync(knowledgeSchemaPath, "utf8"));
schemas.knowledge = {
  raw: knowledgeSchemaRaw,
  validate: ajv.compile(knowledgeSchemaRaw),
};

// ----- Author ban check ---------------------------------------------------
//
// Read bans.json from the upstream base directory and reject the PR if the
// author declared in the manifest is in the active ban list. Bans are keyed
// on the username string (the SaaS-authoritative immutable identifier) and
// checked AFTER the manifest is parsed below. The ban load happens here so
// it's in one place, but the match happens after manifest load.
let bans = [];
const bansPath = path.join(env.BASE_DIR, "bans.json");
if (fs.existsSync(bansPath)) {
  try {
    const bansRaw = JSON.parse(fs.readFileSync(bansPath, "utf8"));
    bans = Array.isArray(bansRaw?.bans) ? bansRaw.bans : [];
  } catch (e) {
    addWarning(null, `Could not read bans.json: ${e.message}`);
  }
}

function activeBanFor(author) {
  const now = Date.now();
  return bans.find((b) => {
    if (b?.author !== author) return false;
    if (b.expires_at == null) return true;
    const expiry = Date.parse(b.expires_at);
    return Number.isFinite(expiry) ? expiry > now : true;
  });
}

// ----- Detect manual vs dashboard PR --------------------------------------
//
// Dashboard PRs are opened by the hub's GitHub App (a bot account). Contributors
// don't have GitHub accounts tied to the hub — their identity is the SaaS
// username carried in manifest.author. Integrity of that claim is enforced by
// the SaaS at publish time (the dashboard can only write PRs on behalf of the
// authenticated user), not by this validator.
//
// To treat a PR as dashboard-submitted we require BOTH:
//   1. The PR opener is the hub's own App (exact login, not any '[bot]').
//   2. The PR body contains the dashboard marker comment.
//
// The bot check is the gate — the marker is copy-pasteable and alone provides
// no integrity. The hub App's installation token lives only in the backend
// that fronts the SaaS-authenticated user. Any other installed App (Dependabot,
// the reviewer App itself) is not that trust root, so the login is pinned.

const DASHBOARD_BOT_LOGIN = process.env.DASHBOARD_BOT_LOGIN || "skyrimnet-plugin-hub-bot[bot]";
const isBotAuthor = env.PR_AUTHOR === DASHBOARD_BOT_LOGIN;
const isDashboardSubmitted = isBotAuthor && env.PR_BODY.includes(DASHBOARD_MARKER);
if (!isDashboardSubmitted) {
  console.log(
    "PR is not dashboard-submitted (bot + marker). Routing to manual review after structural checks.",
  );
}

// ----- Changed files -------------------------------------------------------
//
// The list of files this PR actually changes comes from the GitHub Pulls API
// (written to PR_FILES_FILE by the workflow). We intentionally do NOT walk
// PR_DIR for this — sparse-checkout pulls the full plugins/ tree from the PR
// head, which includes every existing plugin on main. Walking it would cause
// the validator to flag unchanged pre-existing plugins as part of the
// submission.

// Each line is "status\tfilename" emitted by the workflow. Deletions are
// included so we can recognise takedown PRs. Lines that predate the tab
// format are treated as status "changed" for backward compatibility.
let changedFiles = [];
let deletedFiles = [];
try {
  const raw = fs.readFileSync(env.PR_FILES_FILE, "utf8");
  for (const line of raw.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const tab = line.indexOf("\t");
    const status = tab >= 0 ? line.slice(0, tab) : "changed";
    const file = tab >= 0 ? line.slice(tab + 1) : line;
    if (status === "removed") {
      deletedFiles.push(file);
    } else {
      changedFiles.push(file);
    }
  }
} catch (e) {
  addError(null, `Could not read PR file list (${env.PR_FILES_FILE}): ${e.message}`);
  finish();
}

// Deletion PR: every file in the PR is a removal, and they all live under a
// single plugins/{author}/{slug}/ directory. We route these straight through
// with a `deletion` label; the reviewer short-circuits it to approve (nothing
// to scan) and merges.
const allFiles = [...changedFiles, ...deletedFiles];

// Maintainer infra PR: every file the PR touches (added, modified, or
// removed) lives OUTSIDE `plugins/`. Typical cases: editing hidden.json,
// curated.json, bans.json, workflows, scripts, docs. Routed to a dedicated
// `infra-only` label so the reviewer short-circuit-FAILS the gate
// (the agent has nothing to scan, and a failing required check is what
// blocks rogue installation tokens from shipping infra changes). A repo
// admin merges these via the "Merge without waiting for requirements"
// bypass button; the App can't bypass because it isn't an admin.
const isInfraOnly = allFiles.length > 0 && allFiles.every((f) => !f.startsWith("plugins/"));
if (isInfraOnly) {
  result.labels.push("infra-only");
  result.manualReason =
    `This PR only modifies repository infrastructure (not plugin content). ` +
    `The agent-review check is intentionally left red; a repo admin must ` +
    `bypass the failing check to merge.`;
  console.log(
    `Infra-only PR detected (${allFiles.length} file(s) outside plugins/). Routing as infra-only.`,
  );
  finish();
}

// Mixed PR: some files under plugins/, some outside. Rejected outright.
//
// Without this guard, a rogue installation token could open a PR carrying
// real plugin content (which the LLM scans + approves) plus a hidden.json
// edit hitching a ride. The agent only reads plugin content, so the
// out-of-band file change rides the auto-merge path. There is no
// legitimate reason to mix the two — dashboard publishes only ever touch
// plugins/{author}/{slug}/, and infra edits only ever touch top-level
// files. So we hard-reject as a validation failure (which closes the PR).
const pluginPathFiles = allFiles.filter((f) => f.startsWith("plugins/"));
const nonPluginFiles  = allFiles.filter((f) => !f.startsWith("plugins/"));
if (pluginPathFiles.length > 0 && nonPluginFiles.length > 0) {
  addError(
    null,
    `PR mixes plugin files (under plugins/) with infrastructure files (outside plugins/). ` +
      `These must be split into separate PRs:\n` +
      nonPluginFiles.map((f) => `  - ${f} (infra)`).join("\n") +
      `\n` +
      pluginPathFiles.map((f) => `  - ${f} (plugin)`).join("\n"),
  );
  console.log(
    `Mixed PR rejected: ${pluginPathFiles.length} plugin file(s) + ${nonPluginFiles.length} infra file(s).`,
  );
  routeOrFail();
  finish();
}

const isDeletionPR = changedFiles.length === 0 && deletedFiles.length > 0;
if (isDeletionPR) {
  const deletionRoots = new Set();
  for (const rel of deletedFiles) {
    if (!rel.startsWith("plugins/")) {
      addError(rel, `Deletion PR touches a file outside plugins/. Takedown PRs must only remove files inside a single plugin directory.`);
      continue;
    }
    const parts = rel.split("/");
    if (parts.length < 4) continue;
    deletionRoots.add(`plugins/${parts[1]}/${parts[2]}`);
  }
  if (result.errors.length > 0) { routeOrFail(); finish(); }
  if (deletionRoots.size !== 1) {
    addError(
      null,
      `Deletion PR must remove files from exactly one plugin directory; found ${deletionRoots.size}.`,
    );
    routeOrFail();
    finish();
  }
  const pluginRoot = [...deletionRoots][0];
  const pathAuthor = pluginRoot.split("/")[1];

  // Safety: the plugin must actually exist on the base branch. An "empty
  // deletion" PR that adds no files and removes nothing real would otherwise
  // slide through as a no-op auto-merge.
  const basePluginDir = path.join(env.BASE_DIR, pluginRoot);
  if (!fs.existsSync(basePluginDir)) {
    addError(
      null,
      `Deletion PR targets \`${pluginRoot}\` but that directory does not exist on the base branch.`,
    );
    routeOrFail();
    finish();
  }

  // Safety: every file under the plugin directory on the base branch must
  // appear in deletedFiles — partial deletions aren't allowed. Forces authors
  // through the edit flow instead of sneaking content changes as deletions.
  const baseFiles = walkTree(basePluginDir)
    .map((abs) => toPosix(path.relative(env.BASE_DIR, abs)));
  const deletedSet = new Set(deletedFiles);
  const missing = baseFiles.filter((f) => !deletedSet.has(f));
  if (missing.length > 0) {
    addError(
      null,
      `Deletion PR must remove every file in the plugin directory, but these were not removed:\n${missing.map((m) => `  - ${m}`).join("\n")}`,
    );
    routeOrFail();
    finish();
  }

  // Safety: extra paranoia — reject any "deleted" row that isn't actually
  // under the target plugin directory. The deletionRoots.size === 1 check
  // above already enforces this for well-formed paths, but this catches any
  // oddly shaped rel paths (symlinks, paths with `..`, etc.) that might slip
  // through the split/filter earlier.
  const prefix = `${pluginRoot}/`;
  const stray = deletedFiles.filter((f) => !f.startsWith(prefix));
  if (stray.length > 0) {
    addError(
      null,
      `Deletion PR must only remove files inside \`${pluginRoot}/\`, but these are outside it:\n${stray.map((m) => `  - ${m}`).join("\n")}`,
    );
    routeOrFail();
    finish();
  }

  // Safety: deletions must come through the dashboard. A forked-PR that
  // happens to match the deletion shape must not auto-merge — the bot +
  // marker gate is the same trust anchor used for additions. Non-dashboard
  // deletions route to manual review so a maintainer can decide.
  if (!isDashboardSubmitted) {
    result.labels.push("manual-review");
    result.manualReason =
      `Deletion PR for \`${pluginRoot}\` was not submitted through the dashboard ` +
      `(bot + marker check failed). Routing to manual review; a maintainer must ` +
      `confirm this takedown before merging.`;
    console.log(
      `Deletion PR (${pluginRoot}) is not dashboard-submitted. Routing to manual review.`,
    );
    finish();
  }

  // Log for audit. Every auto-merged deletion writes this line with the path
  // author so retrospective review can catch patterns (e.g. one dashboard
  // account deleting many authors' plugins).
  console.log(
    `[takedown] author=${pathAuthor} plugin=${pluginRoot} files=${deletedFiles.length} pr_author=${env.PR_AUTHOR} pr=#${env.PR_NUMBER}`,
  );

  // Deletion route is its own animal — there's no content for the agent to
  // scan and findPluginDir() would return the wrong plugin dir (the deleted
  // one isn't present in the PR head). Workflow routes this straight to
  // auto-merge.
  result.labels.push("deletion");
  result.comment =
    `### Takedown detected\n\n` +
    `This PR removes \`${pluginRoot}\` in its entirety. Agent review is ` +
    `skipped (no content to scan) and the PR will auto-merge.`;
  finish();
}

// Convert an OS-native relative path to the canonical logical form.
//
// Deliberately splits on path.sep instead of blanket-replacing backslashes:
// on Linux (where CI runs) a git path containing a literal `\` checks out as
// a filename containing that backslash, and rewriting it to `/` here would
// hide the exact sandbox-escape the path rules exist to catch.
function toPosix(p) {
  return p.split(path.sep).join("/");
}

function walkTree(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

// ----- Path scope check ----------------------------------------------------
//
// Sparse checkout only pulls plugins/, so anything present in PR_DIR must be
// under plugins/. We enforce:
//   - files are nested at plugins/{author}/{slug}/...
//   - the author segment is a filesystem-safe, URL-safe string
//   - the slug segment is the usual kebab-case plugin slug
//   - every file in the PR belongs to exactly one plugin directory
//
// We do NOT enforce here that directory-author matches manifest-author — that
// check happens after manifest parsing, where we have the manifest loaded.
//
// Both segments use the same pattern (PATH_SEGMENT_RE): the fateless handle
// charset plus display case. Dots are NOT allowed in either segment — the dot
// is the separator in the plugin id `{author}.{slug}`, and permitting it in a
// segment would make the id ambiguous.

const pluginRoots = new Set();

for (const rel of changedFiles) {
  // Reject any file not under plugins/
  if (!rel.startsWith("plugins/")) {
    addError(rel, `File is outside plugins/. Infrastructure changes must be made directly by maintainers, not via PR.`);
    continue;
  }

  // Must be under plugins/{author}/{slug}/
  const parts = rel.split("/");
  if (parts.length < 4) {
    addError(rel, `File is not deep enough to be inside a plugin directory. Expected plugins/{author}/{slug}/...`);
    continue;
  }
  const [, authorSegment, slug] = parts;
  if (!PATH_SEGMENT_RE.test(authorSegment)) {
    addError(rel, `Plugin author directory '${authorSegment}' is not a valid id segment (letters, digits, '_' and '-' only, 1-64 chars, no dots).`);
    continue;
  }
  if (!PATH_SEGMENT_RE.test(slug)) {
    addError(rel, `Plugin slug '${slug}' is not a valid id segment (letters, digits, '_' and '-' only, 1-64 chars, no dots).`);
    continue;
  }
  pluginRoots.add(`plugins/${authorSegment}/${slug}`);
}

if (result.errors.length > 0) {
  // Path errors short-circuit the rest of validation
  routeOrFail();
  finish();
}

if (pluginRoots.size === 0) {
  addError(null, "No plugin files found in the PR. Nothing to validate.");
  routeOrFail();
  finish();
}

if (pluginRoots.size > 1) {
  addError(
    null,
    `This PR touches ${pluginRoots.size} plugin directories (${[...pluginRoots].join(", ")}). One plugin per PR is required — please split this into separate submissions.`,
  );
  routeOrFail();
  finish();
}

const pluginRoot = [...pluginRoots][0];
const pluginAbs = path.join(env.PR_DIR, pluginRoot);
result.plugin_root = pluginRoot;

// ----- Manifest ------------------------------------------------------------

const manifestPath = `${pluginRoot}/manifest.json`;
const actualManifestAbs = path.join(pluginAbs, "manifest.json");
if (!fs.existsSync(actualManifestAbs)) {
  addError(manifestPath, "manifest.json is missing. Every plugin must have one.");
  routeOrFail();
  finish();
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(actualManifestAbs, "utf8"));
} catch (e) {
  addError(manifestPath, `manifest.json is not valid JSON: ${e.message}`);
  routeOrFail();
  finish();
}

if (!schemas.manifest.validate(manifest)) {
  for (const err of schemas.manifest.validate.errors ?? []) {
    addError(manifestPath, `Schema: ${err.instancePath || "/"} ${err.message}`);
  }
}

// Identity checks (CONTENT_STORE_DESIGN.md §2/§4): `id` is required and must
// be `{author}.{slug}` of the directory the manifest lives at, the author
// segment must agree with manifest.author, versions must be strict semver,
// bundles must declare min_skyrimnet_version, and the reserved `skyrimnet` /
// `skyrimnet-*` author namespace is refused. Comparisons are case-folded:
// the id is canonical lowercase, the repo path and author field may carry
// display case.
const pathAuthor = pluginRoot.split("/")[1];
const pathSlug = pluginRoot.split("/")[2];

// Official content (CONTENT_STORE_DESIGN.md ruling 26): `plugins/skyrimnet/*`
// holds SkyrimNet's own packs — `skyrimnet.bios-{mod}` and whatever follows.
// Maintainers create those by pushing to main directly (the one-plugin-per-PR
// rule and this validator never see that), so a reserved-author plugin that is
// ALREADY on the base branch is official by construction. A PR that updates
// one (a community bio fix) keeps every other identity rule and is always
// routed to a human (see routeOrFail). A PR that would CREATE a new
// reserved-author plugin is still refused: nobody mints official content
// through the submission path.
isOfficialPath = isReservedAuthorSegment(pathAuthor);
const officialExistsOnBase =
  isOfficialPath && fs.existsSync(path.join(env.BASE_DIR, pluginRoot, "manifest.json"));
if (officialExistsOnBase) {
  console.log(
    `Reserved-author plugin '${pluginRoot}' exists on the base branch: treating as an update to official content.`,
  );
}

for (const issue of checkManifestIdentity({ manifest, pathAuthor, pathSlug }).issues) {
  if (issue.code === CODES.RESERVED_AUTHOR && officialExistsOnBase) continue;
  addError(manifestPath, issue.message);
}

// Directory author segment must match manifest.author. The SaaS is the
// integrity root for the claim itself; this validator only ensures the path
// and the manifest agree.
if (typeof manifest.author === "string" && foldCase(manifest.author) !== foldCase(pathAuthor)) {
  addError(
    manifestPath,
    `manifest.author is '${manifest.author}' but the plugin directory is 'plugins/${pathAuthor}/'. These must match. The dashboard populates this automatically — if you are seeing this error after a manual edit, restore the original author.`,
  );
}

// Ban check (keyed on the author string in the manifest).
if (typeof manifest.author === "string") {
  const hit = activeBanFor(manifest.author);
  if (hit) {
    const reason = hit.reason ?? "(no reason given)";
    addError(
      manifestPath,
      `Author '${manifest.author}' is banned from publishing to this hub. Reason: ${reason}. If you believe this is in error, contact the moderators.`,
    );
  }
}

// Listings. The schema enforces external_url and the content-file gate below
// refuses files, so structurally there is nothing more to check. What decides
// the route is the link: a listing is a pointer, and where it points is the
// one thing only a human can vet (the agent has no network). A NEW listing,
// or one whose external_url changes, is therefore always routed to a human
// (see routeOrFail). An update that keeps the link byte-for-byte changes only
// prose (title, tagline, description, tags, changelog, version, the nsfw
// flag) and at most a cover image, the same class of content the agent
// already reviews for bundles, so it takes the agent path. The comparison is
// exact: a trailing slash, a different release tag, or a host change is a new
// destination.
if (manifest.type === "listing") {
  let baseManifest = null;
  try {
    baseManifest = JSON.parse(fs.readFileSync(path.join(env.BASE_DIR, pluginRoot, "manifest.json"), "utf8"));
  } catch {
    baseManifest = null; // absent or unreadable on main: a new listing
  }
  if (baseManifest === null || baseManifest.type !== "listing" || typeof baseManifest.external_url !== "string") {
    listingUpdate = "new";
  } else if (baseManifest.external_url !== manifest.external_url) {
    listingUpdate = "url-changed";
  } else {
    listingUpdate = "same-url";
  }
  console.log(`Listing '${pluginRoot}': ${listingUpdate}`);
}

// Slug consistency (re-slugifying the manifest title and comparing to the
// directory name) used to live here, but it was dropped because the dashboard
// is the canonical source of truth for slug derivation — any mismatch between
// "what the dashboard picked" and "what a standalone re-slugify produces"
// would be a false positive, not a real error. The directory-name slug regex
// in the path scope check above is enough to ensure filesystem/URL safety.

// ----- Content files -------------------------------------------------------

// ----- Cover image ----------------------------------------------------------
//
// The image is the only file allowed at the plugin root besides manifest.json,
// and only when the manifest names it. It is excluded from the content walk
// below (it is not content and the shared path rules would rightly refuse it)
// and checked here on its own: bytes must be the PNG/JPEG the extension
// claims, within the size and pixel caps.

const declaredImage = typeof manifest.image === "string" ? manifest.image : null;
let imageAbs = null;
if (declaredImage !== null) {
  if (!isImageName(declaredImage)) {
    // The schema already rejected the shape; nothing more to say.
  } else if (!isRegularFile(path.join(pluginAbs, declaredImage))) {
    // lstat, not exists: a directory or a symlink named as the cover is not the image.
    addError(
      manifestPath,
      `manifest.image names '${declaredImage}' but no such regular file exists at the plugin root. [${IMAGE_CODES.IMAGE_MISSING}]`,
    );
  } else {
    imageAbs = path.join(pluginAbs, declaredImage);
    const rel = toPosix(path.relative(env.PR_DIR, imageAbs));
    const check = checkImage({ name: declaredImage, bytes: fs.readFileSync(imageAbs) });
    for (const issue of check.issues) {
      addError(rel, `Invalid cover image [${issue.code}]: ${issue.message}`);
    }
    if (check.ok) result.image_file = rel;
  }
}

const contentFiles = walkTree(pluginAbs).filter(
  (abs) => abs !== actualManifestAbs && abs !== imageAbs,
);

function isRegularFile(abs) {
  try {
    return fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

const contents = Object.fromEntries(CONTENT_ROOTS.map((root) => [root, 0]));
let totalBundleSize = 0;
const contentPaths = [];
const seenEntityNames = new Map();

for (const abs of contentFiles) {
  const rel = toPosix(path.relative(env.PR_DIR, abs));
  const subPath = toPosix(path.relative(pluginAbs, abs));

  const stat = fs.statSync(abs);
  totalBundleSize += stat.size;
  contentPaths.push(subPath);

  // Full §5-step-3 path sanitization + root/extension whitelist + reserved
  // dynamic-bio paths. Same rule set (and same rejection codes) the C++
  // installer applies before anything touches disk.
  const pathCheck = checkContentPath(subPath);
  if (!pathCheck.ok) {
    if (!subPath.includes("/") && /\.(png|jpe?g)$/i.test(subPath)) {
      addError(
        rel,
        `Image file '${subPath}' is not named by manifest.image. A plugin ships at most one cover image, declared in the manifest as a bare lowercase-extension filename. [${IMAGE_CODES.IMAGE_UNDECLARED}]`,
      );
    } else {
      addError(rel, `Invalid content path [${pathCheck.code}]: ${pathCheck.message}`);
    }
    continue;
  }

  const root = subPath.split("/")[0];
  switch (root) {
    case "triggers":
      validateYamlFile(rel, abs, subPath, stat, "trigger");
      break;
    case "actions":
      validateYamlFile(rel, abs, subPath, stat, "action");
      break;
    case "prompts":
      validatePromptFile(rel, abs, stat);
      break;
    case "knowledge":
      validateKnowledgeFile(rel, abs, stat);
      break;
    case "entities":
      validateEntityFile(rel, abs, stat, seenEntityNames);
      break;
    case "settings":
      validateSettingsFile(rel, abs, subPath, stat);
      break;
    default:
      if (RECORD_ROOTS.includes(root)) validateRecordFile(rel, abs, subPath, stat, root);
      break;
  }
  contents[root]++;
}

// Case-folded path collisions within the plugin. Windows filesystems are
// case-insensitive, so `prompts/Foo.prompt` and `prompts/foo.prompt` are one
// file at install time and one of them silently disappears.
for (const collision of findPathCollisions(contentPaths)) {
  addError(
    null,
    `Files collide when compared case-insensitively (they would overwrite each other on Windows): ` +
      collision.paths.map((p) => `'${p}'`).join(", "),
  );
}

// Per-root minimum engine release: a reserved root refuses, a versioned one needs min_skyrimnet_version at least it.
if (manifest.type !== "listing") {
  for (const root of CONTENT_ROOTS) {
    if (contents[root] === 0) continue;
    const gate = checkRootMinEngine(root, manifest.min_skyrimnet_version);
    if (!gate.ok) addError(manifestPath, `${gate.message} [${gate.code}]`);
  }
}

// The size cap and YAML parse every YAML content file starts with: the document, or undefined after an error.
// `what` names the file class in the cap message ("trigger", "entity", "items/").
function loadYamlRecord(rel, abs, stat, limit, what) {
  if (stat.size > limit) {
    addError(
      rel,
      `File is ${formatBytes(stat.size)}, exceeds the ${formatBytes(limit)} per-file limit for ${what} files.`,
    );
    return undefined;
  }
  try {
    return yaml.load(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    addError(rel, `YAML parse error: ${e.message}`);
    return undefined;
  }
}

function isYamlMapping(doc) {
  return doc !== null && typeof doc === "object" && !Array.isArray(doc);
}

// Triggers and actions: the engine validated the shape before the dashboard opened the PR; `name` == stem is checked.
function validateYamlFile(rel, abs, subPath, stat, kind) {
  const doc = loadYamlRecord(rel, abs, stat, PER_FILE_SIZE_LIMITS[kind], kind);
  if (doc === undefined) return;
  if (!isYamlMapping(doc)) {
    addError(rel, `${kind} files must contain a YAML mapping at the top level.`);
    return;
  }
  const nameCheck = checkNameMatchesStem(doc.name, subPath);
  if (!nameCheck.ok) {
    addError(rel, nameCheck.message);
  }
}

// A plugin settings schema (`settings/{Name}.yaml`, registered as `Plugin_{Name}`): the engine reads any mapping,
// so only the shape is checked here. The engine reads only `settings/{Name}.yaml` with a plain `{Name}`, which
// becomes the config's name. The pattern is local: the main loop runs before a top-level const here initializes.
function validateSettingsFile(rel, abs, subPath, stat) {
  if (!/^settings\/[A-Za-z0-9_-]+\.yaml$/.test(subPath)) {
    addError(
      rel,
      "Settings schemas must sit directly under settings/ as {Name}.yaml, {Name} being letters, digits, '_' and '-' (it becomes the config name).",
    );
    return;
  }
  const doc = loadYamlRecord(rel, abs, stat, PER_FILE_SIZE_LIMITS.settings, "settings/");
  if (doc === undefined) return;
  if (!isYamlMapping(doc)) {
    addError(rel, "settings files must contain a YAML mapping at the top level.");
  }
}

function validatePromptFile(rel, abs, stat) {
  if (stat.size === 0) {
    addError(rel, "Prompt file is empty.");
    return;
  }
  // UTF-8 sanity check: if Node can read it as utf8 without throwing and
  // re-encoding round-trips, it's valid enough for our purposes.
  try {
    const text = fs.readFileSync(abs, "utf8");
    if (text.trim().length === 0) {
      addError(rel, "Prompt file contains only whitespace.");
    }
  } catch (e) {
    addError(rel, `Could not read as UTF-8 text: ${e.message}`);
  }
}

// Knowledge packs (`knowledge/*.sknpack`). Unlike triggers and actions there is
// no in-file name == stem contract — a pack's identity is its path, and its
// entries' identities are their `key` fields — so checkNameMatchesStem does not
// apply here. What we do check: the size cap, that it parses as JSON, that it
// matches schemas/knowledge-pack.schema.json (format_version 3, per-entry keys),
// and that entry keys are unique within the file. That last rule is the whole
// point of v3 and JSON Schema cannot express it, so it is checked by hand.
function validateKnowledgeFile(rel, abs, stat) {
  const limit = PER_FILE_SIZE_LIMITS.knowledge;
  if (stat.size > limit) {
    addError(
      rel,
      `File is ${formatBytes(stat.size)}, exceeds the ${formatBytes(limit)} per-file limit for knowledge packs. Split large packs across several .sknpack files.`,
    );
    return;
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    addError(rel, `Knowledge pack is not valid JSON: ${e.message}`);
    return;
  }

  if (!schemas.knowledge.validate(doc)) {
    for (const err of schemas.knowledge.validate.errors ?? []) {
      addError(rel, `Knowledge pack schema: ${err.instancePath || "/"} ${err.message}`);
    }
    return;
  }

  const entries = doc.skyrimnet_knowledge_pack?.entries ?? [];
  const seen = new Set();
  for (const entry of entries) {
    const key = entry?.key;
    if (seen.has(key)) {
      addError(
        rel,
        `Knowledge pack has duplicate entry key '${key}'. Entry keys are the identity the engine syncs rows by, so they must be unique within a pack file. Re-export the pack from the dashboard.`,
      );
      return;
    }
    seen.add(key);
  }
}

// Virtual entities, keyed by `entityName` (no name==stem contract): what the engine would otherwise swallow silently,
// a record without a name, a plugin's copy of a fixed entity, an unknown conversationMode, two records naming one entity.
function validateEntityFile(rel, abs, stat, seenNames) {
  const doc = loadYamlRecord(rel, abs, stat, PER_FILE_SIZE_LIMITS.entity, "entity");
  if (doc === undefined) return;
  if (!isYamlMapping(doc)) {
    addError(rel, "entity files must contain a YAML mapping at the top level.");
    return;
  }

  const name = doc.entityName;
  if (typeof name !== "string" || name.trim().length === 0) {
    addError(
      rel,
      "Entity file has no 'entityName' string. The engine keys virtual entities by name and skips a record without one.",
    );
    return;
  }
  if (FIXED_ENTITY_NAMES.has(name)) {
    addError(
      rel,
      `'${name}' is one of SkyrimNet's fixed virtual entities. The engine only honours a user's own copy of it, so a plugin cannot ship one.`,
    );
    return;
  }
  if (doc.conversationMode !== undefined && !ENTITY_CONVERSATION_MODES.has(doc.conversationMode)) {
    addError(
      rel,
      `conversationMode '${doc.conversationMode}' is not 'private' or 'public'. ('system' is reserved for the fixed entities.)`,
    );
  }

  // The engine lowercases the name to derive the bio template's slug, so two
  // names differing only in case are one entity there too.
  const key = foldCase(name);
  if (seenNames.has(key)) {
    addError(
      rel,
      `Entity '${name}' is also declared by '${seenNames.get(key)}' (compared case-insensitively). The engine keys virtual entities by name, so one file would silently replace the other.`,
    );
    return;
  }
  seenNames.set(key, rel);
}

// One-record-per-file roots: the per-root record rules in lib/record-rules.mjs.
function validateRecordFile(rel, abs, subPath, stat, root) {
  const doc = loadYamlRecord(rel, abs, stat, PER_FILE_SIZE_LIMITS[root], `${root}/`);
  if (doc === undefined) return;
  for (const issue of checkRecord(root, doc, subPath).issues) {
    addError(rel, `${issue.message} [${issue.code}]`);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ----- Bundle-wide checks --------------------------------------------------

const totalFileCount = contentFiles.length + 1 + (imageAbs ? 1 : 0); // +1 for manifest.json, +1 for the image
if (imageAbs) totalBundleSize += fs.statSync(imageAbs).size;

if (totalFileCount > BUNDLE_FILE_COUNT_LIMIT) {
  addError(
    null,
    `Plugin contains ${totalFileCount} files, exceeds the ${BUNDLE_FILE_COUNT_LIMIT} per-bundle limit. Very large submissions must be published as a listing plugin pointing to an external mod host.`,
  );
}

if (totalBundleSize > BUNDLE_TOTAL_SIZE_LIMIT) {
  addError(
    null,
    `Plugin total size is ${formatBytes(totalBundleSize)}, exceeds the ${formatBytes(BUNDLE_TOTAL_SIZE_LIMIT)} per-bundle limit. Very large submissions must be published as a listing plugin pointing to an external mod host.`,
  );
}

// Invocation required if plugin contains actions
if (contents.actions > 0 && !manifest.invocation) {
  addError(
    manifestPath,
    "Plugin contains actions but manifest.invocation is missing. Action-containing plugins must declare the invocation block for reviewer context.",
  );
}

// Listing plugins must have no content
if (manifest.type === "listing") {
  const contentCount = Object.values(contents).reduce((sum, n) => sum + n, 0);
  if (contentCount > 0) {
    addError(
      manifestPath,
      `Listing plugins must not contain any content files, but this plugin has ${contentCount}. Listings are metadata-only pointers to externally hosted mods.`,
    );
  }
}

// ----- Title uniqueness (against base/index.json) -------------------------

try {
  const indexPath = path.join(env.BASE_DIR, "index.json");
  if (fs.existsSync(indexPath)) {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (Array.isArray(index.plugins) && typeof manifest.title === "string") {
      const incomingKey = normalizeTitle(manifest.title);
      for (const entry of index.plugins) {
        if (entry.id === pluginRoot) continue; // same plugin, updating itself
        if (typeof entry.title === "string" && normalizeTitle(entry.title) === incomingKey) {
          addError(
            manifestPath,
            `Title '${manifest.title}' collides with existing plugin '${entry.id}' (title: '${entry.title}'). Plugin titles must be globally unique (case-insensitive).`,
          );
          break;
        }
      }
    }
  }
} catch (e) {
  addWarning(null, `Could not check title uniqueness: ${e.message}`);
}

function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:'"]+$/g, "");
}

// ----- Plugin id uniqueness (case-folded, cross-plugin) -------------------
//
// git is case-sensitive; Windows filesystems and the content store's identity
// rules are not. `plugins/bob/Cool-Pack` and `plugins/bob/cool-pack` can both
// exist in the repo, each validating perfectly against its OWN path — and both
// fold to the id `bob.cool-pack`, which is the `store/` directory name on the
// user's disk. Installing both would have one silently overwrite the other.
// Nothing downstream can catch this: the engine sees one id, not two
// submissions. The hub is the only gatekeeper for id uniqueness.

try {
  if (typeof manifest.id === "string" && manifest.id.length > 0) {
    const incomingId = foldCase(manifest.id);
    for (const [otherRoot, otherId] of knownPluginIds()) {
      if (otherRoot === pluginRoot) continue; // this plugin updating itself
      if (otherId !== incomingId) continue;
      addError(
        manifestPath,
        `Plugin id '${manifest.id}' collides with existing plugin '${otherRoot}' when compared case-insensitively. ` +
          `The id is used verbatim as the install directory name on a case-insensitive filesystem, so the two would ` +
          `overwrite each other. Pick a different slug.`,
      );
      break;
    }
  }
} catch (e) {
  addWarning(null, `Could not check plugin id uniqueness: ${e.message}`);
}

// Every plugin id on the base branch as Map<'plugins/{author}/{slug}', folded '{author}.{slug}'>, from the base
// checkout's tree (index.json is rebuilt only after a merge) with index.json merged in as a second source.
function knownPluginIds() {
  const ids = new Map();

  const basePluginsDir = path.join(env.BASE_DIR, "plugins");
  if (fs.existsSync(basePluginsDir)) {
    for (const author of fs.readdirSync(basePluginsDir, { withFileTypes: true })) {
      if (!author.isDirectory()) continue;
      const authorDir = path.join(basePluginsDir, author.name);
      for (const slug of fs.readdirSync(authorDir, { withFileTypes: true })) {
        if (!slug.isDirectory()) continue;
        ids.set(`plugins/${author.name}/${slug.name}`, foldCase(`${author.name}.${slug.name}`));
      }
    }
  }

  const indexPath = path.join(env.BASE_DIR, "index.json");
  if (fs.existsSync(indexPath)) {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    for (const entry of Array.isArray(index.plugins) ? index.plugins : []) {
      if (typeof entry?.id !== "string") continue;
      const id =
        typeof entry.plugin_id === "string" && entry.plugin_id.length > 0
          ? entry.plugin_id
          : entry.id.split("/").slice(1).join(".");
      ids.set(entry.id, foldCase(id));
    }
  }

  return ids;
}

// ----- Routing -------------------------------------------------------------

routeOrFail();
finish();

function routeOrFail() {
  const hasErrors = result.errors.length > 0;

  if (hasErrors) {
    result.labels = ["validation-failed"];
    return;
  }

  if (isOfficialPath) {
    result.labels = ["manual-review"];
    result.manualReason =
      "This PR updates official SkyrimNet content (the reserved `skyrimnet` author namespace). Official content is always reviewed by a maintainer.";
    return;
  }

  if (!isDashboardSubmitted) {
    result.labels = ["manual-review"];
    result.manualReason =
      "This PR was opened manually, not through the SkyrimNet dashboard. Manual submissions are always reviewed by a human. The dashboard's publish flow is the supported path for contributors.";
    return;
  }

  // Dashboard-submitted, structurally clean
  if (contents.actions > 0) {
    result.labels = ["manual-review"];
    result.manualReason =
      "Plugin contains actions. Action-containing plugins are always manually reviewed to verify safety of Papyrus function calls. Expect up to a week for review.";
    return;
  }

  if (manifest.type === "listing" && listingUpdate !== "same-url") {
    result.labels = ["manual-review"];
    result.manualReason =
      listingUpdate === "url-changed"
        ? "This PR changes the listing's `external_url`. A listing is a pointer, and a new destination is always checked by a human before it goes live. Updates that keep the same link are reviewed automatically."
        : "New listings are always reviewed by a human, who checks where the link goes. Later updates that keep the same `external_url` are reviewed automatically.";
    return;
  }

  // Anything without actions (knowledge, entities, records, or a listing that keeps its link) goes to the agent reviewer.
  result.labels = ["ready-for-agent-review"];
}
