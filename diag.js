'use strict'
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const log = (...a) => console.error('[diag]', ...a)
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'DiamondBot', version: '1.20.4', auth: 'offline' })
bot.loadPlugin(pathfinder)
const sleep = ms => new Promise(r => setTimeout(r, ms))

bot.once('spawn', async () => {
  const mcData = require('minecraft-data')(bot.version)
  bot.pathfinder.setMovements(new Movements(bot, mcData))
  const pick = mcData.itemsByName.wooden_pickaxe
  const cnt = n => bot.inventory.count(mcData.itemsByName[n].id, null)
  log('inv:', bot.inventory.items().map(i => `${i.name}x${i.count}`).join(','))

  const tableId = mcData.blocksByName.crafting_table.id
  let table = bot.findBlock({ matching: tableId, maxDistance: 16 })
  log('found table?', table && table.position)
  if (table) { await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 1)); log('at table, dist=', bot.entity.position.distanceTo(table.position).toFixed(2)) }

  const noTable = bot.recipesFor(pick.id, null, 1, null)
  const withTable = bot.recipesFor(pick.id, null, 1, table)
  log('recipesFor wooden_pickaxe  noTable=', noTable.length, ' withTable=', withTable.length)
  if (withTable[0]) log('recipe delta:', JSON.stringify(withTable[0].delta.map(d => `${d.count} id${d.id}`)))

  const before = cnt('wooden_pickaxe')
  try {
    await bot.craft(withTable[0], 1, table)
    log('craft() resolved')
  } catch (e) { log('craft ERROR:', e.message) }
  await sleep(600)
  log('wooden_pickaxe before=', before, ' after=', cnt('wooden_pickaxe'))
  log('inv after:', bot.inventory.items().map(i => `${i.name}x${i.count}`).join(','))
  bot.quit(); process.exit(0)
})
bot.on('error', e => log('boterr', e.message))
setTimeout(() => { log('diag timeout'); process.exit(1) }, 60000).unref()
