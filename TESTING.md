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
| `tests/content-rules.test.mjs` | Runs the whole corpus against `.github/scripts/lib/content-rules.mjs`. |
| `tests/validate.test.mjs` | End-to-end runs of `validate.mjs` against synthetic PR checkouts: happy paths, one case per rejection class, PR-shape routing (infra-only, mixed, multi-plugin, manual vs dashboard). |
| `tests/build-index.test.mjs` | End-to-end runs of `build-index.mjs` against throwaway git repos with real multi-commit plugin histories; asserts `history` shape, ordering and cap, and validates every emitted index against `schemas/index.schema.json`. Also checks the committed `index.json` is neither stale nor schema-invalid. |
| `tests/repo-tree.test.mjs` | Replays every plugin currently in `plugins/` through `validate.mjs`. Catches "we tightened a rule and forgot to migrate the entries already in the repo". |
| `tests/helpers/harness.mjs` | Builds synthetic PR checkouts and runs the real scripts the way `review-pipeline.yml` does (trusted `BASE_DIR`, untrusted `PR_DIR`, `status\tfilename` list). |

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

- For `expect: "reject"`, `reason` is the **stable machine code** the first
  failing rule must produce (the `CODES` map in `content-rules.mjs`). Rule
  evaluation order is part of the contract — a port that rejects the same paths
  but reports different codes is not equivalent.
- For `expect: "accept"`, `reason` is free-form prose explaining why the case is
  in the corpus (usually: it is an adversarial near-miss that must NOT be
  rejected, e.g. `prompts/console.prompt` next to the reserved device name
  `CON`, or `bob.skyrimnet-foobar-integration` next to the reserved author
  namespace).
- **Add attacks to the corpus, not to the test file.** A case added here is
  automatically covered on both sides.

## Adding rules

Structural rules that the installer also needs belong in
`.github/scripts/lib/content-rules.mjs`, with a new code in `CODES`, cases in the
corpus, and a message that tells the author what to do. Rules that only make
sense on the hub (PR shape, bans, title uniqueness, review routing) stay in
`validate.mjs`.

## Not covered

- No CI job runs this suite yet; it is a local/pre-commit gate. The review
  pipeline runs `validate.mjs` itself against every PR, so a broken validator
  surfaces there — but broken *rules* would not.
- `agent-review.mjs` (the LLM content scan) has no tests here.
