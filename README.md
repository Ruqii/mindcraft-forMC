# minecraft-obtain-diamond — reference solution

Reference agents + recorder for the **[Obtain a Diamond](https://github.com/Ruqii/minecraft-obtain-diamond)**
task. An agent plays real survival Minecraft, the run is recorded to an mp4, and
the task's judge scores how far up the tech tree it got.

This repo is the **solution** half; the gradeable task (goal, judge, rubric) lives
in its own repo: **https://github.com/Ruqii/minecraft-obtain-diamond**.

## Two agents

| Agent | What it is | Use |
|---|---|---|
| **`play.js`** | A hand-scripted Mineflayer bot | Free, deterministic baseline + pipeline smoke-test. Reliably plays the early game (gather wood → craft table + **wooden pickaxe** → mine). |
| **Mindcraft** | Off-the-shelf [Mindcraft](https://github.com/mindcraft-bots/mindcraft) LLM agent (skill library + pluggable model) | The capable path — swap the profile to compare Claude / GPT / Gemini. Setup in [`mindcraft-integration/`](./mindcraft-integration). |

## Recorders

- **`record.js`** — runs `play.js` while capturing its prismarine-viewer view →
  `recordings/run.mp4` + `recordings/outcome.json`.
- **`record-mindcraft.js`** — launches the Mindcraft agent, records its built-in
  view (`localhost:3000`) → mp4, reads the run outcome, and scores it with the
  task's judge.

Both record via headless system Chrome (SwiftShader WebGL, arm64-safe) + `ffmpeg`
— no native `headless-gl` build.

## Prerequisites

- **Node 18/20** for `play.js`/`record.js`; **Node 20** for Mindcraft (it warns
  Node 24+ breaks native deps).
- **`ffmpeg`** and **system Google Chrome** on your machine.
- A **Minecraft Java `1.20.4`** server the bot can join — `online-mode=false`,
  `gamemode=survival`, a fixed `level-seed`. [PaperMC](https://papermc.io/) is a
  good, fast choice; drop the jar in `server/` (gitignored).

## Run

```bash
npm install

# scripted agent (free) — records recordings/run.mp4 + outcome.json
BUDGET_S=220 node record.js

# LLM agent (needs a funded ANTHROPIC_API_KEY) — see mindcraft-integration/README.md
node record-mindcraft.js
```

## Score a run

Scoring is done by the judge in the **task repo**. Clone it alongside this one and
`record-mindcraft.js` scores automatically (override the location with
`TASK_DIR=/path/to/minecraft-obtain-diamond/task`). Scoring is **graded by
tech-tree progress** — wooden pickaxe `0.2` · stone `0.4` · iron ingot `0.6` ·
iron pickaxe `0.8` · diamond `1.0` — and a public `video` URL is required (no
video ⇒ `0.0`). Host the mp4 and put its URL in the outcome's `video` field.

## Status (2026-07-08)

- **Early game works** end-to-end: `play.js` reliably reaches a wooden pickaxe and
  mines, verified against a live PaperMC server.
- **Recording works on arm64** — a real ~40s third-person video of genuine play.
- **Mindcraft integration is complete** except the paid LLM call: the bot spawns
  on the server, serves its view, single Anthropic key (no OpenAI), recorder
  captures it. Add credits to the key and a full run works.
- **Open work:** the mid/late tech tree (stone → iron → furnace → diamond) is not
  yet reliable for the scripted bot; the LLM agent is the path to going further.
