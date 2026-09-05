# SkyrimNet Plugins

Community marketplace for SkyrimNet plugins.

A **plugin** is a bundle containing any combination of:

- **Prompts** (`.prompt`) — text files that shape how NPCs perceive the world or behave in specific situations
- **Triggers** (`.yaml`) — YAML rules that react to game events (spell casts, combat, mod events, etc.) and generate dialogue, narration, diary entries, or bio updates
- **Actions** (`.yaml`) — YAML definitions that let NPCs execute Papyrus mod functions in response to dialogue

Plugins often work together as a bundle (e.g. an action paired with a trigger that invokes it and a prompt that teaches NPCs when to use it), but any subset is valid — a pure prompt pack or a trigger-only submission is perfectly fine.

## Browsing and installing

Use the **Plugins** page in your in-game SkyrimNet dashboard to browse and install from this repo. No GitHub account required for browsing.

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
```

Each plugin lives in its own directory under the author's GitHub username. The `manifest.json` describes the plugin and is required; the three content subdirectories are all optional.

### Official content (`plugins/skyrimnet/`)

The author segment `skyrimnet` (and the `skyrimnet-` prefix) is reserved for SkyrimNet's own content — today the per-mod character bio packs, `skyrimnet.bios-{mod}`, one per source ESP. These are ordinary hub plugins (install, disable, update like any other); only the way they reach the repo differs:

- **New official packs are pushed to `main` by maintainers**, never submitted through a PR. The validator refuses any PR that would create a new reserved-author plugin.
- **Updates to an existing official pack may be PRs** — fixing a bio in `plugins/skyrimnet/bios-3dnpc/` is welcome. Such PRs pass the normal structural checks but are always routed to a maintainer for review, never auto-merged.

## Review process

Submissions go through one of two flows depending on what they contain:

- **Trigger, prompt, or knowledge content only** — reviewed automatically by SkyrimNet's reviewer (a Claude agent run from the maintainer's private automation repo, never from this repo's own Actions). It checks for spam, forbidden content, obfuscation, accuracy of the NSFW flag, and then the authoring guide in [docs/AUTHORING.md](docs/AUTHORING.md). Approved submissions auto-merge; a submission that needs changes is closed with feedback so you can republish from the dashboard.
- **Any actions included** — reviewed manually by a SkyrimNet developer or trusted community member. Manual review can take up to a week. This is not a trust issue — Papyrus has no access control, and verifying an action is safe against save corruption requires human judgment.

## NSFW content

NSFW plugins are allowed and live in a gated section of the dashboard (off by default). Every manifest must declare `"nsfw": true|false` accurately — mismatches are an automatic reject reason.

## License

To be decided.
