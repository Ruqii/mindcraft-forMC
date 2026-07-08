'use strict'
/*
 * Records a real gameplay run: connect the play.js agent, serve the web viewer,
 * capture it with headless Chrome (SwiftShader WebGL) via CDP screencast, and
 * mux the frames into an mp4 with ffmpeg. Prints the run outcome JSON to stdout.
 *
 *   node record.js
 *
 * Output: recordings/run.mp4  +  recordings/outcome.json
 * Requires the PaperMC server running on localhost:25565.
 */
const { mineflayer: mineflayerViewer } = require('prismarine-viewer')
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const play = require('./play')

const log = (...a) => console.error('[record]', ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEW_PORT = parseInt(process.env.VIEW_PORT || '3007', 10)
const FPS = parseInt(process.env.FPS || '10', 10)
const OUT = path.join(__dirname, 'recordings')
const FRAMES = path.join(OUT, 'frames')

async function main () {
  fs.rmSync(FRAMES, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })

  // 1) connect the agent + wait until the world is ready
  play.connect({ username: 'DiamondBot' })
  await play.waitReady()
  const bot = play.getBot()
  log('agent ready at', bot.entity.position.floored())

  // 2) serve the third-person web viewer for this bot
  mineflayerViewer(bot, { port: VIEW_PORT, firstPerson: false, viewDistance: 6 })
  await sleep(2500)
  log('viewer serving on', VIEW_PORT)

  // 3) headless Chrome renders the viewer with software WebGL (arm64-safe)
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--no-sandbox', '--window-size=1280,720']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  await page.goto(`http://localhost:${VIEW_PORT}`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(4000) // let the scene draw
  log('viewer rendered, starting capture')

  // 4) capture frames via CDP screencast
  const client = await page.target().createCDPSession()
  let n = 0
  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    try { fs.writeFileSync(path.join(FRAMES, `f${String(n).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64')); n++ } catch {}
    try { await client.send('Page.screencastFrameAck', { sessionId }) } catch {}
  })
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 })

  // 5) play the game while capturing
  const result = await play.playGame({ budgetS: parseInt(process.env.BUDGET_S || '220', 10) })
  await sleep(500)

  // 6) stop capture + tear down
  try { await client.send('Page.stopScreencast') } catch {}
  await sleep(300)
  log('captured', n, 'frames; outcome:', result.reason)
  await browser.close()

  // 7) mux to mp4
  fs.writeFileSync(path.join(OUT, 'outcome.json'), JSON.stringify(result, null, 2))
  if (n >= 5) {
    const mp4 = path.join(OUT, 'run.mp4')
    const r = spawnSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%06d.jpg'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:720', mp4], { encoding: 'utf8' })
    if (r.status === 0) log('WROTE', mp4, fs.statSync(mp4).size, 'bytes,', (n / FPS).toFixed(1), 's')
    else log('ffmpeg failed:', r.stderr?.slice(-400))
  } else { log('too few frames, skipping mp4') }

  process.stdout.write(JSON.stringify(result) + '\n')
  bot.quit()
  process.exit(0)
}
main().catch(e => { log('FATAL', e.stack || e.message); process.exit(1) })
