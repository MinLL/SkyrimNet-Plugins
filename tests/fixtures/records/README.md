# The record corpus

The record contract for the seven config-system roots, mirrored byte for byte between SkyrimNet-Core
(`tests/test_data/records/`) and SkyrimNet-Plugins (`tests/fixtures/records/`): the two trees must have the
same git tree id (`git rev-parse HEAD:tests/test_data/records` in SkyrimNet-Core, `HEAD:tests/fixtures/records` in SkyrimNet-Plugins).
A rule change updates both copies in one change; a fixture that looks wrong is a cross-repo change, never a
local edit. `ai_docs/TESTING_RECORD_CORPUS.md` in SkyrimNet-Core describes the groups and the tests.

## Groups

- `valid/` — the design's record shapes; each opens with `# why: <what it pins>`.
- `base/` — the shipped base content, verbatim; no header.
- `invalid/` — what the hub refuses in a distributed plugin; each opens with `# refuse: <CODE>` from the
  hub's `record-rules.mjs`. A second line `# engine: loads` marks a file the engine still loads: the hub
  refuses it to catch an authoring mistake, but the engine reads it as written (record activation).
- `engine_invalid/` — what the engine refuses and the hub cannot; each opens with
  `# refuse-engine: <one-line reason>`. The hub accepts these files.

## Where the base copies came from

- `voice_effects/`, `furniture/`, `filters/`: SkyrimNet-GamePlugin `main` at `0895c5fd1ed13e779870e52e4b40cbb6d175a4cf`
  (`plugins/skyrimnet/base/<root>/`).
- `dialogue_actions/skyrimnet_defaults.yaml`: SkyrimNet-GamePlugin PR #622 (`feat/base-dialogue-actions-defaults`)
  at `81b33f0922c9a4ee08b5c560e4132e3d3479b686`.

Compared as git blobs (LF); the working copies carry the checkout's line endings.
