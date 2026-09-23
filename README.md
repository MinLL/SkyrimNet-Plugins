# SkyrimNet Plugins

Community marketplace for SkyrimNet plugins.

A **plugin** is a bundle containing any combination of:

- **Prompts** (`.prompt`) — text files that shape how NPCs perceive the world or behave in specific situations
- **Triggers** (`.yaml`) — YAML rules that react to game events (spell casts, combat, mod events, etc.) and generate dialogue, narration, diary entries, or bio updates
- **Actions** (`.yaml`) — YAML definitions that let NPCs execute Papyrus mod functions in response to dialogue
- **Knowledge packs** (`.sknpack`) — collections of world knowledge entries that NPCs recall when a condition matches (a rumour, a piece of lore, a fact about your mod)
- **Virtual entities** (`.entity.yaml`) — bodiless NPCs (a spirit, a voice in the player's head, a radio host) with a name, a voice and a conversation mode, paired with a character prompt for their bio
- **Config-system records** (`.yaml`, one record per file) — voice effect recipes, item and spell customizations, furniture names, identity links, actor/memory filter lists and text-filter rules, translator speech rules, and dialogue-action lists and instructions. See [Content roots](#content-roots) for the release each needs.

Plugins often work together as a bundle (e.g. an action paired with a trigger that invokes it and a prompt that teaches NPCs when to use it), but any subset is valid — a pure prompt pack, a trigger-only submission or a lone knowledge pack is perfectly fine.

## Browsing and installing

Use the **Plugins** page in your in-game SkyrimNet dashboard to browse and install from this repo. No GitHub account required for browsing.

### Download counts and endorsements

This repo is static — nothing here sees an install. Popularity comes from [fateless.ai](https://fateless.ai), SkyrimNet's companion service: every install, update and rollback the in-game installer performs starts by asking fateless.ai's anonymous download resolver (`POST https://fateless.ai/v1/hub/download`) for the plugin's commit and file list, and that call is what counts a download — no account, no identifier, and the files themselves still come straight from this repo on GitHub. A listing has no files, so its download is a click-out: the dashboard's external-link button resolves through the same call and the count is how often the link was opened. Signed-in fateless users can **endorse** a plugin — one vote per account, toggleable. Downloads never need an account; endorsing does.

Those figures reach the browse page through `index.json`: `build-index.yml` runs hourly, fetches fateless.ai's public stats document (`GET https://fateless.ai/v1/hub/stats`) and bakes each plugin's `stats: { downloads, endorsements }` into its entry. Browsing therefore never calls fateless.ai. The bake is fail-soft — if the document is unreachable the previous figures are carried forward and `stats_as_of` says how old they are — and a rebuild that would only move timestamps commits nothing. Your own endorsement shows in the dashboard immediately; everyone else sees it after the next bake.

## Publishing a plugin

The easiest way to publish is from the dashboard's **Publish** page. It handles everything — authenticating with GitHub via Device Flow, forking this repo, writing files to the correct location, and opening a pull request — so you never need to touch git.

## Repository structure

```
plugins/
  {github-user}/
    {plugin-slug}/
      manifest.json           # required metadata
      triggers/*.yaml         # optional
      actions/*.yaml          # optional
      prompts/*.prompt        # optional
      knowledge/*.sknpack     # optional
      entities/*.entity.yaml  # optional
      voice_effects/*.yaml    # optional, one record per file (see Content roots)
      items/*.yaml
      spells/*.yaml
      furniture/*.yaml
      identity/*.yaml
      filters/*.yaml
      translator/*.yaml
      dialogue_actions/*.yaml
```

Each plugin lives in its own directory under the author's GitHub username. The `manifest.json` describes the plugin and is required; every content subdirectory is optional.

### Content roots

One directory per content root. The validator checks each file's extension, its identity (the field whose value must equal the filename stem, so the path is the record's one identity) and, for a hub-gated root, the release: a plugin may ship a root only when its manifest's `min_skyrimnet_version` is at least the SkyrimNet release that reads the root, because an older SkyrimNet refuses the whole install on a root it does not know. Beta 25 (0.25.0) reads every root below; the eight config-system roots are hub-gated at it. A root added ahead of the release that reads it is marked reserved in the hub's `ROOT_TABLE` and refused until that row is set to the release.

| Root | Extension | Identity (`== filename stem`) | Release | Hub-gated | Per-file cap |
|---|---|---|---|---|---|
| `prompts/` | `.prompt` | the path | Beta 25 (0.25.0) | no | — |
| `triggers/` | `.yaml` | `name` | Beta 25 (0.25.0) | no | 32 KB |
| `actions/` | `.yaml` | `name` | Beta 25 (0.25.0) | no | 32 KB |
| `knowledge/` | `.sknpack` | the path (entries by `key`) | Beta 25 (0.25.0) | no | 1 MB |
| `entities/` | `.entity.yaml` | the path (records by `entityName`) | Beta 25 (0.25.0) | no | 32 KB |
| `voice_effects/` | `.yaml` | `id` | Beta 25 (0.25.0) | yes | 64 KB |
| `items/` | `.yaml` | form stem of `form` (`Plugin.esp\|0x01396B`); `npc_usable`, never `enabled` | Beta 25 (0.25.0) | yes | 32 KB |
| `spells/` | `.yaml` | form stem of `form`; `npc_usable`, never `enabled` | Beta 25 (0.25.0) | yes | 32 KB |
| `furniture/` | `.yaml` | form stem of `form` | Beta 25 (0.25.0) | yes | 32 KB |
| `identity/` | `.yaml` | slug of `name` (`kind: link`, the default, or `succession`); NPCs as `npc:Plugin.esp:0xLocalID` | Beta 25 (0.25.0) | yes | 32 KB |
| `filters/` | `.yaml` | `kind: actor` / `memory` contributions: any stem; `kind: dialogue_rule` / `tts_rule`: `id`, integer `priority` | Beta 25 (0.25.0) | yes | 32 KB |
| `translator/` | `.yaml` | `kind: npc`: form stem of `form` (the actor base); `faction` / `race`: `entityEditorId`; `global`: `global.yaml`; integer `priority` | Beta 25 (0.25.0) | yes | 32 KB |
| `dialogue_actions/` | `.yaml` | `kind: lists` contributions: any stem; `kind: instruction`: `key`, with `category` one of `quest`, `follower`, `merchant`, `trainer`, `carriage`, `innkeeper`, `bard`, `marriage`, `crime`, `other` | Beta 25 (0.25.0) | yes | 32 KB |

**Filename stem.** For a root identified by `name`, `id`, `key` or `entityEditorId`, the stem is the filename up to its **first** dot (`draugr.yaml` → `draugr`, `foo.entity.yaml` → `foo`), compared case-insensitively.

**Form stem.** A form-keyed record's filename is derived from its `form: "Plugin.esp|0x01396B"` (the defining plugin's full filename, `|`, the plugin-relative id) and compares exactly. The plugin filename is split at its **last** dot. The stem is the name, ASCII-lowercased with every byte outside `a-z0-9_` replaced by `_` and cut at 40 UTF-8 bytes; then `-esm` or `-esl` for those extensions; then, when any of these hold — a byte was replaced, the name was cut, the name is empty, or the extension is not `.esp`/`.esm`/`.esl` — `-` and the FNV-1a 32-bit hash (8 lowercase hex digits) of the folded **full** filename, extension included; then `_` and the local id as six upper-case hex digits. `Skyrim.esm|0x01396B` → `skyrim-esm_01396B`; `Mod A.esp|0x000123` → `mod_a-a44f2ca6_000123`. The dashboard names these files; `formStem()` in `.github/scripts/lib/form-ref.mjs` is the rule, pinned by `tests/fixtures/form-ref-cases.json` on both sides. An `.esl` file's local id is 12 bits (at most `0xFFF`) and a wider one is refused; an ESL-flagged `.esp` cannot be told from its name, so the validator does not check its width — write its 12-bit id as the dashboard does.

### Official content (`plugins/skyrimnet/`)

The author segment `skyrimnet` (and the `skyrimnet-` prefix) is reserved for SkyrimNet's own content — today the per-mod character bio packs, `skyrimnet.bios-{mod}`, one per source ESP. These are ordinary hub plugins (install, disable, update like any other); only the way they reach the repo differs:

- **New official packs are pushed to `main` by maintainers**, never submitted through a PR. The validator refuses any PR that would create a new reserved-author plugin.
- **Updates to an existing official pack may be PRs** — fixing a bio in `plugins/skyrimnet/bios-3dnpc/` is welcome. Such PRs pass the normal structural checks but are always routed to a maintainer for review, never auto-merged.

## Review process

Submissions go through one of two flows depending on what they contain:

- **Anything without actions** — reviewed automatically by SkyrimNet's reviewer (a Claude agent run from the maintainer's private automation repo, never from this repo's own Actions). It checks for spam, forbidden content, obfuscation, accuracy of the NSFW flag, and then the authoring guide in [docs/AUTHORING.md](docs/AUTHORING.md). Approved submissions auto-merge; a submission that needs changes is closed with feedback so you can republish from the dashboard.
- **Any actions included** — reviewed manually by a SkyrimNet developer or trusted community member. Manual review can take up to a week. This is not a trust issue — Papyrus has no access control, and verifying an action is safe against save corruption requires human judgment.

## NSFW content

NSFW plugins are allowed and live in a gated section of the dashboard (off by default). Every manifest must declare `"nsfw": true|false` accurately — mismatches are an automatic reject reason.

## License

Every plugin here is published under the [SkyrimNet Plugin License](LICENSE.md). Authors keep their copyright. The hub and SkyrimNet may distribute plugins with credit. Users may install, use, and modify them for their own game, but not share them. Fixed or extended versions may be published back to the hub, credited to the original author. Plugins are for SkyrimNet only. LICENSE.md opens with the plain-English summary the dashboard shows before you publish, followed by the license itself.
