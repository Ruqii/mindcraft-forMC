/*
 * Real early-game play test: connect -> gather wood -> craft tools -> mine stone.
 * Logs progress to stderr; prints a JSON summary to stdout at the end.
 * Run against the local PaperMC server (localhost:25565).
 */
'use strict'
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const log = (...a) => console.error('[play]', ...a)
const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const VERSION = process.env.MC_VERSION || '1.20.4'
const BUDGET_S = parseInt(process.env.BUDGET_S || '150', 10)

const WOODS = ['oak', 'birch', 'spruce', 'jungle', 'dark_oak', 'acacia', 'mangrove', 'cherry']

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let bot, mcData, LOG_IDS

// Create + wire the bot. Callers (standalone main, or record.js) drive it from here.
function connect (opts = {}) {
  bot = mineflayer.createBot({
    host: opts.host || HOST, port: opts.port || PORT, version: opts.version || VERSION,
    username: opts.username || 'DiamondBot', auth: 'offline'
  })
  bot.loadPlugin(pathfinder)
  bot.on('kicked', r => log('kicked', r))
  bot.on('error', e => log('bot error', e.message))
  return bot
}

const count = (name) => { const it = mcData.itemsByName[name]; return it ? bot.inventory.count(it.id, null) : 0 }
const totalLogs = () => WOODS.reduce((s, w) => s + count(`${w}_log`), 0)
const totalPlanks = () => WOODS.reduce((s, w) => s + count(`${w}_planks`), 0)

async function gotoOnce (pos, range, ms) {
  const goal = new goals.GoalNear(pos.x, pos.y, pos.z, range)
  let to
  const timeout = new Promise((_, rej) => { to = setTimeout(() => { try { bot.pathfinder.stop() } catch {} rej(new Error('goto timeout')) }, ms) })
  try { await Promise.race([bot.pathfinder.goto(goal), timeout]) } finally { clearTimeout(to) }
}

// Retry pathing: mining reshapes terrain, so a single goto can time out even when
// the target is reachable after the pathfinder recomputes.
async function gotoNear (pos, range = 2, ms = 20000, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try { await gotoOnce(pos, range, ms); return } catch (e) {
      if (i === attempts - 1) throw e
      log('goto retry', i + 1, e.message); await sleep(300)
    }
  }
}

async function gatherWood (amount) {
  const start = totalLogs(); let tries = 0
  while (totalLogs() - start < amount && tries < amount * 8) {
    tries++
    const block = bot.findBlock({ matching: LOG_IDS, maxDistance: 128 })
    if (!block) { log('no log in range'); await sleep(500); continue }
    try {
      await gotoNear(block.position, 2)
      const b = bot.blockAt(block.position)
      if (b && LOG_IDS.includes(b.type)) { await bot.dig(b); await sleep(300) }
    } catch (e) { log('wood dig err:', e.message); await sleep(200) }
    log(`logs: ${totalLogs()}`)
  }
  return totalLogs()
}

// Craft with verify+retry: bot.craft() can silently no-op (resolves without
// applying) when a crafting table was placed moments earlier and hasn't synced
// server-side. We confirm the item count actually rose and retry if not.
async function craft (name, times, tableBlock) {
  const item = mcData.itemsByName[name]
  if (!item) throw new Error('unknown item ' + name)
  const tableId = mcData.blocksByName.crafting_table.id
  for (let i = 0; i < times; i++) {
    let ok = false
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      const before = count(name)
      // re-find the table each attempt in case the block reference went stale
      const tb = tableBlock ? (bot.findBlock({ matching: tableId, maxDistance: 4 }) || tableBlock) : null
      const recipe = bot.recipesFor(item.id, null, 1, tb)[0]
      if (!recipe) { await sleep(500); continue }
      try { await bot.craft(recipe, 1, tb) } catch (e) { log(`craft ${name} threw:`, e.message) }
      await sleep(400)
      if (count(name) > before) { ok = true } else { log(`craft ${name} no-op, retry ${attempt + 1}`); await sleep(600) }
    }
    if (!ok) throw new Error(`craft failed for ${name} (table=${!!tableBlock})`)
  }
  log(`crafted ${name} x${times} (have ${count(name)})`)
}

// Craft planks from whatever logs the bot actually holds (spruce, oak, ...).
async function craftPlanksFromLogs () {
  for (const w of WOODS) {
    while (count(`${w}_log`) > 0) await craft(`${w}_planks`, 1)
  }
  log('planks total:', totalPlanks())
}

// A block we can place a table ONTO (must be a full solid cube).
const isSolid = (b) => b && b.boundingBox === 'block'
// A spot we can place a table INTO: air or a replaceable plant (tall grass, ferns,
// flowers, snow layer) — NOT water/lava/solid. Minecraft replaces these on place.
const isReplaceable = (b) => b && b.boundingBox === 'empty' &&
  !b.name.includes('water') && !b.name.includes('lava')

// Try to place the currently-equipped table on top of ground block `refPos`
// (whose column above must be clear). Pathfinds into reach first. Returns the
// placed table block, or null.
async function tryPlaceTableOn (refPos, tableId) {
  const target = refPos.offset(0, 1, 0)
  try { await gotoNear(target, 2, 8000, 1) } catch { /* may already be in reach */ }
  const ref = bot.blockAt(refPos)
  if (!isSolid(ref) || !isReplaceable(bot.blockAt(target))) return null
  if (bot.entity.position.distanceTo(target) > 4.5) return null // still out of reach
  try {
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
    await sleep(150)
    await bot.placeBlock(ref, { x: 0, y: 1, z: 0 })
  } catch (e) { /* placeBlock can time out even when it actually placed — check below */ }
  await sleep(400)
  return bot.findBlock({ matching: tableId, maxDistance: 4 })
}

async function findOrPlaceTable () {
  const tableId = mcData.blocksByName.crafting_table.id
  let t = bot.findBlock({ matching: tableId, maxDistance: 6 })
  if (t) { log('using existing table at', t.position); return t }
  if (count('crafting_table') < 1) await craft('crafting_table', 1)
  await bot.equip(mcData.itemsByName.crafting_table.id, 'hand')

  // Scan a 7x7 area, and within each column search downward for the topmost solid
  // block that has two clear (air/plant) cells above it — a spot with headroom to
  // place + stand next to. Handles uneven terrain, ledges, and tree canopies.
  const p = bot.entity.position.floored()
  const cands = []
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue
      for (let dy = 2; dy >= -3; dy--) {
        const gp = p.offset(dx, dy, dz)
        if (isSolid(bot.blockAt(gp)) && isReplaceable(bot.blockAt(gp.offset(0, 1, 0))) &&
            isReplaceable(bot.blockAt(gp.offset(0, 2, 0)))) { cands.push(gp); break }
      }
    }
  }
  cands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))

  for (const rp of cands) {
    t = await tryPlaceTableOn(rp, tableId)
    if (t) {
      log('placed crafting table at', t.position)
      await sleep(1200) // let the freshly placed block sync server-side before crafting
      return t
    }
  }

  // Fallback: build a pedestal. Place a filler block (dirt/cobble the bot holds)
  // into an adjacent clear cell that has a solid block below it, then set the
  // table on that pedestal. Rescues canopy/pit spots where no natural spot exists.
  const filler = ['dirt', 'cobblestone', 'netherrack', 'andesite', 'diorite', 'granite'].find(n => count(n) > 0)
  if (filler) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue
        const cell = p.offset(dx, -1, dz) // want to fill this with the pedestal block
        const below = bot.blockAt(p.offset(dx, -2, dz))
        if (!isSolid(below) || !isReplaceable(bot.blockAt(cell))) continue
        if (!isReplaceable(bot.blockAt(cell.offset(0, 1, 0))) || !isReplaceable(bot.blockAt(cell.offset(0, 2, 0)))) continue
        try {
          await bot.equip(mcData.itemsByName[filler].id, 'hand')
          await bot.lookAt(cell.offset(0.5, 0.5, 0.5), true); await sleep(150)
          await bot.placeBlock(below, { x: 0, y: 1, z: 0 })
          await sleep(400)
        } catch (e) { continue }
        if (!isSolid(bot.blockAt(cell))) continue
        await bot.equip(mcData.itemsByName.crafting_table.id, 'hand')
        t = await tryPlaceTableOn(cell, tableId)
        if (t) { log('placed crafting table on pedestal at', t.position); await sleep(1200); return t }
      }
    }
  }
  throw new Error('could not place crafting table')
}

async function mine (blockName, amount) {
  const id = mcData.blocksByName[blockName].id
  const dropName = blockName === 'stone' ? 'cobblestone' : blockName
  const start = count(dropName); let tries = 0
  while (count(dropName) - start < amount && tries < amount * 10) {
    tries++
    const block = bot.findBlock({ matching: [id], maxDistance: 48 })
    if (!block) { log(`no ${blockName} nearby`); await sleep(400); continue }
    try {
      await gotoNear(block.position, 2)
      const b = bot.blockAt(block.position)
      if (b && b.type === id && bot.canDigBlock(b)) { await bot.dig(b); await sleep(250) }
    } catch (e) { log('mine err:', e.message); await sleep(200) }
    log(`${dropName}: ${count(dropName)}`)
  }
  return count(dropName)
}

// Tech-tree rungs the run reached, inferred from what the bot currently holds.
// The judge scores by the highest rung (see task/expected.json).
const milestonesReached = () => {
  const has = (n) => count(n) > 0
  const ms = []
  if (has('wooden_pickaxe')) ms.push('wooden_pickaxe')
  if (has('stone_pickaxe')) ms.push('stone_pickaxe')
  if (['iron_ingot', 'iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_shovel', 'iron_hoe'].some(has)) ms.push('iron_ingot')
  if (has('iron_pickaxe')) ms.push('iron_pickaxe')
  if (has('diamond')) ms.push('diamond')
  return ms
}

const outcome = (extra) => ({
  obtained: count('diamond') >= 1, item: 'diamond', count: count('diamond'),
  ticks: bot.time ? bot.time.age : null,
  inventory: bot.inventory.items().map(i => `${i.name}x${i.count}`),
  milestones: milestonesReached(),
  ...extra,
})

const once = (ev) => new Promise(res => bot.once(ev, res))

// Wait for spawn + chunks to load: at spawn, blockAt/findBlock return null until
// the surrounding chunks arrive, which breaks placing/mining. Sets up mcData too.
async function waitReady () {
  await once('spawn')
  mcData = require('minecraft-data')(bot.version)
  LOG_IDS = WOODS.map(w => mcData.blocksByName[`${w}_log`]?.id).filter(x => x != null)
  bot.pathfinder.setMovements(new Movements(bot, mcData))
  for (let i = 0; i < 40; i++) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    if (below && below.name !== 'air' && bot.entity.onGround) break
    await sleep(250)
  }
  log('spawned + chunks loaded')
}

// The gameplay itself. Assumes waitReady() already ran. Returns an outcome object.
async function playGame (opts = {}) {
  const budgetS = opts.budgetS || BUDGET_S
  const deadline = Date.now() + budgetS * 1000
  log('early game, budget', budgetS, 's')
  try {
    if (totalPlanks() < 14) { await gatherWood(4); await craftPlanksFromLogs() }
    if (count('stick') < 2) await craft('stick', 2)
    const table = await findOrPlaceTable()
    await gotoNear(table.position, 1)
    if (!count('wooden_pickaxe') && !count('stone_pickaxe')) await craft('wooden_pickaxe', 1, table)
    if (count('wooden_pickaxe')) { await bot.equip(mcData.itemsByName.wooden_pickaxe.id, 'hand'); log('equipped wooden pickaxe') }
    if (Date.now() < deadline && !count('stone_pickaxe')) {
      await mine('stone', 3)
      if (count('cobblestone') >= 3) {
        // Prefer the original surface table (reliably placeable); only if we can't
        // path back to it (mining reshaped terrain) fall back to placing a new one.
        let craftTable = table
        try { await gotoNear(table.position, 2, 20000, 3) } catch (e) {
          log('cannot reach original table, placing new:', e.message)
          craftTable = await findOrPlaceTable()
          await gotoNear(craftTable.position, 1)
        }
        await craft('stone_pickaxe', 1, craftTable)
      }
    }
    if (count('stone_pickaxe')) { await bot.equip(mcData.itemsByName.stone_pickaxe.id, 'hand'); log('equipped stone pickaxe') }
    return outcome({ reason: 'done' })
  } catch (e) {
    log('CRASH:', e.stack || e.message)
    return outcome({ reason: 'error', error: String(e.message) })
  }
}

async function main () {
  connect()
  setTimeout(() => { log('BUDGET timeout'); try { process.stdout.write(outcomeJson({ reason: 'timeout' }) + '\n') } catch {} process.exit(0) }, (BUDGET_S + 30) * 1000).unref()
  await waitReady()
  const result = await playGame()
  process.stdout.write(outcomeJson(result) + '\n')
  await sleep(500); bot.quit(); process.exit(0)
}

const outcomeJson = (o) => JSON.stringify(o)

module.exports = { connect, waitReady, playGame, outcome, getBot: () => bot, getMcData: () => mcData }

if (require.main === module) main()
