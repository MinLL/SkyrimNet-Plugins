#!/usr/bin/env node
// SkyrimNet Plugins — index builder
//
// Walks every plugins/{author}/{slug}/manifest.json, extracts the fields
// the dashboard needs for the browse page, counts content files, derives
// first_published, last_updated and the per-bundle version `history` from
// git history, embeds moderation state from hidden.json + curated.json into
// each entry, and writes index.json.
//
// `history` is what makes install / update / rollback work without any hub
// API: each entry pins a published version to the newest commit that carried
// it, and the in-game installer fetches the plugin subtree at that SHA
// (rollback is the same code path with an older SHA). Requires full git
// history — build-index.yml checks out with fetch-depth: 0.
//
// Moderation files (hidden.json / curated.json) remain the source-of-
// truth and are still hand-edited (or moderation-tool-edited) on main.
// build-index just bakes their state into the per-plugin entries so
// the dashboard only has to fetch one file. The trigger paths in
// build-index.yml include both moderation files, so any edit to them
// runs this script and refreshes the index.
//
// Zero external dependencies — only Node built-ins.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");
const INDEX_PATH = path.join(REPO_ROOT, "index.json");
const HIDDEN_PATH = path.join(REPO_ROOT, "hidden.json");
const CURATED_PATH = path.join(REPO_ROOT, "curated.json");

// Index format version. Bumped to 2 for the content-store format (plugin_id,
// history, min_skyrimnet_version, no knowledge counts).
const INDEX_SCHEMA_VERSION = 2;

// Version-history caps. HISTORY_CAP bounds how far back rollback can reach
// (and how large index.json grows across the whole ecosystem); the commit
// scan limit bounds the work per plugin for content-heavy plugins that get
// many same-version pushes.
const HISTORY_CAP = 20;
const HISTORY_COMMIT_SCAN_LIMIT = 200;

// ----- Helpers ---------------------------------------------------------------

function git(args) {
  // Returns trimmed stdout, or null when git fails (no history, unborn repo,
  // path never existed at that commit, ...).
  try {
    return execFileSync("git", args, { encoding: "utf8", cwd: REPO_ROOT }).trim();
  } catch {
    return null;
  }
}

function gitFirstLine(args) {
  const out = git(args);
  if (!out) return null;
  const line = out.split("\n")[0].trim();
  return line || null;
}

/**
 * Published version history for one plugin, newest first.
 *
 * Walks the commits touching the plugin directory from newest to oldest and
 * records the FIRST commit seen for each distinct manifest version — i.e. the
 * newest commit at which the plugin carried that version. That is the copy a
 * rollback should restore: the hub permits same-version republishes, so the
 * last commit of a version is its final content.
 */
function pluginHistory(relPath) {
  const log = git([
    "log",
    `-n${HISTORY_COMMIT_SCAN_LIMIT}`,
    "--format=%H\t%aI",
    "--",
    relPath,
  ]);
  if (!log) return [];

  const history = [];
  const seenVersions = new Set();

  for (const line of log.split("\n")) {
    const [sha, date] = line.trim().split("\t");
    if (!sha || !date) continue;

    const manifestText = git(["show", `${sha}:${relPath}/manifest.json`]);
    if (!manifestText) continue; // manifest didn't exist at that commit

    let version;
    try {
      version = JSON.parse(manifestText).version;
    } catch {
      continue; // unparseable manifest at that commit — skip, don't fail the build
    }
    if (typeof version !== "string" || version.length === 0) continue;
    if (seenVersions.has(version)) continue;

    seenVersions.add(version);
    history.push({ version, commit: sha, date });
    if (history.length >= HISTORY_CAP) break;
  }

  return history;
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(d, entry.name));
      else if (entry.isFile()) count++;
    }
  }
  return count;
}

// ----- Load moderation state ------------------------------------------------

// Map<pluginId, { reason, hidden_at, moderator? }> — full entry preserved
// so the dashboard can show the reason on the author's profile view.
//
// Parse errors on either moderation file are treated as hard failures:
// the dashboard relies on these to filter the browse view (hidden) and
// to show the curated star, and silently dropping the data because of a
// missing comma corrupts the index in ways that aren't obvious until a
// moderator notices something missing. Fail loudly so the workflow run
// goes red and the underlying JSON gets fixed.
const hiddenById = new Map();
if (fs.existsSync(HIDDEN_PATH)) {
  let hidden;
  try {
    hidden = JSON.parse(fs.readFileSync(HIDDEN_PATH, "utf8"));
  } catch (e) {
    console.error(`Failed to parse hidden.json: ${e.message}`);
    process.exit(1);
  }
  if (Array.isArray(hidden.hidden)) {
    for (const h of hidden.hidden) {
      if (h && typeof h.id === "string") {
        hiddenById.set(h.id, {
          reason: h.reason ?? null,
          hidden_at: h.hidden_at ?? null,
          moderator: h.moderator ?? null,
        });
      }
    }
  }
}

// Set<pluginId> — curated.json has only the slug per entry today; expand
// when more fields land.
const curatedIds = new Set();
if (fs.existsSync(CURATED_PATH)) {
  let curated;
  try {
    curated = JSON.parse(fs.readFileSync(CURATED_PATH, "utf8"));
  } catch (e) {
    console.error(`Failed to parse curated.json: ${e.message}`);
    process.exit(1);
  }
  if (Array.isArray(curated.curated)) {
    for (const c of curated.curated) {
      const id = typeof c === "string" ? c : c?.id;
      if (typeof id === "string") curatedIds.add(id);
    }
  }
}

// ----- Walk plugins ----------------------------------------------------------

const plugins = [];

if (!fs.existsSync(PLUGINS_DIR)) {
  console.log("No plugins/ directory — writing empty index.");
} else {
  for (const authorEntry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!authorEntry.isDirectory()) continue;
    const authorDir = path.join(PLUGINS_DIR, authorEntry.name);

    for (const slugEntry of fs.readdirSync(authorDir, { withFileTypes: true })) {
      if (!slugEntry.isDirectory()) continue;
      const pluginDir = path.join(authorDir, slugEntry.name);
      const pluginId = `plugins/${authorEntry.name}/${slugEntry.name}`;

      // Read manifest
      const manifestPath = path.join(pluginDir, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        console.warn(`  [skip] ${pluginId} — no manifest.json`);
        continue;
      }

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (e) {
        console.warn(`  [skip] ${pluginId} — manifest parse error: ${e.message}`);
        continue;
      }

      // Derive git dates from the plugin directory's history. --reverse emits
      // every matching commit, so take the first line only — a plugin whose
      // files were added across several commits has several 'A' rows.
      const relPath = path.relative(REPO_ROOT, pluginDir).split(path.sep).join("/");
      const firstPublished =
        gitFirstLine(["log", "--reverse", "--format=%aI", "--diff-filter=A", "--", relPath]) ||
        gitFirstLine(["log", "--reverse", "--format=%aI", "--", relPath]);
      const lastUpdated = gitFirstLine(["log", "-1", "--format=%aI", "--", relPath]);

      // Count content files. v1 content types are prompts, triggers and
      // actions — knowledge packs are punted and rejected by the validator.
      //
      // Character bios live in prompts/characters/. They are their own
      // category (Character Packs) rather than generic prompts, so count them
      // separately as `bios` and exclude them from the `prompts` count — a
      // pack of bios is not a prompt plugin. countFiles(prompts) is recursive,
      // so the plain prompts count is the total minus the bios under it.
      const promptsDir = path.join(pluginDir, "prompts");
      const biosCount = countFiles(path.join(promptsDir, "characters"));
      const contents = manifest.type === "bundle" ? {
        triggers: countFiles(path.join(pluginDir, "triggers")),
        actions: countFiles(path.join(pluginDir, "actions")),
        prompts: countFiles(promptsDir) - biosCount,
        bios: biosCount,
      } : undefined;

      // Build mods array (name + file + required)
      const mods = Array.isArray(manifest.mods)
        ? manifest.mods.map(m => ({
            name: m.name || m.file || "",
            file: (m.file || "").toLowerCase(),
            required: !!m.required,
          })).filter(m => m.file)
        : [];

      // Build index entry. version / skyrimnet_version only apply to bundles
      // — listings point at external content whose version is the upstream's
      // concern, not ours.
      // The content-store id ('{author}.{slug}') is authoritative in the
      // manifest and validated against the path by CI; derive it only as a
      // fallback for manifests that predate the field.
      const contentStoreId =
        typeof manifest.id === "string" && manifest.id.length > 0
          ? manifest.id
          : `${authorEntry.name}.${slugEntry.name}`.toLowerCase();

      const entry = {
        id: pluginId,
        plugin_id: contentStoreId,
        type: manifest.type,
        title: manifest.title,
        tagline: manifest.tagline,
        author: manifest.author,
        tags: Array.isArray(manifest.tags) ? manifest.tags : [],
        nsfw: !!manifest.nsfw,
        icon: typeof manifest.icon === 'string' && manifest.icon ? manifest.icon : 'package',
        mods,
        first_published: firstPublished || new Date().toISOString(),
        last_updated: lastUpdated || new Date().toISOString(),
      };

      if (manifest.type === 'bundle') {
        entry.version = manifest.version;
        entry.min_skyrimnet_version = manifest.min_skyrimnet_version;
        // Version history drives install / update / rollback (§5 step 1).
        // Listings have nothing to install, so they carry none.
        entry.history = pluginHistory(relPath);
      }
      if (manifest.type === 'listing' && typeof manifest.external_url === 'string') {
        entry.external_url = manifest.external_url;
      }

      if (contents !== undefined) {
        entry.contents = contents;
      }

      // Embed moderation state. `hidden` is the full entry from
      // hidden.json (so the author's profile view can show the reason)
      // or null if not hidden. `curated` is a plain boolean flag.
      const hiddenEntry = hiddenById.get(pluginId);
      if (hiddenEntry) entry.hidden = hiddenEntry;
      if (curatedIds.has(pluginId)) entry.curated = true;

      plugins.push(entry);
      const mod = hiddenEntry ? " [hidden]" : (entry.curated ? " [curated]" : "");
      console.log(`  [ok] ${pluginId} (${manifest.type}, ${manifest.title})${mod}`);
    }
  }
}

// Sort by last_updated descending (newest first)
plugins.sort((a, b) => b.last_updated.localeCompare(a.last_updated));

// ----- Write index -----------------------------------------------------------

const index = {
  schema_version: INDEX_SCHEMA_VERSION,
  generated_at: new Date().toISOString(),
  plugins,
};

fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
console.log(`\nWrote index.json: ${plugins.length} plugins`);
