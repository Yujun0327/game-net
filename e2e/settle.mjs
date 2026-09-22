/**
 * Real-browser settlement check against the LIVE ledger, using Toy Battle
 * (its concede move ends a game legally after a few moves):
 *   two isolated browsers pair → play until the log is long enough → guest
 *   concedes → both wallets report a settled payout; the host is +300.
 *   node e2e/settle.mjs [--port=4240]
 */
import { execSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const flag = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `=${d}`).split('=')[1]
const DIR = resolve('../toybattle')
const PORT = Number(flag('port', '4240'))
const BASE = `http://localhost:${PORT}`
const ROOM = 'STL' + Math.random().toString(36).slice(2, 5).toUpperCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const call = (page, expr) => page.evaluate(`(() => { const s = window.__toybattle; const h = s && s.net; return ${expr} })()`)
async function until(page, expr, ms, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await call(page, expr)) return
    } catch {}
    await sleep(400)
  }
  throw new Error(`${what} (timeout ${ms / 1000}s)`)
}

console.log(`building ${DIR}…`)
execSync('npx vite build', { cwd: DIR, stdio: 'ignore' })
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: DIR, stdio: 'ignore' })
await sleep(1500)
const logs = []
const sides = []
let failed = false
try {
  for (const name of ['A', 'B']) {
    const browser = await chromium.launch()
    const page = await browser.newPage()
    page.on('console', (m) => (m.text().startsWith('[') || m.type() === 'error') && logs.push(`${name}: ${m.text()}`))
    await page.goto(`${BASE}/#room=${ROOM}`)
    sides.push({ name, browser, page })
  }
  for (const s of sides) await until(s.page, 's.playing', 30_000, `${s.name} never paired`)
  console.log('PASS  paired')

  // play until the settlement rules consider it a real game (minMoves for toybattle = 8)
  for (let i = 0; i < 40; i++) {
    const len = await call(sides[0].page, 'h.logLength')
    if (len >= 10) break
    const actor = []
    for (const s of sides) if (await call(s.page, 's.myTurn && s.myMoves().length > 0')) actor.push(s)
    if (actor.length) {
      await call(actor[0].page, "(() => { const m = s.myMoves(); s.submit(m.find((x) => x.type === 'place') ?? m[0]) })()")
    }
    await sleep(600)
  }
  const guest = []
  for (const s of sides) if (!(await call(s.page, 'h.isHost'))) guest.push(s)
  const host = sides.find((s) => s !== guest[0])
  await call(guest[0].page, "s.submit({ type: 'concede' })")
  for (const s of sides) await until(s.page, 's.state.result !== null', 10_000, `${s.name} did not see the result`)
  console.log('PASS  game over by concede')

  for (const s of sides) await until(s.page, "s.payout && (s.payout.status === 'settled' || s.payout.status === 'rejected' || s.payout.status === 'void')", 30_000, `${s.name} settlement never finished`)
  const hp = await call(host.page, 'JSON.stringify(s.payout)')
  const gp = await call(guest[0].page, 'JSON.stringify(s.payout)')
  console.log('host payout ', hp)
  console.log('guest payout', gp)
  const h = JSON.parse(hp)
  if (h.status !== 'settled' || h.cash !== 300 || h.trophies !== 10) throw new Error('host was not paid 300 / 10')
  if (JSON.parse(gp).status !== 'settled') throw new Error('guest not settled')
  console.log('PASS  settled on the live ledger')
} catch (err) {
  failed = true
  console.log('FAIL ', err.message)
  for (const l of logs.slice(-30)) console.log('   ', l)
} finally {
  for (const s of sides) await s.browser.close()
  server.kill()
}
process.exit(failed ? 1 : 0)
