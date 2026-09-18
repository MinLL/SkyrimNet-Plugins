# SkyrimNet Plugins

Community marketplace for SkyrimNet plugins.

A **plugin** is a bundle containing any combination of:

- **Prompts** (`.prompt`) — text files that shape how NPCs perceive the world or behave in specific situations
- **Triggers** (`.yaml`) — YAML rules that react to game events (spell casts, combat, mod events, etc.) and generate dialogue, narration, diary entries, or bio updates
- **Actions** (`.yaml`) — YAML definitions that let NPCs execute Papyrus mod functions in response to dialogue
- **Knowledge packs** (`.sknpack`) — collections of world knowledge entries that NPCs recall when a condition matches (a rumour, a piece of lore, a fact about your mod)
- **Virtual entities** (`.entity.yaml`) — bodiless NPCs (a spirit, a voice in the player's head, a radio host) with a name, a voice and a conversation mode, paired with a character prompt for their bio

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
```

Each plugin lives in its own directory under the author's GitHub username. The `manifest.json` describes the plugin and is required; the five content subdirectories are all optional.

### Official content (`plugins/skyrimnet/`)

The author segment `skyrimnet` (and the `skyrimnet-` prefix) is reserved for SkyrimNet's own content — today the per-mod character bio packs, `skyrimnet.bios-{mod}`, one per source ESP. These are ordinary hub plugins (install, disable, update like any other); only the way they reach the repo differs:

- **New official packs are pushed to `main` by maintainers**, never submitted through a PR. The validator refuses any PR that would create a new reserved-author plugin.
- **Updates to an existing official pack may be PRs** — fixing a bio in `plugins/skyrimnet/bios-3dnpc/` is welcome. Such PRs pass the normal structural checks but are always routed to a maintainer for review, never auto-merged.

## Review process

Submissions go through one of two flows depending on what they contain:

- **Trigger, prompt, knowledge or virtual-entity content only** — reviewed automatically by SkyrimNet's reviewer (a Claude agent run from the maintainer's private automation repo, never from this repo's own Actions). It checks for spam, forbidden content, obfuscation, accuracy of the NSFW flag, and then the authoring guide in [docs/AUTHORING.md](docs/AUTHORING.md). Approved submissions auto-merge; a submission that needs changes is closed with feedback so you can republish from the dashboard.
- **Any actions included** — reviewed manually by a SkyrimNet developer or trusted community member. Manual review can take up to a week. This is not a trust issue — Papyrus has no access control, and verifying an action is safe against save corruption requires human judgment.

## NSFW content

NSFW plugins are allowed and live in a gated section of the dashboard (off by default). Every manifest must declare `"nsfw": true|false` accurately — mismatches are an automatic reject reason.

## License

Every plugin here is published under the [SkyrimNet Plugin License](LICENSE.md). Authors keep their copyright. The hub and SkyrimNet may distribute plugins with credit. Users may install, use, and modify them for their own game, but not share them. Fixed or extended versions may be published back to the hub, credited to the original author. Plugins are for SkyrimNet only. LICENSE.md opens with the plain-English summary the dashboard shows before you publish, followed by the license itself.
