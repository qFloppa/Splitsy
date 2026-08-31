// Layout check for the settle deck at browser-zoom-equivalent viewport heights.
//
// Zoom shrinks the CSS-px window but not the rem floors in the settle card's
// type, so past ~125% the centered column printed through the absolutely-pinned
// rail ("04 / 27") and triggers ("verified on arc"). The fix is a compact pass
// behind `@media (max-height: 48rem)`. This injects a copy of the wallet-debt
// card (the one in the bug report) onto a light route and, at each height,
// measures the gap between the pinned chrome and the flow column: positive
// numbers are overlaps, negative are clearances. Also captures a PNG per height.
//
//   node scripts/check-settle-zoom.mjs [--base http://localhost:3001]
//
// Heights: 923 = a ~923px window at 100% (control — the new rules must not
// apply), 738 = same window at 125%, 615 = 150%, 527 = 175%.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error(`No Chrome found. Set CHROME_PATH, or install one of:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
  process.exit(1);
}

const PORT = 9500 + (process.pid % 250);
const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:3001";
const HEIGHTS = process.env.HEIGHTS ? process.env.HEIGHTS.split(",").map(Number) : [923, 738, 615, 527];

// Copied from SettleDeck's Section + WalletDebtBody render — same classes, same
// order, so the app's own CSS lays it out exactly as the real card.
const CARD = `
<div id="shot-host" style="height:100dvh">
  <section class="settle-section" data-active="true" data-id="check">
    <div class="settle-rail"><span>04 / 27</span><span>arc testnet</span></div>
    <p class="settle-label">bill #18</p>
    <h2 class="settle-merchant">Cider Cellar</h2>
    <p class="settle-label">you pay</p>
    <p class="settle-amount">2.00</p>
    <span class="settle-rule"></span>
    <p class="settle-meta">of $3.04 owed</p>
    <button class="settle-action" type="button">Pay →</button>
    <aside class="settle-aside">
      <div class="settle-aside-row">
        <span class="settle-label">group paid</span>
        <span class="settle-aside-value">$1.04 of $6.07</span>
        <span aria-hidden="true" class="settle-progress"><span style="width:17%"></span></span>
        <span class="settle-meta">17% in · split 2 ways</span>
      </div>
      <div class="settle-aside-row"><span class="settle-label">your share</span><span class="settle-aside-value">$3.04 · $1.04 paid</span></div>
      <div class="settle-aside-row"><span class="settle-label">collected by</span><span class="settle-aside-value">0x353C…bC28</span></div>
      <div class="settle-aside-row"><span class="settle-label">paying from</span><span class="settle-aside-value">0xB77d…9807</span></div>
    </aside>
    <div class="settle-triggers">
      <button class="settle-trigger" type="button">⌃ verified on arc</button>
      <button class="settle-trigger" type="button">⌃ bridge</button>
    </div>
  </section>
</div>`;

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(tmpdir(), `zoomcheck-${process.pid}`)}`,
  "--no-first-run",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function socketUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome never came up");
}

function client(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const message = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
      return new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject });
        ws.send(JSON.stringify(message));
      });
    },
    once(method) {
      return new Promise((resolve) => {
        const handler = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.method === method) {
            ws.removeEventListener("message", handler);
            resolve(msg.params);
          }
        };
        ws.addEventListener("message", handler);
      });
    },
  };
}

const ws = new WebSocket(await socketUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const cdp = client(ws);

const outDir = join(tmpdir(), "splitsy-zoomcheck");
mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const height of HEIGHTS) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1526, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);

  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `${BASE}/disclaimer` }, sessionId);
  await loaded;
  await sleep(1500);

  const m = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.body.innerHTML = ${JSON.stringify(CARD)};
      const q = (s) => document.querySelector(s).getBoundingClientRect();
      const rail = q(".settle-rail"), merchant = q(".settle-merchant");
      const action = q(".settle-action"), triggers = q(".settle-triggers");
      const aside = q(".settle-aside");
      return {
        mq: matchMedia("(max-height: 48rem)").matches,
        railOverMerchant: +(rail.bottom - merchant.top).toFixed(1),
        actionOverTriggers: +(action.bottom - triggers.top).toFixed(1),
        merchantOverAside: +(merchant.right - aside.left).toFixed(1),
      };
    })()`,
    returnByValue: true,
  }, sessionId);
  const v = m.result.value;
  const bad = v.railOverMerchant > 0 || v.actionOverTriggers > 0 || v.merchantOverAside > 0;
  if (bad) failures++;
  console.log(
    `${height}px  mq=${v.mq}  rail↕headline ${v.railOverMerchant}  button↕triggers ${v.actionOverTriggers}  headline↔aside ${v.merchantOverAside}  ${bad ? "FAIL" : "ok"}`,
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(outDir, `settle-${height}.png`), Buffer.from(shot.data, "base64"));
  await cdp.send("Target.closeTarget", { targetId });
}

console.log(`shots: ${outDir}`);
ws.close();
chrome.kill();
await sleep(400);
try { rmSync(join(tmpdir(), `zoomcheck-${process.pid}`), { recursive: true, force: true }); } catch { /* Windows keeps a handle briefly */ }
process.exit(failures ? 1 : 0);
