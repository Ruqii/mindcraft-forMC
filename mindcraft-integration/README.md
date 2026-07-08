# Running the task with a Mindcraft LLM agent

[Mindcraft](https://github.com/mindcraft-bots/mindcraft) is an off-the-shelf
Mineflayer + LLM agent (skill library + decision loop + task system). It plays
the `obtain_diamond` task far better than the hand-scripted `play.js`, and lets
you compare models by swapping one profile (Claude / GPT / Gemini / …). This
folder is the glue that plugs Mindcraft into our server + recorder + judge.

## What connects to what

```
our PaperMC server (:25565, 1.20.4)   <── Mindcraft bot (LLM decides actions)
        │                                        │ serves render_bot_view
        │                                        ▼
        │                              localhost:3000  ──► record-mindcraft.js
        │                                                    (headless Chrome + ffmpeg → mp4)
        └── task ends → trap_outcome.js writes trap_outcome.json ──► the task repo's judge.py (graded score)
```

## One-time setup

1. **Node 20** (Mindcraft warns Node 24+ breaks native deps):
   `nvm install 20 && nvm use 20`
2. **Clone + install:**
   `git clone https://github.com/mindcraft-bots/mindcraft.git ~/Documents/Projects/mindcraft`
   `cd ~/Documents/Projects/mindcraft && npm install`
3. **Apply our config** (files in this folder):
   - copy `obtain_diamond.json` → `mindcraft/tasks/obtain_diamond.json`
   - copy `claude.json` → `mindcraft/profiles/claude.json` (drops the OpenAI
     embedding — Mindcraft falls back to word-overlap, so **only one key needed**)
   - copy `trap_outcome.js` → `mindcraft/src/agent/trap_outcome.js`
   - in `mindcraft/src/agent/agent.js`: `import { writeTrapOutcome } from './trap_outcome.js';`
     and, inside `checkTaskDone()` right after `history.save()`, add
     `writeTrapOutcome(this, res);`
   - in `mindcraft/settings.js` set: `minecraft_version:"1.20.4"`, `host:"127.0.0.1"`,
     `port:25565`, `base_profile:"survival"`, `profiles:["./profiles/claude.json"]`,
     `render_bot_view:true`, `auto_open_ui:false`
4. **Key:** a funded `ANTHROPIC_API_KEY` in your environment (or in `mindcraft/keys.json`).

## Run

Server up, then from `solution/`:

```
node record-mindcraft.js          # full run; ends at task success or the 1800s timeout
MAX_RECORD_S=25 node record-mindcraft.js   # short smoke test of the capture path
```

Outputs: `recordings/mindcraft_run.mp4`, `recordings/outcome.json`, and a judge
line (`JUDGE: {...score...}`). Publish the mp4 and put its URL in the outcome's
`video` field to satisfy the video-required floor.

## Status (2026-07-08)

Verified end-to-end **except the paid LLM call**: bot connects to our 1.20.4
server, viewer serves on :3000, single-key embedding fallback works, recorder
captured 227 frames → a real 28s mp4 of the bot's view. The only blocker was
`credit balance too low` — add credits to the key and a full run works.
