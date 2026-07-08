/*
 * Phase-0 reference agent for the "obtain a diamond" TrapStreet task.
 *
 * WHAT THIS IS: a runnable SKELETON. It connects to a Minecraft Java server,
 * records the run to recording.mp4 (via prismarine-viewer headless), plays the
 * early game (wood -> tools), then prints a JSON outcome as the LAST line of
 * stdout. All diagnostics go to stderr so stdout stays parseable by the judge.
 *
 * WHAT THIS IS NOT (yet): a guaranteed diamond-obtainer. The mid/late tech tree
 * (stone -> iron -> smelt -> descend -> diamond) is left as clearly-marked TODO.
 * Fill it in, or replace play() with an LLM / Voyager-style brain. See README.
 *
 * IMPORTANT contract: print ONLY the final JSON object to stdout. Everything
 * else uses log() (stderr).
 */
'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const log = (...a) => console.error('[agent]', ...a)

const CFG = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'TrapBot',
  version: process.env.MC_VERSION || '1.20.4',
  auth: process.env.MC_AUTH || 'offline',
  seed: process.env.MC_SEED || 'trapstreet',
  timeLimitS: parseInt(process.env.TIME_LIMIT_S || '1800', 10),
  record: (process.env.RECORD || 'true') !== 'false',
  // Where the recording will be publicly hosted after the run (goes in the
  // outcome so the leaderboard can link it). Set this to your committed/​uploaded
  // video URL. If unset, we emit the local filename and you fill the URL in.
  videoUrl: process.env.VIDEO_URL || 'recording.mp4',
}

const startedAt = Date.now()
let finished = false

function currentCount (bot, itemName) {
  const mcData = require('minecraft-data')(bot.version)
  const item = mcData.itemsByName[itemName]
  if (!item) return 0
  return bot.inventory.count(item.id, null)
}

function emitOutcome (bot, obtained, extra = {}) {
  if (finished) return
  finished = true
  const outcome = {
    obtained,
    item: 'diamond',
    count: bot ? currentCount(bot, 'diamond') : 0,
    ticks: bot && bot.time ? bot.time.age : null,
    wall_time_s: +((Date.now() - startedAt) / 1000).toFixed(1),
    video: CFG.videoUrl,
    seed: CFG.seed,
    mc_version: CFG.version,
    ...extra,
  }
  // THE one and only stdout write.
  process.stdout.write(JSON.stringify(outcome) + '\n')
  // Give prismarine-viewer/ffmpeg a beat to flush the mp4, then exit.
  setTimeout(() => process.exit(0), 1500)
}

async function startRecording (bot) {
  if (!CFG.record) return
  try {
    // prismarine-viewer headless renders the bot POV and pipes frames to ffmpeg.
    // Requires `ffmpeg` on PATH. Output: recording.mp4 in cwd.
    const { headless } = require('prismarine-viewer')
    headless(bot, { output: 'recording.mp4', frames: -1, width: 640, height: 360, viewDistance: 6 })
    log('recording -> recording.mp4 (needs ffmpeg on PATH)')
  } catch (e) {
    log('recording unavailable (is ffmpeg installed? is prismarine-viewer present?):', e.message)
  }
}

// --- early-game helpers (implemented) -------------------------------------

async function gather (bot, blockName, amount) {
  const mcData = require('minecraft-data')(bot.version)
  const ids = [mcData.blocksByName[blockName]?.id].filter((x) => x != null)
  if (!ids.length) throw new Error(`unknown block ${blockName}`)
  let got = 0
  while (got < amount) {
    const block = bot.findBlock({ matching: ids, maxDistance: 48 })
    if (!block) throw new Error(`no ${blockName} within range`)
    await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z))
    await bot.dig(bot.blockAt(block.position))
    got++
    log(`gathered ${blockName} ${got}/${amount}`)
  }
}

async function craftItem (bot, itemName, count, useTable) {
  const mcData = require('minecraft-data')(bot.version)
  const item = mcData.itemsByName[itemName]
  if (!item) throw new Error(`unknown item ${itemName}`)
  let table = null
  if (useTable) {
    const tableBlock = mcData.blocksByName.crafting_table
    table = bot.findBlock({ matching: [tableBlock.id], maxDistance: 8 }) || null
  }
  const recipe = bot.recipesFor(item.id, null, count, table)[0]
  if (!recipe) throw new Error(`no recipe for ${itemName} (table=${!!table})`)
  await bot.craft(recipe, count, table)
  log(`crafted ${itemName} x${count}`)
}

async function placeCraftingTable (bot) {
  const mcData = require('minecraft-data')(bot.version)
  const tableItem = mcData.itemsByName.crafting_table
  await bot.equip(tableItem.id, 'hand')
  const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  await bot.placeBlock(ref, { x: 1, y: 0, z: 0 })
  log('placed crafting table')
}

// --- the plan --------------------------------------------------------------

async function play (bot) {
  // Early game (implemented, best-effort):
  await gather(bot, 'oak_log', 3).catch((e) => log('wood step:', e.message))
  await craftItem(bot, 'oak_planks', 3, false).catch((e) => log('planks:', e.message))
  await craftItem(bot, 'stick', 2, false).catch((e) => log('sticks:', e.message))
  await craftItem(bot, 'crafting_table', 1, false).catch((e) => log('table:', e.message))
  await placeCraftingTable(bot).catch((e) => log('place table:', e.message))
  await craftItem(bot, 'wooden_pickaxe', 1, true).catch((e) => log('wood pick:', e.message))

  // TODO(you): the mid/late tech tree — this is the open work.
  //  1. Equip wooden pickaxe; mine >=3 cobblestone; craft stone_pickaxe.
  //  2. Descend safely (avoid lava); find iron_ore; mine with stone pickaxe.
  //  3. Craft + fuel a furnace; smelt iron_ingot; craft iron_pickaxe.
  //  4. Go to y<16; find diamond_ore; mine with the iron pickaxe.
  //  Or: replace this whole function with an LLM/Voyager planner loop.
  log('early game done; mid/late tech tree is TODO — see README')

  // If a diamond somehow ended up in inventory, report success; else report the
  // honest outcome (obtained=false).
  emitOutcome(bot, currentCount(bot, 'diamond') >= 1)
}

// --- wiring ----------------------------------------------------------------

function main () {
  log(`connecting to ${CFG.host}:${CFG.port} as ${CFG.username} (mc ${CFG.version})`)
  const bot = mineflayer.createBot({
    host: CFG.host,
    port: CFG.port,
    username: CFG.username,
    version: CFG.version,
    auth: CFG.auth,
  })

  bot.loadPlugin(pathfinder)

  // Global time limit — always emit an outcome, even on stall.
  const deadline = setTimeout(() => {
    log('time limit reached')
    emitOutcome(bot, currentCount(bot, 'diamond') >= 1, { reason: 'time_limit' })
  }, CFG.timeLimitS * 1000)
  deadline.unref?.()

  // Watch inventory: the moment a diamond appears, we can stop early.
  bot.on('playerCollect', () => {
    if (currentCount(bot, 'diamond') >= 1) {
      log('diamond acquired!')
      emitOutcome(bot, true)
    }
  })

  bot.once('spawn', async () => {
    log('spawned')
    const mcData = require('minecraft-data')(bot.version)
    const moves = new Movements(bot, mcData)
    bot.pathfinder.setMovements(moves)
    await startRecording(bot)
    try {
      await play(bot)
    } catch (e) {
      log('play() crashed:', e.stack || e.message)
      emitOutcome(bot, currentCount(bot, 'diamond') >= 1, { reason: 'error', error: String(e.message) })
    }
  })

  bot.on('kicked', (r) => { log('kicked:', r); emitOutcome(bot, false, { reason: 'kicked' }) })
  bot.on('error', (e) => { log('bot error:', e.message); emitOutcome(bot, false, { reason: 'error', error: String(e.message) }) })
  bot.on('end', () => { log('connection ended'); emitOutcome(bot, false, { reason: 'disconnected' }) })
}

main()
