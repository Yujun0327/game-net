/**
 * Real-browser smoke test for any game on the shared beacon session.
 *
 * Builds the game, serves the production bundle, opens N ISOLATED Chromium
 * processes on the same room link over the REAL brokers, and asserts:
 *   1. everyone sees everyone in the lobby
 *   2. after ready + start, everyone reaches the game
 *   3. a reload mid-game resumes and stays in step
 *
 * Usage:
 *   node e2e/smoke.mjs --dir=../splendor --handle=__splendor [--players=3] [--port=4199]
 */
import { execSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : dflt
}
const DIR = resolve(flag('dir', '.'))
const HANDLE = flag('handle', '__game')
const PLAYERS = Number(flag('players', '2'))
const PORT = Number(flag('port', '4199'))
const BASE = `http://localhost:${PORT}`
const ROOM = 'SMK' + Math.random().toString(36).slice(2, 5).toUpperCase()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function side(name, logs) {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const t0 = Date.now()
  page.on('console', (m) => {
    const text = m.text()
    if (text.startsWith('[') || m.type() === 'error') {
      logs.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${name}: ${text}`)
    }
  })
  page.on('pageerror', (err) => logs.push(`${name} PAGEERROR: ${err.message}`))
  return { name, browser, page }
}

const call = (page, expr) => page.evaluate(`(() => { const h = window.${HANDLE}; return ${expr} })()`)

async function until(page, expr, timeoutMs, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await call(page, expr)) return
    } catch {
      /* handle not ready yet */
    }
    await sleep(500)
  }
  throw new Error(`${what} (timeout ${timeoutMs / 1000}s)`)
}

const logs = []
console.log(`building ${DIR}…`)
execSync('npx vite build', { cwd: DIR, stdio: 'ignore' })
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: DIR,
  stdio: 'ignore',
})
await sleep(1500)

const sides = []
let failed = false
try {
  for (let i = 0; i < PLAYERS; i++) sides.push(await side(String.fromCharCode(65 + i), logs))
  const link = `${BASE}/#room=${ROOM}`
  for (const s of sides) await s.page.goto(link)

  const t0 = Date.now()
  for (const s of sides) await until(s.page, `h && h.seats.length === ${PLAYERS}`, 30_000, `${s.name}: lobby never filled`)
  console.log(`PASS  lobby: all ${PLAYERS} present  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  for (const s of sides) await call(s.page, 'h.setReady(true)')
  let host = null
  for (const s of sides) {
    await until(s.page, 'h.seats.every((x) => x.ready)', 15_000, `${s.name}: ready flags never converged`)
    if (await call(s.page, 'h.isHost')) host = s
  }
  if (!host) throw new Error('no client believes it is host')
  await until(host.page, 'h.canStart', 10_000, 'host cannot start')
  await call(host.page, 'h.startGame()')
  const t1 = Date.now()
  for (const s of sides) await until(s.page, 'h.playing', 20_000, `${s.name}: never reached the game`)
  console.log(`PASS  start: host ${host.name}, all ${PLAYERS} playing  (${((Date.now() - t1) / 1000).toFixed(1)}s)`)

  const other = sides.find((s) => s !== host)
  await other.page.reload()
  const t2 = Date.now()
  await until(other.page, 'h && h.playing && h.seat !== null', 25_000, `${other.name}: did not resume after reload`)
  const seatsAfter = await Promise.all(sides.map((s) => call(s.page, 'h.seat')))
  if (new Set(seatsAfter).size !== PLAYERS) throw new Error(`seats not distinct after reload: ${seatsAfter}`)
  console.log(`PASS  reload: ${other.name} resumed in seat ${seatsAfter[sides.indexOf(other)]}  (${((Date.now() - t2) / 1000).toFixed(1)}s)`)
} catch (err) {
  failed = true
  console.log(`FAIL  ${err.message}`)
  for (const line of logs.slice(-40)) console.log(`   ${line}`)
} finally {
  for (const s of sides) await s.browser.close()
  server.kill()
}
console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE PASS')
process.exit(failed ? 1 : 0)
