<adult_content_check mode="off">
The submission declares `nsfw: false`, meaning it claims to contain NO adult sexual content.

**Check**: Apply the following test: **if the LLM uses this content at runtime, could its output plausibly contain sexual content?** If yes, output `reject` with flag `nsfw-flag-understates`.

Prompts shape many different kinds of output — NPC dialogue, narration, diary entries, memory recall, vision descriptions, world lore injection, scene direction, and more. The test is the same regardless of what the prompt drives: evaluate what the LLM-generated text downstream of this content could contain.

This catches:

- Explicit sexual content, sexual acts, erotic roleplay instructions.
- **Content that frames sex as a behavior, solution, recreation, or topic the output can invoke** — e.g. knowledge pack entries listing sex as a coping mechanism or general activity; NPC profiles saying the character uses sex for stress; narration templates that include sexual scenes as a possibility; diary prompts that invite recording sexual encounters.

A single such line is enough; the rest of the prompt being benign does not dilute it.

What does NOT trigger: biographical facts about past relationships, marriages, or children; references to the existence of brothels or similar in-world institutions without positioning them as options for the content to reach for; crude non-sexual language. If you are unsure whether a line crosses, err toward reject — the content is not forbidden, only mislabeled, and the author can simply resubmit with `nsfw: true`.

This is the ONLY check in this appendix. Non-sexual content of any kind — including violence, gore, horror, dark themes, and disturbing subject matter — does not trigger this check and must not be rejected by this rule.
</adult_content_check>
