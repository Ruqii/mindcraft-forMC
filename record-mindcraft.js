'use strict'
/*
 * Runs a Mindcraft (LLM agent) obtain-diamond attempt against our local PaperMC
 * server, records its built-in web view (localhost:3000) to an mp4, and emits an
 * outcome JSON scored by task/judge.py.
 *
 *   node record-mindcraft.js                 # full run (uses task timeout)
 *   MAX_RECORD_S=25 node record-mindcraft.js # short smoke test of the capture path
 *
 * Requires: the PaperMC server up on :25565, Node 20 for the Mindcraft child, a
 * funded ANTHROPIC_API_KEY in the environment, and system Chrome.
 */
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const log = (...a) => console.error('[rec-mc]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MINDCRAFT_DIR = process.env.MINDCRAFT_DIR || path.join(os.homedir(), 'Documents/Projects/mindcraft')
const NODE20 = process.env.NODE20 || path.join(os.homedir(), '.nvm/versions/node/v20.20.2/bin/node')
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEW_PORT = parseInt(process.env.VIEW_PORT || '3000', 10) // Mindcraft's render_bot_view port
const FPS = parseInt(process.env.FPS || '8', 10)
const MAX_RECORD_S = parseInt(process.env.MAX_RECORD_S || '2000', 10) // hard cap; run usually ends first
const OUT = path.join(__dirname, 'recordings')
const FRAMES = path.join(OUT, 'frames')
const OUTCOME_FILE = path.join(MINDCRAFT_DIR, 'trap_outcome.json')

async function waitForViewer (deadlineMs) {
  // Mindcraft serves the viewer once the bot spawns; poll the port.
  while (Date.now() < deadlineMs) {
    const ok = await fetch(`http://localhost:${VIEW_PORT}`).then((r) => r.ok).catch(() => false)
    if (ok) return true
    await sleep(1000)
  }
  return false
}

async function main () {
  fs.rmSync(FRAMES, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })
  try { fs.rmSync(OUTCOME_FILE, { force: true }) } catch {}

  // 1) launch the Mindcraft agent (Node 20), inheriting env (ANTHROPIC key) +
  //    telling the shim where to write the outcome and what video path to embed.
  const finalMp4 = path.join(OUT, 'mindcraft_run.mp4')
  const child = spawn(NODE20, ['main.js', '--task_path', 'tasks/obtain_diamond.json', '--task_id', 'obtain_diamond'], {
    cwd: MINDCRAFT_DIR,
    env: { ...process.env, TRAP_OUTCOME: OUTCOME_FILE, TRAP_SEED: 'diamondrun', TRAP_VIDEO: finalMp4 },
  })
  let childExited = false
  const mcLog = fs.createWriteStream(path.join(OUT, 'mindcraft.log'))
  child.stdout.pipe(mcLog); child.stderr.pipe(mcLog)
  child.on('exit', (code) => { childExited = true; log('mindcraft exited', code) })

  // 2) wait for the viewer to come up
  log('waiting for viewer on', VIEW_PORT)
  if (!await waitForViewer(Date.now() + 60000)) { log('viewer never came up'); child.kill('SIGINT'); process.exit(2) }
  await sleep(2500)

  // 3) headless Chrome renders the viewer (SwiftShader WebGL, arm64-safe)
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--no-sandbox', '--window-size=1280,720'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  await page.goto(`http://localhost:${VIEW_PORT}`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(4000)
  log('recording; will stop when the run ends (cap', MAX_RECORD_S, 's)')

  // 4) capture frames via CDP screencast
  const client = await page.target().createCDPSession()
  let n = 0
  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    try { fs.writeFileSync(path.join(FRAMES, `f${String(n).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64')); n++ } catch {}
    try { await client.send('Page.screencastFrameAck', { sessionId }) } catch {}
  })
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 })

  // 5) run until the agent's task ends (child exits) or the cap is hit
  const deadline = Date.now() + MAX_RECORD_S * 1000
  while (!childExited && Date.now() < deadline) await sleep(1000)

  try { await client.send('Page.stopScreencast') } catch {}
  await sleep(300)
  log('captured', n, 'frames')
  try { await browser.close() } catch {}
  if (!childExited) { child.kill('SIGINT'); await sleep(2000) }

  // 6) mux to mp4
  if (n >= 5) {
    const r = spawnSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%06d.jpg'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:720', finalMp4], { encoding: 'utf8' })
    if (r.status === 0) log('WROTE', finalMp4, fs.statSync(finalMp4).size, 'bytes,', (n / FPS).toFixed(1), 's')
    else log('ffmpeg failed:', r.stderr?.slice(-400))
  } else { log('too few frames, skipping mp4') }

  // 7) read the shim's outcome, embed the video path, score with the task judge
  let outcome = null
  try { outcome = JSON.parse(fs.readFileSync(OUTCOME_FILE, 'utf8')) } catch { log('no outcome file (run may not have reached checkTaskDone)') }
  if (outcome) {
    outcome.video = fs.existsSync(finalMp4) ? finalMp4 : ''
    fs.writeFileSync(path.join(OUT, 'outcome.json'), JSON.stringify(outcome, null, 2))
    log('outcome:', JSON.stringify({ obtained: outcome.obtained, milestones: outcome.milestones, mindcraft_score: outcome.mindcraft_score }))
    // score with the task's judge. The task lives in its own repo; point TASK_DIR
    // at a local clone of minecraft-obtain-diamond/task (default: sibling checkout).
    const TASK_DIR = process.env.TASK_DIR || path.join(os.homedir(), 'Documents/Projects/minecraft-obtain-diamond/task')
    const judge = path.join(TASK_DIR, 'judge.py')
    const exp = path.join(TASK_DIR, 'expected', 'obtain_diamond', 'expected.json')
    if (!fs.existsSync(judge)) { log('task judge not found at', TASK_DIR, '- set TASK_DIR to the task repo checkout; skipping scoring'); process.exit(0) }
    const py = spawnSync('python3', ['-c',
      `import json,sys; sys.path.insert(0,${JSON.stringify(path.dirname(judge))}); import judge; ` +
      `print(json.dumps(judge.evaluate(json.dumps(json.load(open(${JSON.stringify(path.join(OUT, 'outcome.json'))}))), json.load(open(${JSON.stringify(exp)})), 0)))`,
    ], { encoding: 'utf8' })
    if (py.status === 0) log('JUDGE:', py.stdout.trim())
    else log('judge error:', (py.stderr || '').slice(-300))
  }
  process.exit(0)
}
main().catch((e) => { log('FATAL', e.stack || e.message); process.exit(1) })
