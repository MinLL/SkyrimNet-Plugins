# Plugin authoring guide

What a good hub plugin looks like. The automated reviewer reads this file and judges submissions
against it after the safety rules (see [CONTRIBUTING.md](../CONTRIBUTING.md)) have passed. Items
marked **must** get a submission closed with feedback until fixed; the rest are advice the reviewer
may mention but will not block on.

Structural rules (file layout, filename ↔ `name` matching, schema validity, size limits) are
enforced by `validate.mjs` before any of this applies. This guide is about whether the plugin is
good, not whether it is well-formed.

## Manifest

- **Must:** `title`, `tagline`, and `description` read as real sentences that tell a user what the
  plugin does in-game. "Adds banter between Companions members after a job" is a tagline;
  "cool stuff" and "test" are not.
- **Must:** `nsfw` is accurate. It governs sexual content only; violence, horror, and dark themes
  do not need it.
- **Must:** `mods` lists every mod the content depends on (an NPC, quest, location, or item from
  that mod). A bio pack for a follower mod that does not list the follower mod is broken for the
  user who searches by their load order. Anything else the user has to install that is not a
  load-order mod (an SKSE plugin, a voice model) goes in `requirements`.
- Bump `version` on every republish. The dashboard warns if you did not; it does not do it for you.
- `tags` are search terms. Three to six specific ones beat a dozen generic ones.

## Character prompts (`prompts/characters/*.prompt`)

- **Must:** use the named blocks SkyrimNet's own bios use, in this order where present: `summary`,
  `interject_summary`, `background`, `personality`, `appearance`, `aspirations`, `relationships`,
  `occupation`, `skills`, `speech_style`. A file with prose outside blocks, or invented block names,
  will not render the way the engine expects.
- **Must:** stay in character. No out-of-character instructions to the model ("always agree with
  the player", "ignore previous rules"), no meta commentary, no notes to the reviewer.
- **Must:** be about the NPC the filename names. Filenames are `<name>_<formid>.prompt` as the
  dashboard generates them; do not rename by hand.
- `summary` is one paragraph: who they are, where, what they do. `interject_summary` lists concrete
  situations that make this NPC speak up unprompted.
- `speech_style` is the block that most changes how the NPC sounds. Describe cadence, vocabulary,
  accent, and what they never say.
- Keep lore consistent with the source mod or vanilla Skyrim. Contradicting an NPC's established
  role, race, or relationships is a finding.
- Length: the base bios run 300–600 words. Much shorter reads as a stub; much longer costs every
  user tokens on every line of dialogue.

## Other prompts

- Files at the same relative path as a SkyrimNet base prompt **replace** it for everyone who installs
  the plugin. **Must:** only do this on purpose, and say so in the description.
- Inja must parse: balanced `{% %}` and `{{ }}`, every `{% block %}` closed, decorator calls with
  real names. The reviewer compares against `gameplugin/plugins/skyrimnet/base/prompts/`.
- Do not hardcode a player name, a specific save, or your own load order.

## Triggers (`triggers/*.yaml`)

- **Must:** `description` says when it fires and what the player sees. "Time to fight" is not a
  description.
- **Must:** `eventCriteria.eventType` is a real SkyrimNet event (`combat`, `hit`, `death`,
  `location_change`, `quest_stage`, `book_read`, `sleep_stop`, ...) and
  `eventCriteria.schemaConditions` reference fields that event actually carries.
- **Must:** a trigger on a high-frequency event (`hit`, `active_effect`, `location_change`,
  `animation_event`, `*`) has a `cooldownSeconds` or a `probability` well under 1.0. A response on
  every hit is spam in the user's game.
- **Must:** `diary_entry` and `dynamic_bio_update` responses set `targetScope`.
- `audience` matches the response: a `player_thought` for `nearby_npcs` makes no sense.
- `content` is an Inja template. Use the variables the schema lists (`{{ player_name }}`,
  `{{ event_json.FIELD }}`, `{{ location }}`, ...); a placeholder the engine does not know renders
  as empty text.
- Name triggers for what they do (`companions_job_banter`), not what they are (`trigger1`).

## Knowledge packs (`knowledge/*.sknpack`)

- **Must:** each entry's `content` is in-world text an NPC could plausibly know, written as
  knowledge, not as instructions to the model.
- **Must:** `condition_expr` narrows the entry to the NPCs it applies to. An unconditioned entry is
  injected into every prompt for every NPC.
- Keep entries short and specific. One fact per entry beats a paragraph of lore per entry.

## Things that are always fine

Dark themes, violence, gore, crude language, in-universe prejudice between Skyrim's races, morally
uncomfortable characters, niche content, and plugins the reviewer would not personally install. The
reviewer judges whether the plugin does what it says and follows the conventions above, not taste.
