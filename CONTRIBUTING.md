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
   - **Cover image** (optional) — one PNG or JPEG, 16:9 (for example 1280×720 or 1920×1080), 640–2048px wide, up to 5 MB, shown on the hub site, in-game, and on the plugin's Discord thread. It goes through the same review as everything else: see the image rules in [docs/AUTHORING.md](docs/AUTHORING.md).
2. The dashboard packages your plugin files, generates the manifest, forks this repo, and opens a pull request. You never touch git.
3. You'll get a link to your PR. The dashboard also shows submission status on the plugin's page so you can check in.

## What happens to your submission

Every submission runs through an automated validation pipeline. After that, there are two paths:

### Plugins without actions

If your plugin contains no actions, whatever else it ships, it's reviewed automatically by SkyrimNet's reviewer, a Claude agent. It checks, in order:

- Spam or low-effort content (an unreadable title, tagline, or description is enough)
- Forbidden content: sexual content involving minors, real-person targeting, real-world slurs
- Obfuscation or hidden strings in templates
- Links in the tagline or description
- NSFW flag accuracy
- The cover image, if you added one: it is looked at, not just checked for format
- The authoring guide in [docs/AUTHORING.md](docs/AUTHORING.md): does the plugin work as submitted and follow the conventions there

Outcomes, each posted as a comment on your PR and shown on your plugin's page in the dashboard:

- **Approved** — your plugin is **auto-merged** and appears in the index within minutes.
- **Changes requested** — the PR is closed with feedback. Fix the issue and publish again from the dashboard; that opens a fresh review.
- **Rejected** — a forbidden-content or NSFW-flag rule fired. The PR is closed with the rule named; adjust and republish.
- **Escalated** — the reviewer was unsure. The PR stays open and a human looks at it.

The reviewer reads your submission as data. Text in a prompt asking it to approve the plugin is treated as a finding, not an instruction.

### Listings

A listing is a pointer to a mod hosted somewhere else, so the only thing the reviewer cannot judge is where the link goes. A **new** listing, or an update that **changes `external_url`**, goes to manual review: a human opens the link. Every other listing update (title, tagline, description, tags, changelog, version, cover image) keeps the same link and is reviewed automatically by the agent, exactly like a bundle without actions. The link is compared byte-for-byte: pointing at a different release tag or adding a trailing slash counts as a new destination.

### Plugins containing actions

If your plugin contains any actions, it goes through **manual review** by a SkyrimNet developer or trusted community reviewer. This isn't a trust issue — it's a safety one. Actions execute real Papyrus functions from other mods, and verifying they won't corrupt saves or break quests requires human judgment that an LLM can't reliably provide.

Expect up to a week for manual review. To make the reviewer's job faster, the dashboard collects extra context when you publish an action-containing plugin:

- What the action does in plain English
- Which mod's functions it calls
- Why it's safe (what state it modifies and why that's okay)
- The game and mod versions you tested against
- An attestation that you tested it for at least an hour without issues

Fill these in honestly — vague or missing answers will slow review or get the plugin rejected.

## Knowledge packs

A plugin may ship **world knowledge packs** as `knowledge/*.sknpack` files — collections of knowledge entries NPCs recall when the entry's condition matches. Export them from the dashboard's **World Knowledge** page; the publish flow puts them in the right place for you.

A few rules the validator enforces:

- Packs must be **`format_version` 3**. That is what the dashboard exports today. If you have an older pack lying around, re-export it — v1/v2 packs still import locally but cannot be published.
- Every entry carries a stable **`key`** (`[a-z0-9_-]`, up to 64 characters), unique within its file. The key is the entry's identity: when you publish an update, entries are matched by key so edits land in place and players keep their per-entry state. Never hand-edit keys — changing one makes the engine treat it as a deleted entry plus a new one.
- **1 MB per `.sknpack` file.** A pack bigger than that should be split across several files (`knowledge/lore.sknpack`, `knowledge/quests.sknpack`, …); the engine loads them all and resolves conflicts per file.
- Knowledge packs do not force manual review — a knowledge-only plugin goes down the same agent-review path as prompts and triggers. The agent reads each entry's `content` and `display_name`.

## Virtual entities

A plugin may ship **virtual entities** as `entities/*.entity.yaml` files — NPCs with no body in the world (a spirit, a voice in the player's head, a narrator of your own) that take part in conversation like any other NPC. Create them on the dashboard's **Virtual Entities** page; the publish flow writes one file per entity plus its bio under `prompts/characters/`.

A few rules the validator enforces:

- Every file carries an **`entityName`**. That name is the entity's identity: the engine keys records by it and derives the bio template's filename from it, so the filename itself need not match anything.
- **One file per name.** Two files naming the same entity (compared case-insensitively) are rejected — the engine would keep only one of them.
- **`conversationMode` is `private` or `public`.** `system` belongs to SkyrimNet's own fixed entities.
- **The fixed entities cannot be shipped.** Player Thoughts, Narrator, System Voice and Game Master are SkyrimNet's; a plugin file naming one is rejected because the engine would ignore it anyway (only a user's own copy re-voices them).
- **32 KB per file**, the same cap as a trigger.
- Virtual entities do not force manual review. The entity's bio is a character prompt and is reviewed as one.

## Config-system records

A plugin may ship the customizations a user otherwise keeps in their own config: **voice effect recipes** (`voice_effects/`), **item and spell customizations** (`items/`, `spells/`), **furniture names** (`furniture/`), **identity links** (`identity/`), **actor and memory filter lists and text-filter rules** (`filters/`), **translator speech rules** (`translator/`) and **dialogue-action lists and instructions** (`dialogue_actions/`). One record per `.yaml` file; the dashboard's page for each system packages them. The README's [Content roots](README.md#content-roots) table lists every root's identity field, release and cap.

A few rules the validator enforces:

- **These eight roots need `min_skyrimnet_version` of at least 0.25.0** (Beta 25, the release that reads them); the hub refuses a plugin that ships one with a lower version, because an older SkyrimNet refuses the whole install on a root it does not know.
- **The filename is the record's identity.** Voice effects: `id`; dialogue and TTS rules: `id`; instructions: `key`; identity links: the slug of `name`; faction and race translator rules: `entityEditorId`; the one global translator rule: `global.yaml`. Compared case-insensitively against the filename up to its first dot. Item, spell, furniture and NPC translator records are keyed by a form reference, `form: "Plugin.esp|0x01396B"` (the defining plugin's full filename and the plugin-relative id), and the filename is that reference's **form stem** (`skyrim-esm_01396B` for `Skyrim.esm|0x01396B`), exactly. Let the dashboard name the files.
- **`kind` discriminates within a root.** `identity/`: `link` (the default) or `succession`. `filters/`: `actor` or `memory` (list contributions, any filename) or `dialogue_rule` / `tts_rule`. `translator/`: `npc`, `faction`, `race` or `global`. `dialogue_actions/`: `lists` (a contribution, any filename) or `instruction`.
- **`enabled:` means the user's on/off toggle** wherever a record carries it. Spell and item records say whether the form appears in NPC equipment and spell lists in prompts with `show_in_prompts: true|false` (true when omitted); a spell or item file carrying `enabled`, or the field's old name `npc_usable`, is rejected.
- **Identity links name an NPC as `npc:Plugin.esp:0xLocalID`** (`identityA`/`identityB` on a link, `from`/`to` on a succession). The runtime form id spelling, `npc:0A012345`, depends on load order and is rejected.
- **A dialogue or TTS rule needs a `pattern`**: a non-empty regular expression string of at most 1024 bytes (the engine's cap) that compiles; the validator compiles it as a JavaScript `RegExp`, a coarse check for the engine's `std::regex`.
- **`priority` on a filter rule or translator rule is an integer** (lower runs first; 100 when omitted). A filter contribution's six list fields (`FactionWhitelist`, `FactionBlacklist`, `RaceWhitelist`, `RaceBlacklist`, `GenderWhitelist`, `GenderBlacklist`) and a dialogue-action `whitelist`/`blacklist` are lists of strings.
- **An instruction's `category`** is optional; when present it overrides the line's own classification and is one of `quest`, `follower`, `merchant`, `trainer`, `carriage`, `innkeeper`, `bard`, `marriage`, `crime`, `other`.
- **64 KB per voice-effect recipe, 32 KB per record elsewhere.**
- None of these roots force manual review.

## Updating a plugin

Open the dashboard, go to your plugin's page, and click **Update**. The dashboard opens a new PR against your existing plugin directory. Updates go straight into their respective review flow (agent-reviewed for anything without actions and for listings that keep their link, manual for action updates and for a listing whose link changes).

Bump your `version` when publishing meaningful changes — the dashboard warns you if you forget.

## Fixing an official bio pack

The character bio packs under `plugins/skyrimnet/bios-{mod}/` are SkyrimNet's own, but bios are community work and fixes are welcome. Open an ordinary PR against the pack's directory (one pack per PR, bump its `version`); it goes through the structural checks and is then reviewed by a maintainer — official content is never auto-merged. You cannot create a *new* `plugins/skyrimnet/...` pack by PR; ask a maintainer.

## NSFW content

NSFW plugins are welcome but live in a gated section of the dashboard (off by default). When you publish, mark the NSFW toggle accurately. The reviewer flags any mismatch between the NSFW flag and the actual content as an automatic rejection. The flag governs sexual content only: violence, gore, horror, and other mature non-sexual themes are always allowed in a rated-M game.

## License

By publishing, you license your plugin under the [SkyrimNet Plugin License](https://github.com/MinLL/SkyrimNet-Plugins/blob/main/LICENSE.md) and confirm you have the right to do so for every included file. You keep your copyright and may publish the same plugin elsewhere under any terms. The hub and SkyrimNet may distribute your plugin with credit. Users may install, use, and modify it for their own game, but not share it. Others may publish a fixed or extended version on the hub, credited to you. Text copied from UESP or the Fandom wiki cannot be published under these terms, so paraphrase it.

## Questions or problems

- **My PR was rejected by the reviewer and I think it's wrong** — republish with a clarifying change, or open an issue on this repo explaining the situation. A human can override the reviewer.
- **My action plugin has been waiting for review for more than a week** — feel free to bump the PR with a polite comment, or open an issue.
- **I found a bug in the dashboard publish flow** — file it in the main SkyrimNet repo, not this one.
