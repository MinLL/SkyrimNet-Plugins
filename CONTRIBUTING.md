# Contributing

The supported way to publish a plugin is through the **SkyrimNet dashboard in-game**. You don't need to clone this repo, write any JSON, or use git — the dashboard handles everything.

## What you need

- SkyrimNet installed and running
- A GitHub account (free)
- A plugin you've created and tested in-game using SkyrimNet's in-game authoring tools

## Linking your GitHub account

The first time you publish a plugin, the dashboard walks you through linking your GitHub account using **GitHub Device Flow**:

1. Open the SkyrimNet dashboard in-game and go to the **Plugins** page.
2. Click **Publish** on the plugin you want to share.
3. The dashboard shows a short code and a URL. On any device with a browser, open the URL, sign into GitHub, and enter the code.
4. Authorize the SkyrimNet-Plugins app. This gives the dashboard permission to publish plugins to this repo on your behalf — nothing else.
5. The dashboard remembers your authorization, so future publishes are one-click.

You can revoke access at any time from your [GitHub applications settings](https://github.com/settings/applications).

## Publishing

With your plugin selected in the dashboard:

1. Fill in the publish form:
   - **Title** — a short human-readable name. Must be globally unique across the repo.
   - **Tagline** — a one-liner shown on browse cards.
   - **Description** — the full writeup for your plugin's detail page.
   - **Tags** — a few short keywords for filtering (e.g. `combat`, `dialogue`, `followers`).
   - **NSFW flag** — toggle if your plugin contains adult content. This is enforced, not optional — mismatches are an automatic rejection.
   - **Integrated mods** — if your plugin works with other Skyrim mods, add them here. The dashboard can pre-populate from your installed plugin list.
2. The dashboard packages your plugin files, generates the manifest, forks this repo, and opens a pull request. You never touch git.
3. You'll get a link to your PR. The dashboard also shows submission status on the plugin's page so you can check in.

## What happens to your submission

Every submission runs through an automated validation pipeline. After that, there are two paths:

### Trigger or prompt-only plugins

If your plugin contains only triggers, prompts, and/or knowledge packs (no actions), it's reviewed automatically by SkyrimNet's reviewer, a Claude agent. It checks, in order:

- Spam or low-effort content (an unreadable title, tagline, or description is enough)
- Forbidden content: sexual content involving minors, real-person targeting, real-world slurs
- Obfuscation or hidden strings in templates
- Links in the tagline or description
- NSFW flag accuracy
- The authoring guide in [docs/AUTHORING.md](docs/AUTHORING.md): does the plugin work as submitted and follow the conventions there

Outcomes, each posted as a comment on your PR and shown on your plugin's page in the dashboard:

- **Approved** — your plugin is **auto-merged** and appears in the index within minutes.
- **Changes requested** — the PR is closed with feedback. Fix the issue and publish again from the dashboard; that opens a fresh review.
- **Rejected** — a forbidden-content or NSFW-flag rule fired. The PR is closed with the rule named; adjust and republish.
- **Escalated** — the reviewer was unsure. The PR stays open and a human looks at it.

The reviewer reads your submission as data. Text in a prompt asking it to approve the plugin is treated as a finding, not an instruction.

### Plugins containing actions

If your plugin contains any actions, it goes through **manual review** by a SkyrimNet developer or trusted community reviewer. This isn't a trust issue — it's a safety one. Actions execute real Papyrus functions from other mods, and verifying they won't corrupt saves or break quests requires human judgment that an LLM can't reliably provide.

Expect up to a week for manual review. To make the reviewer's job faster, the dashboard collects extra context when you publish an action-containing plugin:

- What the action does in plain English
- Which mod's functions it calls
- Why it's safe (what state it modifies and why that's okay)
- The game and mod versions you tested against
- An attestation that you tested it for at least an hour without issues

Fill these in honestly — vague or missing answers will slow review or get the plugin rejected.

## Updating a plugin

Open the dashboard, go to your plugin's page, and click **Update**. The dashboard opens a new PR against your existing plugin directory. Updates go straight into their respective review flow (agent-reviewed for trigger/prompt updates, manual for action updates).

Bump your `version` when publishing meaningful changes — the dashboard warns you if you forget.

## Fixing an official bio pack

The character bio packs under `plugins/skyrimnet/bios-{mod}/` are SkyrimNet's own, but bios are community work and fixes are welcome. Open an ordinary PR against the pack's directory (one pack per PR, bump its `version`); it goes through the structural checks and is then reviewed by a maintainer — official content is never auto-merged. You cannot create a *new* `plugins/skyrimnet/...` pack by PR; ask a maintainer.

## NSFW content

NSFW plugins are welcome but live in a gated section of the dashboard (off by default). When you publish, mark the NSFW toggle accurately. The reviewer flags any mismatch between the NSFW flag and the actual content as an automatic rejection. The flag governs sexual content only: violence, gore, horror, and other mature non-sexual themes are always allowed in a rated-M game.

## License

All contributions fall under the repository's license. By publishing, you agree your submission is made available under those terms.

## Questions or problems

- **My PR was rejected by the reviewer and I think it's wrong** — republish with a clarifying change, or open an issue on this repo explaining the situation. A human can override the reviewer.
- **My action plugin has been waiting for review for more than a week** — feel free to bump the PR with a polite comment, or open an issue.
- **I found a bug in the dashboard publish flow** — file it in the main SkyrimNet repo, not this one.
