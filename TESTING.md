# Testing

The CI scripts in `.github/scripts/` decide what content is allowed into the hub
and what the in-game installer is told to download. They have a test suite. Run
it before changing them.

## Running the suite

```bash
# one-time: install the validator's dependencies (ajv, js-yaml)
npm ci --prefix .github/scripts

# run everything
npm test

# run one file
node --test tests/content-rules.test.mjs
```

`npm test` names the test files explicitly rather than passing `tests/` —
directory and glob arguments to `node --test` behave differently across Node
versions, and an invocation that silently runs zero tests is worse than a
verbose one. **Add new test files to the `test` script in `package.json`.**

Requirements: Node >= 20 (the suite uses the built-in `node --test` runner —
there is no test framework dependency) and `git` on PATH.

Some tests are skipped on Windows: they need files whose names contain
backslashes, colons or trailing spaces, or two filenames that differ only in
case. Windows cannot create those, so the end-to-end coverage for those rules
runs on Linux/macOS only — the rules themselves are still covered on every
platform by the corpus test below. The runner prints them as
`﹣ ... # requires a POSIX filesystem`.

## What is where

| File | Covers |
|---|---|
| `tests/fixtures/path-cases.json` | **The shared rejection corpus.** Data, not code — see below. |
| `tests/fixtures/form-ref-cases.json` | **The shared FormRef corpus**: expected stem, key and canonical spelling per form reference, plus the malformed inputs `parseFormRef` refuses. A verbatim copy of SkyrimNet-Core's `tests/test_data/form-ref-cases.json`; the engine's `FormRef` suite runs the same file, and the two are synced by hand. `content-rules.test.mjs` asserts the case counts, so a stale copy fails loudly. |
| `tests/content-rules.test.mjs` | Runs the path corpus against `.github/scripts/lib/content-rules.mjs` and the FormRef corpus against `.github/scripts/lib/form-ref.mjs`, plus the root table (`ROOT_TABLE` and what derives from it), `compareSemver`, the per-root minimum gate and `checkFieldMatchesStem`. |
| `tests/record-rules.test.mjs` | Unit tests for `.github/scripts/lib/record-rules.mjs`: per config-system root, a passing and a failing document for every rule (identity field, `kind`, `show_in_prompts`, dialogue-action categories, the translator `form`, ESL id width, `npc:` references, filter list fields, `priority`, value echoing in messages). |
| `tests/fixtures/records/` | **The shared record corpus**: per config-system root, `valid/`, `base/` (the shipped base content verbatim), `invalid/` (`# refuse: <CODE>`; a second `# engine: loads` line marks a hub-only refusal the engine still loads) and `engine_invalid/` (`# refuse-engine: <reason>`, refusals only the engine makes). A byte-for-byte mirror of SkyrimNet-Core's `tests/test_data/records/` (same git tree id); its `README.md` names the conventions and where the base files came from. |
| `tests/record-corpus.test.mjs` | Runs `checkRecord` over the record corpus: valid and base files accepted, each invalid file refused with exactly its header code, engine_invalid files accepted. |
| `tests/validate.test.mjs` | End-to-end runs of `validate.mjs` against synthetic PR checkouts: happy paths, one case per rejection class, PR-shape routing (infra-only, mixed, multi-plugin, manual vs dashboard), the official-content rule (an existing `plugins/skyrimnet/*` pack accepts an update PR and routes to manual review; a new reserved-author pack is still refused), and every config-system root through the real script (a record that passes its rules, a refused record, the per-root size cap, the reserved-root refusal), and listing routing (a new listing or a changed `external_url` is manual; a same-link update reaches the agent). |
| `tests/build-index.test.mjs` | End-to-end runs of `build-index.mjs` against throwaway git repos with real multi-commit plugin histories; asserts `history` shape, ordering and cap, and validates every emitted index against `schemas/index.schema.json`. Also checks the committed `index.json` is neither stale nor schema-invalid. The popularity `stats` bake runs against a throwaway local HTTP server standing in for fateless.ai (live attach, zeros for unknown ids, clamping, carry-forward on failure, omission with nothing to carry, and the timestamp-only no-op guard). Every run pins `SKYRIMNET_HUB_STATS_URL` — default `none`, which skips the fetch — so the suite never reaches the real fateless.ai. |
| `tests/repo-tree.test.mjs` | Replays every plugin currently in `plugins/` through `validate.mjs`. Catches "we tightened a rule and forgot to migrate the entries already in the repo". |
| `tests/helpers/harness.mjs` | Builds synthetic PR checkouts and runs the real scripts the way skyrimnet-ops' `hub-review.yml` does (trusted `BASE_DIR`, untrusted `PR_DIR`, `status\tfilename` list). |

## The shared rejection corpus

`tests/fixtures/path-cases.json` is the load-bearing artifact here, and it is
deliberately **data in a plain JSON file rather than assertions in a test**.

The same rules are enforced twice, in two languages: by `validate.mjs` when a
plugin is submitted, and by SkyrimNet's C++ installer before any downloaded file
touches disk. The C++ side never trusts CI — a plugin can reach a user's machine
from an older commit, from a fork, or from a repo compromise — so both sides must
reject the same attacks. The corpus is the contract between them: the C++
validator's test suite loads this exact file and asserts the same outcomes.

Structure:

```jsonc
{
  "path_cases":      [{ "path": "...", "expect": "accept" | "reject", "reason": "CODE or note" }],
  "collision_cases": [{ "paths": ["...", "..."], "expect": "...", "reason": "..." }],
  "manifest_cases":  [{ "name": "...", "path_author": "...", "path_slug": "...",
                        "manifest": { ... }, "expect": "...", "reason": "CODE" }],
  "name_stem_cases": [{ "file": "...", "name": "...", "expect": "...", "reason": "CODE" }]
}
```

Rules:

- For `expect: "reject"` in `path_cases` and `name_stem_cases`, `reason` is the
  **stable machine code the FIRST failing rule produces** (the `CODES` map in
  `content-rules.mjs`). Evaluation order is therefore part of the contract — a
  port that rejects the same paths but reports different codes fails the
  corpus. The exact order is specified below.
- `manifest_cases` are **order-independent**: `checkManifestIdentity` collects
  every issue instead of stopping at the first, so an author sees everything
  wrong in one round trip. The assertion is that `reason` appears *among* the
  reported codes. A port may evaluate those checks in any order, but must
  report all of them.
- For `expect: "accept"`, `reason` is free-form prose explaining why the case is
  in the corpus (usually: it is an adversarial near-miss that must NOT be
  rejected, e.g. `prompts/console.prompt` next to the reserved device name
  `CON`, or `bob.skyrimnet-foobar-integration` next to the reserved author
  namespace).
- **Add attacks to the corpus, not to the test file.** A case added here is
  automatically covered on both sides.

### Path rule order (`checkContentPath`)

Evaluated top to bottom; the first match wins and no later rule runs. Ports
must reproduce this order exactly.

**Whole-path checks**

1. `EMPTY_PATH` — the path is empty.
2. `PATH_TOO_LONG` — more than 240 characters.
3. `BACKSLASH` — a `\` anywhere in the path.
4. `CONTROL_CHAR` — any code point `< 0x20` or `== 0x7F` anywhere in the path.

**Per-segment checks**, applied to each `/`-separated segment left to right;
every rule below is evaluated on a segment before moving to the next segment:

5. `EMPTY_SEGMENT` — zero-length segment (leading, trailing or doubled `/`).
6. `DOT_DOT` — segment is exactly `..`.
7. `DOT_SEGMENT` — segment is exactly `.`.
8. `DRIVE_LETTER` — segment contains `:` **and** it is the first segment
   matching `^[A-Za-z]:`.
9. `ADS_COLON` — segment contains `:` in any other position (NTFS alternate
   data stream).
10. `SEGMENT_TOO_LONG` — segment longer than 100 characters.
11. `TRAILING_DOT_OR_SPACE` — segment ends with `.` or a space (Windows strips
    both on create, making `foo.prompt ` an alias for `foo.prompt`).
12. `RESERVED_DEVICE_NAME` — the text before the segment's first `.`,
    uppercased, is one of `CON PRN AUX NUL COM0..COM9 LPT0..LPT9` — the full
    0-9 ranges, per Microsoft's naming guidance. Two-digit names (`COM10`,
    `LPT10`) are *not* reserved and must stay legal. `CONIN$`/`CONOUT$` need
    no entry: `$` is outside the charset, so rule 13 rejects them.
13. `CHARSET` — segment does not match `^[A-Za-z0-9._-]+$`.

**Structure checks**, after all segments pass:

14. `UNKNOWN_ROOT` — first segment is not a `segment` of `ROOT_TABLE` in
    `content-rules.mjs` (`prompts`, `triggers`, `actions`, `knowledge`,
    `entities`, `voice_effects`, `items`, `spells`, `furniture`, `identity`,
    `filters`, `translator`, `dialogue_actions`). The shared corpus carries
    cases only for roots the engine's table in `ContentPaths.cpp` also has;
    cases for the remaining roots live in `content-rules.test.mjs`.
15. `NO_FILE_IN_ROOT` — fewer than two segments (a root with no file in it).
16. `BAD_EXTENSION` — the final segment does not end with the root's extension
    as an **exact, case-sensitive suffix** (`prompts` → `.prompt`, `knowledge`
    → `.sknpack`, `entities` → `.entity.yaml`, every other root → `.yaml`).
17. `EMPTY_STEM` — the final segment is nothing but the extension.
18. `RESERVED_DYNAMIC` — the final segment case-folds to something ending in
    `.dynamic.prompt`, **or** any segment case-folds to `dynamic` while its
    parent segment case-folds to `characters`.

Case folding throughout is ASCII-only (`A-Z` → `a-z`) and never applied to
non-ASCII, which rule 13 has already rejected — Windows' non-ASCII folding is
locale-dependent, so both sides must agree by simply never doing it.

`findPathCollisions` runs separately over the accepted set: two paths whose
ASCII case-folded forms are equal are a `PATH_COLLISION`.

## Adding rules

Structural rules that the installer also needs belong in
`.github/scripts/lib/content-rules.mjs`, with a new code in `CODES`, cases in the
corpus, and a message that tells the author what to do. A new content root is one
`ROOT_TABLE` row there (segment, `contents` category, extension, minimum engine
release: `null`, `"reserved"` or a version); `CONTENT_ROOTS`, `CATEGORY_BY_ROOT`,
`EXTENSION_BY_ROOT`, `ROOT_MIN_ENGINE`, the validator's counts, `build-index.mjs`'s
counts and the root-table test derive from it. A new category also needs its key in
`schemas/index.schema.json`'s `contents`, by hand. Rules about what is inside a record file (which field is the identity, `kind`
values, `npc:` references, `priority`) belong in
`.github/scripts/lib/record-rules.mjs`, keyed by root. Rules that only make sense on
the hub (PR shape, bans, title uniqueness, review routing, size caps) stay in
`validate.mjs`.

## In CI

`.github/workflows/tests.yml` runs `npm test` on pull requests and pushes to
`main` that touch `.github/scripts/**`, `schemas/**`, `tests/**` or
`package.json`. It runs on Linux, so the cases skipped on Windows are exercised
there.

It deliberately does **not** trigger on `plugins/**`: plugin submissions are
already gated by the real validator, which the private `skyrimnet-ops` repo's
`hub-review.yml` runs against every PR from this repo's `main` (this repo has
no workflow on `pull_request` for submissions any more — it is public, and the
reviewer runs on self-hosted runners that must never execute fork-authored
YAML). `index.json` is rebuilt by `build-index.yml` only *after* a plugin
merges — so between merge and rebuild the tree is legitimately ahead of the
index, which `build-index.test.mjs`'s staleness check would otherwise flag.

## Not covered

- The LLM review itself (the `/hub-review` skill and `apply-verdict.sh` in
  `skyrimnet-ops`) has no tests here; the verdict contract is checked there.
