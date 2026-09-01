// Zero-dependency CDP screenshotter for visual checks in this repo.
//
// Node 24 has a global WebSocket, so raw CDP needs nothing installed. Renders a
// real app route (so the fonts, the theme tokens and the backdrop are the real
// ones), optionally injects markup into it, and writes a PNG per theme.
//
//   node scripts/shot.mjs <name> [--url /app] [--theme dark|light|both]
//
// Git Bash rewrites a bare leading-slash argument into a Windows path
// ("/app" → "D:/Git/app"), so pass --url with MSYS_NO_PATHCONV=1 or leave it off
// and let the fixture carry its own route.
//
// The markup to inject lives in scripts/shot-fixtures.mjs, keyed by <name>.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtures from "./shot-fixtures.mjs";

// Chrome's install root is not the same on every machine — a 64-bit install lands
// in "Program Files", a 32-bit one in "Program Files (x86)", and a per-user
// install in LOCALAPPDATA. This used to name the x86 path alone and died with a
// spawn ENOENT anywhere else, which reads as "the screenshot tool is broken"
// rather than "look one directory over". Edge is last because it is Chromium and
// speaks the same CDP, so it is a working fallback rather than a wrong answer.
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
// Per-run port. A fixed 9222 attaches to whatever headless instance a previous
// run left behind (or, worse, to the developer's own browser if they happen to be
// debugging), and the script then hangs waiting for a load event on someone
// else's target. Nothing here should ever have to kill a Chrome it did not start.
const PORT = 9700 + (process.pid % 250);
const BASE = process.env.SHOT_BASE ?? "http://localhost:3001";

const [name, ...rest] = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = rest.indexOf(flag);
  return i === -1 ? fallback : rest[i + 1];
};
const fixture = fixtures[name];
if (!fixture) {
  console.error(`No fixture "${name}". Have: ${Object.keys(fixtures).join(", ")}`);
  process.exit(1);
}
const themes = (arg("--theme", fixture.theme ?? "both") === "both" ? ["light", "dark"] : [arg("--theme", "dark")]);
const url = BASE + (arg("--url", fixture.url ?? "/app"));
const outDir = join(tmpdir(), "splitsy-shots");
mkdirSync(outDir, { recursive: true });

const profile = join(tmpdir(), `shot-profile-${process.pid}`);
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
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
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].method === msg.method) {
        waiters[i].resolve(msg.params);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const message = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
      if (process.env.SHOT_DEBUG) console.error("→", method, JSON.stringify(params).slice(0, 120));
      return new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject });
        ws.send(JSON.stringify(message));
      });
    },
    once(method) {
      return new Promise((resolve) => waiters.push({ method, resolve }));
    },
  };
}

const ws = new WebSocket(await socketUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const cdp = client(ws);

for (const theme of themes) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 2, mobile: false }, sessionId);
  // Before navigation: the app resolves its theme from sessionStorage only (a
  // first visit is always light), so seed the choice rather than emulating
  // prefers-color-scheme — addScriptToEvaluateOnNewDocument runs ahead of the
  // inline theme script in <head>.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `try{sessionStorage.setItem("splitsy-theme",${JSON.stringify(theme)})}catch(e){}` }, sessionId);

  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url }, sessionId);
  await loaded;
  await sleep(3200);

  const measure = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const kill = document.createElement("style");
      kill.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(kill);
      ${fixture.inject}
      const el = document.querySelector(${JSON.stringify(fixture.selector)});
      if (!el) return { error: "selector not found: " + ${JSON.stringify(fixture.selector)} };
      el.scrollIntoView({ block: "start" });
      const r = el.getBoundingClientRect();
      return { height: Math.ceil(r.height), top: Math.round(r.top), bg: getComputedStyle(document.documentElement).getPropertyValue("--pay-poster-bg").trim() };
    })()`,
    returnByValue: true,
  }, sessionId);

  const info = measure.result.value;
  if (info?.error) {
    console.error(`[${theme}] ${info.error}`);
    continue;
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: Math.min(2400, info.height + Math.max(0, info.top) + 48),
    deviceScaleFactor: 2,
    mobile: false,
  }, sessionId);
  await sleep(500);
  await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(fixture.selector)}).scrollIntoView({block:"start"})` }, sessionId);
  await sleep(250);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  const file = join(outDir, `${name}-${theme}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`${file}  (${info.height}px tall, --pay-poster-bg ${info.bg})`);
  await cdp.send("Target.closeTarget", { targetId });
}

ws.close();
chrome.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows keeps a handle briefly */ }
