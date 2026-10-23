# cc-model-router: design

A Claude Code mod that ranks each prompt by how hard it is and runs the main chat on Haiku, Sonnet or Opus to match.

## Why

Claude Code runs every prompt on the one model picked with `/model`. Most prompts don't need the biggest model. A quick question that runs on Opus burns usage limit and waits longer than it needs to. The owner hits usage limits in practice.

Success means two things:

- Usage limits last longer.
- Easy prompts get faster replies.

Hard work must still get Opus.

## Goals

- Rank every main-chat prompt as **simple**, **medium** or **hard**, and run it on **Haiku**, **Sonnet** or **Opus**.
- Set effort along with the model: Haiku `low`, Sonnet `medium`, Opus `high`. One exception, decided by the owner: Opus keeps the session's effort if it is higher than `high` (`xhigh`, `max`). Hard work never runs weaker than the owner set it.
- Make the decision cheap. Fast local rules decide first. A Haiku classify call (`$.model.classify`) breaks the tie only when the rules can't decide.
- Stay **sticky**. A conversation keeps its current model until the rules see a clearly new task. Short follow-ups such as "yes do it", "continue" or "ok" never move the model.
- Let the owner see and steer every decision:
  - **Status line** shows the routed model for the current turn, and that it was routed rather than set by hand.
  - **Prefix override.** A prompt that starts with `haiku:`, `sonnet:` or `opus:` forces that model. The mod strips the prefix before the prompt is sent. A forced model also becomes the new sticky model.
  - **On/off toggle.** A slash command turns the router on or off for the session. When it's off, the normal `/model` setting applies untouched.
  - **Decision log.** Each decision goes to a file with the time, the tier, the model, how it was decided (rule, classifier, prefix or sticky), and the rule or reason that fired.

## What counts as hard

These were named by the owner. Each one pushes a prompt to Opus:

- planning or architecture: brainstorms, designs, multi-file plans
- debugging: bugs, failing tests, root-cause hunts
- code changes across many files: features that touch many files
- long pasted context: big logs, docs or code dumps

The exact keywords, length thresholds and medium/simple cut-offs are the builder's call. Medium (Sonnet) covers ordinary single-file code work and moderate questions. Simple (Haiku) covers short questions, lookups, explanations and chat.

## Guards

- **Main chat only.** Subagents keep the model their caller chose. The mod does not hook `agent.spawn`. The `turn.step` hook passes through untouched when `e.agentId` is set.
- **Haiku answers. It doesn't edit.** If a Haiku-routed turn tries to edit files (Edit, Write, NotebookEdit, or a Bash call that writes), that work moves to Sonnet. The builder picks the mechanism. Preferred: re-send the step on Sonnet, then keep the rest of the turn and the sticky model on Sonnet. A fallback is to deny the tool call with a reason and switch the following steps to Sonnet.
- **Cache awareness.** Switching models throws away the warm prompt cache. Stickiness is the main protection. The builder may also refuse a downgrade while the cache is warm and the context is large.
- **Context window guard** *(builder's call)*. Never switch to a model whose context window is smaller than the current context. If the session runs a long-context variant (for example `opus[1m]`), a routed model of the same family keeps that variant.
- **Mid-turn prompts** *(builder's call)*. A prompt typed while a turn is running never re-ranks that turn. Each decision is keyed to the turn it starts. Prompts the owner did not type (`isMeta`, background-task notifications, `/loop` and cron wake-ups, peer messages, prompts from other mods) are not ranked. They stay on the sticky model.
- **Built-in commands** *(builder's call)*. Built-ins that call the model, such as `/compact`, pass through on the sticky model and are never ranked.
- **Failure is safe.** If the rules throw, the classifier call fails or times out, or the log write fails, the prompt goes through on the current sticky model, or on the session's `/model` if there is none. A broken router never blocks a prompt.

## How it works (decided parts)

Built on the mod API in this Claude Code build (2.1.302):

- `prompt.submit`: read the text, strip and apply any prefix, decide the tier (prefix, then sticky check, then rules, then the classifier if the rules can't decide), and store the decision for the coming turn.
- `turn.step` (main loop only): swap in the routed `model` and `effort` with `next({ ...e, model, effort })`. The session's `/model` setting is never changed.
- `$.model.classify(text, ['simple','medium','hard'], { model: 'haiku' })` is the tie-breaker.
- `$.ui.status(...)` shows the routed model.
- `$.command.register` plus a `command.run` hook handle the on/off toggle.
- `$.fs` writes the decision log.
- `$.state` holds the per-session values, such as the sticky model, whether the router is on, and the last decision. They must survive a mod reload, because a reload resets module variables.

## Where it lives

- Repo: `/Users/ravi/claude-misc/claude-mods` (the owner's `ravi-mods` marketplace, next to `session-info` and `yt-music`).
- Folder: `cc-model-router/`, laid out like `session-info`: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `types/index.d.ts`, `tsconfig.json`.
- Add it to `.claude-plugin/marketplace.json` and the README table and install list.

## Change to session-info (decided by the owner)

session-info's line under the prompt currently shows `$.session.model()`, the `/model` setting, which the router never changes. The router publishes its current decision (model, effort, whether it is routed, on or off) in shared state with a declared contract. session-info reads that state when it is present and shows the routed model and effort. When the router is off or not installed, session-info falls back to its current behaviour. With both installed, the owner sees one correct line, not two that disagree. The router's own `$.ui.status` entry may be dropped when session-info is loaded *(builder's call)*.

## Non-goals

- Hook ordering between the two mods. session-info reads the router's state and does not depend on which mod's `turn.step` runs first.
- Routing subagents, workflows or `$.model.complete` calls made by other mods.
- Changing the session's `/model` setting.
- Any provider other than Anthropic.
- Learning from history or tuning itself. Rules are hand-written.

## Anti-goals (failure even if it works)

- Hard work, such as a debug, a plan or a multi-file change, ends up on Haiku or Sonnet and comes back worse.
- The model flips back and forth inside one task, burning the cache and costing more than it saves.
- Every prompt pays a classifier call, which adds delay and cost to the easy prompts this was meant to speed up.
- The owner can't tell which model answered, or why.

## Left to the builder

- Rule keywords, length thresholds and how "clearly new task" is detected.
- How slash commands and skills (prompts that arrive with `e.command`) are ranked. Suggested default: rank by the command's name and args, so `/superpowers:brainstorming` counts as planning, which is hard.
- The toggle command's name, and whether it also shows the current state.
- Log path and format. Suggested: one JSON line per decision under the mod's data folder.
- Exact model aliases or ids (aliases `haiku`/`sonnet`/`opus` are fine).
- Tests: at least one `*.test.ts` covering prefix override, stickiness on follow-ups, hard-signal routing, and passing subagents through.
