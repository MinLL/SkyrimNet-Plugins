#!/usr/bin/env node
// SkyrimNet Plugins — agent content reviewer
//
// Stage 2 of the review pipeline. Runs inside .github/workflows/agent-review.yml
// after validate.yml has applied the `ready-for-agent-review` label.
//
// Reads:
//   - BASE_DIR:    trusted base branch checkout (prompt files + schemas)
//   - PR_DIR:      untrusted PR head checkout (sparse plugins/ only)
//   - RESULT_FILE: where to write the JSON result for the workflow to read
//   - GITHUB_TOKEN: bearer token for GitHub Models API (granted by the
//                   `models: read` permission in the workflow)
//   - AGENT_MODEL: model name, defaults to openai/gpt-4o-mini
//   - AGENT_CHUNK_SIZE_BYTES: target chunk size in bytes, default 80 KB
//
// Flow:
//   1. Walk PR_DIR to find the single plugin directory
//   2. Read manifest.json → determine SFW vs NSFW mode
//   3. Concatenate base prompt + appropriate appendix
//   4. Walk content files (triggers, actions, prompts, knowledge), build
//      file blobs with `=== FILE: path ===` separators
//   5. Group file blobs into chunks at file boundaries, ~80 KB each
//   6. Call GitHub Models API for each chunk (system prompt + user content)
//   7. Parse each chunk's JSON response
//   8. Aggregate: any reject → reject; any uncertain → uncertain; all approve → approve
//   9. Write JSON result for the workflow's labeling step
//
// Error handling:
//   Every failure path (missing file, API error, rate limit, parse error,
//   malformed response, unexpected exception) produces a result of
//   `agent-uncertain` rather than silently approving. The PR then gets
//   escalated to human review via the manual-review workflow (planned).

import fs from "node:fs";
import path from "node:path";

// ----- Configuration -------------------------------------------------------

const CHUNK_SIZE_BYTES = Number(process.env.AGENT_CHUNK_SIZE_BYTES ?? 81920);
const MAX_TOKENS_PER_CALL = 500; // output tokens — the JSON result is small
const API_ENDPOINT = "https://models.github.ai/inference/chat/completions";
const REQUEST_TIMEOUT_MS = 60000;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 15000; // 15s, 30s, 45s

// Actions plugins are always routed to manual review by validate.yml, so the
// agent review workflow should never see one. If we do somehow see an actions
// file, we return an explicit uncertain result with an explanation.
const CONTENT_DIRS = ["triggers", "actions", "prompts", "knowledge"];

// ----- Environment ---------------------------------------------------------

const env = {
  BASE_DIR: requireEnv("BASE_DIR"),
  PR_DIR: requireEnv("PR_DIR"),
  RESULT_FILE: requireEnv("RESULT_FILE"),
  GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),
  MODEL: process.env.AGENT_MODEL ?? "openai/gpt-4.1",
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ----- Result structure ----------------------------------------------------

const result = {
  success: false,      // true if the review ran cleanly (regardless of decision)
  decision: null,      // "approve" | "reject" | "uncertain"
  labels: [],          // label(s) to apply to the PR
  chunk_count: 0,
  chunk_results: [],   // per-chunk responses (useful for debugging)
  errors: [],          // any structural errors (script crashed, API failed)
  comment: null,       // PR comment to post
};

function addError(message) {
  result.errors.push(message);
  console.log(`::error::${message.replace(/\n/g, "%0A")}`);
}

function finishSoftFail(reason) {
  // Used when the review couldn't complete normally. We always fail to
  // `agent-uncertain` so a human looks at the PR, never to `agent-approved`.
  result.decision = "uncertain";
  result.labels = ["agent-uncertain"];
  result.comment =
    `### Agent review could not complete\n\n${reason}\n\n` +
    `This PR has been escalated to manual review.`;
  result.success = true; // The review "ran" — it just soft-failed. The workflow shouldn't red-mark the job for this.
  writeResultAndExit(0);
}

function writeResultAndExit(code) {
  try {
    fs.writeFileSync(env.RESULT_FILE, JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`Could not write result file: ${e.message}`);
  }
  process.exit(code);
}

// ----- Main ---------------------------------------------------------------

try {
  await main();
} catch (e) {
  addError(`Unexpected exception: ${e.message}\n${e.stack}`);
  finishSoftFail(`The agent review script crashed unexpectedly: ${e.message}`);
}

async function main() {
  // 0. Short-circuit on routes that don't need (or shouldn't get) a content
  //    scan. We always run as a required status check so the merge gate
  //    reflects "is this PR ready to auto-merge?" — pass on routes that
  //    should auto-merge, fail on routes that need a human.
  const route = (process.env.ROUTE || "").trim();
  if (route === "deletion") {
    // Takedown PR — no content, nothing for the agent to review. Free pass.
    result.success = true;
    result.decision = "approve";
    result.labels = ["agent-approved"];
    result.comment =
      "### Agent content review — skipped (deletion PR)\n\n" +
      "This PR removes a plugin in its entirety. There's no content to scan, " +
      "so the agent reviewer is short-circuited to approve.";
    writeResultAndExit(0);
    return;
  }
  if (route === "infra-only") {
    // Maintainer-edited config / workflow / docs PR. The agent has no
    // plugin content to scan, but we deliberately short-circuit-FAIL
    // (uncertain) rather than approve — the failing status check is what
    // protects these paths from rogue installation tokens. A repo admin
    // (the maintainer) merges via the "Merge without waiting for
    // requirements" bypass button; an App with contents+pull-requests
    // write but no admin role can't bypass and can't fake the check
    // (no checks:write), so it can't ship infra changes.
    result.success = true;
    result.decision = "uncertain";
    result.labels = ["agent-uncertain"];
    result.comment =
      "### Agent content review — skipped (infra-only PR)\n\n" +
      "This PR only modifies repository infrastructure (config, workflows, " +
      "docs, or moderation files). The agent reviewer scans plugin content " +
      "and has nothing to do here. The agent-review check is intentionally " +
      "left red so a repo admin must explicitly bypass it to merge — that " +
      "bypass click is the human gate for infra changes.";
    writeResultAndExit(0);
    return;
  }
  if (route !== "ready-for-agent-review") {
    // Anything else (manual-review, validation-failed, missing) — block the
    // merge gate. The PR may still merge once a human approves it through
    // a different path, but the agent-review status check stays red so
    // auto-merge can't fire on its own.
    result.success = true;
    result.decision = "uncertain";
    result.labels = ["agent-uncertain"];
    result.comment =
      `### Agent content review — skipped (route=${route || "unknown"})\n\n` +
      "This PR was routed away from the agent reviewer by validate.mjs " +
      "(typically because it contains actions, isn't dashboard-submitted, " +
      "or failed structural validation). The agent-review check stays " +
      "unsatisfied so auto-merge waits for manual handling.";
    writeResultAndExit(0);
    return;
  }

  // 1. Prefer the plugin root that validate.mjs identified — that's the
  //    authoritative answer about which plugin the PR modifies. The sparse
  //    checkout also contains every other plugin on main, so a filesystem
  //    walk can pick the wrong dir (e.g. a listing plugin with no content,
  //    which then reviews as "0 files → auto-approved" regardless of the
  //    real submission). Fall back to findPluginDir only if PLUGIN_ROOT
  //    isn't set (older workflow versions).
  let pluginDir;
  if (process.env.PLUGIN_ROOT) {
    pluginDir = path.join(env.PR_DIR, process.env.PLUGIN_ROOT);
    if (!fs.existsSync(pluginDir)) {
      addError(`PLUGIN_ROOT=${process.env.PLUGIN_ROOT} does not exist in PR_DIR.`);
      finishSoftFail("The plugin directory passed in from validate was not found on disk.");
      return;
    }
  } else {
    pluginDir = findPluginDir();
    if (!pluginDir) {
      addError("Could not locate plugin directory in PR_DIR. validate.yml should have caught this.");
      finishSoftFail("The plugin directory was not found during agent review setup.");
      return;
    }
  }
  const pluginRelPath = path.relative(env.PR_DIR, pluginDir).replace(/\\/g, "/");
  console.log(`Reviewing: ${pluginRelPath}`);

  // 2. Read manifest.json
  const manifestPath = path.join(pluginDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    addError("manifest.json not found in plugin directory.");
    finishSoftFail("The plugin's manifest.json was missing during agent review.");
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    addError(`manifest.json parse error: ${e.message}`);
    finishSoftFail("The plugin's manifest.json could not be parsed during agent review.");
    return;
  }

  const nsfwMode = manifest.nsfw === true ? "nsfw" : "sfw";

  // 3. Build the system prompt by concatenating the base prompt and the
  //    mode-specific appendix. Both files come from BASE_DIR (trusted).
  const basePromptPath = path.join(env.BASE_DIR, ".github", "agent-review-prompt.md");
  const appendixPath = path.join(
    env.BASE_DIR,
    ".github",
    nsfwMode === "nsfw" ? "agent-review-appendix-nsfw.md" : "agent-review-appendix-sfw.md",
  );

  if (!fs.existsSync(basePromptPath)) {
    addError(`Base prompt file missing: ${basePromptPath}`);
    finishSoftFail("The agent review base prompt file was missing.");
    return;
  }
  if (!fs.existsSync(appendixPath)) {
    addError(`Appendix file missing: ${appendixPath}`);
    finishSoftFail("The agent review appendix file was missing.");
    return;
  }

  const basePrompt = fs.readFileSync(basePromptPath, "utf8");
  const appendix = fs.readFileSync(appendixPath, "utf8");
  const systemPrompt = `${basePrompt}\n\n${appendix}`;

  console.log(`Mode: ${nsfwMode.toUpperCase()} — prompt total ${systemPrompt.length} chars`);

  // 4. Walk content files and build per-file blobs
  const fileBlobs = buildFileBlobs(pluginDir, pluginRelPath, manifest);
  console.log(`Content blobs: ${fileBlobs.length}`);

  // If a plugin somehow has actions at this stage (shouldn't — validate.yml
  // routes action plugins to manual-review), fail soft.
  if (fileBlobs.some((b) => b.subdir === "actions")) {
    addError("Plugin contains action files but reached agent review. validate.yml should have routed it to manual-review.");
    finishSoftFail("This plugin contains actions and should not have been sent to the agent. Routing to manual review.");
    return;
  }

  // 5. Group file blobs into chunks
  const chunks = chunkBlobs(fileBlobs, CHUNK_SIZE_BYTES);
  console.log(`Chunks: ${chunks.length}`);
  result.chunk_count = chunks.length;

  // 6. For each chunk, call the model and collect the decision
  const chunkResults = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`\n--- Chunk ${i + 1}/${chunks.length} (${chunk.length} chars) ---`);

    // First chunk includes the manifest.json as extra context so the agent
    // can correlate "plugin claims NSFW=X" with the content. Subsequent
    // chunks just have the content blobs.
    const userContent = i === 0
      ? `=== FILE: ${pluginRelPath}/manifest.json ===\n${JSON.stringify(manifest, null, 2)}\n\n${chunk}`
      : chunk;

    let chunkResult;
    try {
      chunkResult = await callModel(systemPrompt, userContent);
    } catch (e) {
      const msg = e.message ?? String(e);
      addError(`Chunk ${i + 1} API call failed: ${msg}`);
      finishSoftFail(
        `The agent review failed on chunk ${i + 1} of ${chunks.length}: ${msg}`,
      );
      return;
    }

    console.log(`Chunk ${i + 1} decision: ${chunkResult.decision}`);
    chunkResults.push(chunkResult);
    result.chunk_results.push(chunkResult);

    // Early exit if a chunk rejects or is uncertain — no point calling the
    // API more times once we know the final decision.
    if (chunkResult.decision === "reject" || chunkResult.decision === "uncertain") {
      console.log(`Early exit: ${chunkResult.decision} from chunk ${i + 1}`);
      break;
    }
  }

  // 7. Aggregate
  const final = aggregate(chunkResults);
  result.decision = final.decision;
  result.labels = [`agent-${final.decision === "approve" ? "approved" : final.decision === "reject" ? "rejected" : "uncertain"}`];

  // 8. Build the PR comment
  result.comment = buildComment(final, chunkResults, nsfwMode);

  result.success = true;
  writeResultAndExit(0);
}

// ----- File walking and blob building -------------------------------------

function findPluginDir() {
  const pluginsRoot = path.join(env.PR_DIR, "plugins");
  if (!fs.existsSync(pluginsRoot)) return null;

  // Walk plugins/{id}/{slug}/. There should be exactly one per validate.yml.
  for (const idDir of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!idDir.isDirectory()) continue;
    const idPath = path.join(pluginsRoot, idDir.name);
    for (const slugDir of fs.readdirSync(idPath, { withFileTypes: true })) {
      if (!slugDir.isDirectory()) continue;
      return path.join(idPath, slugDir.name);
    }
  }
  return null;
}

function buildFileBlobs(pluginDir, pluginRelPath, manifest) {
  // Collect every content file with its relative path and contents
  const blobs = [];

  for (const subdir of CONTENT_DIRS) {
    const dirPath = path.join(pluginDir, subdir);
    if (!fs.existsSync(dirPath)) continue;

    const files = walkTree(dirPath);
    for (const abs of files) {
      const rel = path.relative(env.PR_DIR, abs).replace(/\\/g, "/");
      let content;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch (e) {
        addError(`Could not read ${rel}: ${e.message}`);
        continue;
      }
      const blob = `=== FILE: ${rel} ===\n${content}`;
      blobs.push({ rel, subdir, content, blob });
    }
  }

  return blobs;
}

function walkTree(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

// ----- Chunking -----------------------------------------------------------

function chunkBlobs(fileBlobs, chunkSize) {
  // Group file blobs at file boundaries. Each chunk is ≤ chunkSize bytes
  // except when a single file is larger — then it gets its own chunk regardless.
  const chunks = [];
  let current = [];
  let currentSize = 0;

  for (const b of fileBlobs) {
    const blobSize = b.blob.length;
    if (currentSize + blobSize > chunkSize && current.length > 0) {
      chunks.push(current.map((x) => x.blob).join("\n\n"));
      current = [];
      currentSize = 0;
    }
    current.push(b);
    currentSize += blobSize;
  }

  if (current.length > 0) {
    chunks.push(current.map((x) => x.blob).join("\n\n"));
  }

  return chunks;
}

// ----- Model call ---------------------------------------------------------

async function callModel(systemPrompt, userContent) {
  const body = {
    model: env.MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS_PER_CALL,
    response_format: { type: "json_object" },
  };

  let response;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        throw new Error(`API call timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw new Error(`Network error: ${e.message}`);
    }
    clearTimeout(timer);

    if (response.status === 429) {
      if (attempt < RATE_LIMIT_RETRIES) {
        const delay = RATE_LIMIT_BASE_DELAY_MS * (attempt + 1);
        console.log(`Rate limited (429), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(
        `GitHub Models rate limit hit (429) after ${RATE_LIMIT_RETRIES} retries. Escalating to manual review.`,
      );
    }
    break;
  }

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch { /* ignore */ }
    if (
      response.status >= 400 &&
      response.status < 500 &&
      /content_filter|content_policy|input_policy/i.test(errorBody)
    ) {
      return {
        decision: "reject",
        reason:
          "The model provider refused to process this content, typically indicating content that violates provider safety policies (CSAM detection, etc.).",
        flags: ["illegal"],
      };
    }
    throw new Error(`API returned ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error(`Failed to parse API response as JSON: ${e.message}`);
  }

  const rawContent = data?.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error(`API response missing message.content: ${JSON.stringify(data).slice(0, 500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (e) {
    throw new Error(
      `Model did not return valid JSON. Raw response: ${rawContent.slice(0, 300)}`,
    );
  }

  // Validate the response shape
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Model response is not an object: ${rawContent.slice(0, 300)}`);
  }
  if (!["approve", "reject", "uncertain"].includes(parsed.decision)) {
    throw new Error(
      `Model response has invalid decision '${parsed.decision}': ${rawContent.slice(0, 300)}`,
    );
  }
  if (typeof parsed.reason !== "string") {
    parsed.reason = "(no reason provided)";
  }
  if (!Array.isArray(parsed.flags)) {
    parsed.flags = [];
  }

  return parsed;
}

// ----- Aggregation --------------------------------------------------------

function aggregate(chunkResults) {
  if (chunkResults.length === 0) {
    // Empty chunk list means no content files. Unusual but not wrong —
    // a plugin can be manifest-only. Approve it (there's nothing to reject).
    return { decision: "approve", reason: "No content files to review.", flags: [] };
  }

  // Any rejection → overall reject (surface the first rejection's details)
  const rejected = chunkResults.find((r) => r.decision === "reject");
  if (rejected) {
    return rejected;
  }

  // Any uncertain → escalate (surface the first uncertain's details)
  const uncertain = chunkResults.find((r) => r.decision === "uncertain");
  if (uncertain) {
    return uncertain;
  }

  // All approved
  return {
    decision: "approve",
    reason: `All ${chunkResults.length} chunk${chunkResults.length === 1 ? "" : "s"} approved.`,
    flags: [],
  };
}

// ----- PR comment ---------------------------------------------------------

function buildComment(final, chunkResults, nsfwMode) {
  const modeLabel = nsfwMode.toUpperCase();
  const total = chunkResults.length;
  const approveCount = chunkResults.filter((r) => r.decision === "approve").length;

  const header = `### Agent content review — ${decisionHeader(final.decision)}`;
  const mode = `**Review mode:** ${modeLabel}`;
  const chunks = `**Chunks reviewed:** ${total} (${approveCount} approved)`;
  const flagsLine = final.flags.length > 0
    ? `**Flags:** ${final.flags.map((f) => `\`${f}\``).join(", ")}`
    : null;
  const reasonLine = `**Reason:** ${final.reason}`;

  const parts = [header, "", mode, chunks];
  if (flagsLine) parts.push(flagsLine);
  parts.push(reasonLine);

  if (final.decision === "reject") {
    parts.push("");
    parts.push(
      "This PR will be closed automatically. To resubmit, adjust the " +
      "flagged content in SkyrimNet (or flip the appropriate manifest flag, " +
      "e.g. `nsfw: true`) and publish again from the dashboard — that opens " +
      "a fresh review. Replies on this PR are not monitored.",
    );
  } else if (final.decision === "uncertain") {
    parts.push("");
    parts.push("This PR has been escalated to manual review. A human reviewer will look at it.");
  } else {
    parts.push("");
    parts.push("This PR is eligible for auto-merge pending any other required checks.");
  }

  return parts.join("\n");
}

function decisionHeader(decision) {
  switch (decision) {
    case "approve":   return "approved";
    case "reject":    return "rejected";
    case "uncertain": return "escalated to manual review";
    default:          return decision;
  }
}
