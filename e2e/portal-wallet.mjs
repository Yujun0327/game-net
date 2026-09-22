/**
 * Real-browser check of the portal wallet against the LIVE ledger:
 * fresh browser → identity created → hello → Collect → balance 1,000 → ranking row.
 *   node e2e/portal-wallet.mjs --dir=../boardgames [--port=4230]
 */
import { execSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const flag = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `=${d}`).split('=')[1]
const DIR = resolve(flag('dir', '../boardgames'))
const PORT = Number(flag('port', '4230'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`building ${DIR}…`)
execSync('npx vite build', { cwd: DIR, stdio: 'ignore' })
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: DIR, stdio: 'ignore' })
await sleep(1500)
const browser = await chromium.launch()
let failed = false
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  await page.goto(`http://localhost:${PORT}/`)
  await page.getByRole('button', { name: /Collect today's/ }).waitFor({ timeout: 15_000 })
  const name = `Smoke ${Math.random().toString(36).slice(2, 6)}`
  await page.locator('.wallet input[type=text]').first().fill(name)
  await page.locator('.wallet input[type=text]').first().press('Enter')
  await page.locator('.wallet input[type=text]').first().blur()
  await page.getByRole('button', { name: /Collect today's/ }).click()
  await page.getByText('+1,000 cash collected.').waitFor({ timeout: 15_000 })
  const cash = await page.locator('.wallet .stat .value').first().textContent()
  if (cash?.trim() !== '1,000') throw new Error(`balance shows ${cash}`)
  await page.getByRole('button', { name: /Collected · next/ }).waitFor({ timeout: 5000 })
  await page.getByText(name).waitFor({ timeout: 10_000 }) // appears in the ranking (0 trophies, but 1,000 cash)
  console.log('PASS  portal wallet: identity → hello → collect 1,000 → ranking row')
} catch (err) {
  failed = true
  console.log('FAIL ', err.message)
} finally {
  await browser.close()
  server.kill()
}
process.exit(failed ? 1 : 0)
