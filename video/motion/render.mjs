import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CUES, FPS, PHASES, RAIL_LEGS, TOTAL_FRAMES } from "./timeline.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(ROOT, "out", "splitsy-any-handle.mp4");
const WORK = "/tmp/splitsy-motion-render";
const FRAMES = join(WORK, "frames");
const CHROME = join(ROOT, "node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell");
const PORT = 9444;

const b64 = (value) => value.toString("base64");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `--stills` renders a sampler instead of the cut — for looking, not for shipping. */
const STILLS = process.argv.includes("--stills");
const OUTPUT_FPS = 30;
const FRAME_STEP = FPS / OUTPUT_FPS;
const STILL_FRAMES = [0, 40, 110, 132, 186, 264, 324, 400, 470, 504, 592, 660, 684, 760, 900 - 1];

const logo = b64(await readFile(join(ROOT, "public/splitsy.png")));
const font = b64(await readFile(join(ROOT, "public/fonts/ClashDisplay-Variable.woff2")));
const scene = await readFile(join(ROOT, "video/motion/scene.js"), "utf8");
const timeline = JSON.stringify({ FPS, TOTAL_FRAMES, PHASES, RAIL_LEGS });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Clash;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:200 700}
:root{--ink:#071421;--paper:#f7f3ea;--blue:#2775ca;--cyan:#3ee6d6;--green:#17a56b;--muted:#93a5b7;--line:rgba(247,243,234,.15)}
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:var(--ink)}body{font-family:Clash,system-ui,sans-serif;color:var(--paper)}
#stage{position:absolute;inset:0;transform-origin:50% 50%;background:radial-gradient(ellipse at 18% 10%,rgba(39,117,202,.27),transparent 44%),radial-gradient(ellipse at 88% 84%,rgba(62,230,214,.16),transparent 42%),var(--ink)}
#grain{position:absolute;inset:0;opacity:.08;mix-blend-mode:screen;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.72' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
#floor{position:absolute;inset:-20%;opacity:.18;background-image:linear-gradient(rgba(247,243,234,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(247,243,234,.04) 1px,transparent 1px);background-size:76px 76px;transform-origin:50% 70%}
#sweep{position:absolute;top:-20%;bottom:-20%;left:-20%;width:430px;transform:skewX(-16deg);background:linear-gradient(90deg,transparent,rgba(62,230,214,.22),transparent);filter:blur(30px)}
#topline{position:absolute;left:120px;right:120px;top:66px;display:flex;justify-content:space-between;color:var(--muted);font-size:19px;letter-spacing:.18em;text-transform:uppercase}.brand{display:flex;align-items:center;gap:18px}.brand-dot{width:11px;height:11px;border-radius:50%;background:var(--cyan);box-shadow:0 0 24px var(--cyan)}
#meter{position:absolute;left:120px;right:120px;top:112px;height:2px;transform-origin:left;background:linear-gradient(90deg,var(--cyan),var(--blue),transparent);box-shadow:0 0 16px rgba(62,230,214,.6)}
#scene-logo{position:absolute;left:120px;top:140px;width:255px;height:75px;object-fit:contain;object-position:left center;opacity:.92}
#copy{position:absolute;left:120px;top:310px;z-index:2;transform-origin:left center}.eyebrow{color:var(--cyan);font-size:22px;font-weight:500;letter-spacing:.2em;text-transform:uppercase}.headline{margin-top:24px;font-size:150px;line-height:.86;letter-spacing:-.065em;font-weight:300;overflow:hidden}.headline .line{display:block;overflow:hidden}.headline .word{display:inline-block;will-change:transform,opacity}.headline em{font-style:normal;color:var(--cyan)}.sub{margin-top:34px;color:var(--muted);font-size:28px;letter-spacing:.015em}
#nodes{position:absolute;inset:0;z-index:1}.node{position:absolute;width:186px;height:186px;border:1px solid rgba(247,243,234,.28);border-radius:50%;display:grid;place-items:center;transform:translate(-50%,-50%);background:rgba(7,20,33,.64);box-shadow:inset 0 0 50px rgba(62,230,214,.08),0 0 0 1px rgba(62,230,214,.05);font-size:30px;text-align:center}.node b{font-weight:500}.node small{display:block;margin-top:10px;color:var(--muted);font:500 14px/1.1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}.node .ring{position:absolute;inset:-10px;border-radius:50%;border:1px solid rgba(62,230,214,.25)}
#orbit{position:absolute;left:1190px;top:230px;width:660px;height:660px;border:1px solid var(--line);border-radius:50%;transform-origin:center;opacity:0}.orbit2{position:absolute;inset:90px;border:1px dashed rgba(62,230,214,.28);border-radius:50%;transform:rotate(-18deg)}.orbit3{position:absolute;inset:205px;border:1px solid rgba(39,117,202,.34);border-radius:50%;transform:rotate(23deg)}
#wire{position:absolute;inset:0;z-index:0;opacity:0}.wire-line{fill:none;stroke:rgba(62,230,214,.28);stroke-width:2;stroke-dasharray:8 12}
#railwrap{position:absolute;left:120px;right:120px;bottom:105px;height:320px;z-index:4;transform-origin:center bottom}.rail-title{position:absolute;left:0;top:0;font-size:25px;letter-spacing:.2em;text-transform:uppercase;font-weight:500}.rail-title .accent{color:var(--cyan)}
#rail{position:absolute;left:0;right:0;top:78px;height:100px;border-top:1px solid rgba(247,243,234,.34);border-bottom:1px solid rgba(247,243,234,.16)}#rail:before{content:"";position:absolute;left:0;right:0;top:49px;border-top:1px dashed rgba(247,243,234,.2)}#railpath{position:absolute;left:0;right:0;top:48px;height:3px;background:linear-gradient(90deg,transparent,var(--cyan) 12%,var(--blue) 70%,transparent);box-shadow:0 0 24px rgba(62,230,214,.65);transform-origin:center}
#chip{position:absolute;left:0;top:21px;width:132px;height:58px;border:1px solid rgba(247,243,234,.78);border-radius:5px;display:grid;place-items:center;background:rgba(7,20,33,.94);box-shadow:0 0 30px rgba(62,230,214,.34);font-size:26px;font-weight:500;will-change:transform}.chip-arrow{position:absolute;right:-11px;top:21px;border-left:11px solid var(--cyan);border-top:8px solid transparent;border-bottom:8px solid transparent}.is-reversed .chip-arrow{right:auto;left:-11px;border-left:0;border-right:11px solid var(--cyan)}
.ghost{position:absolute;top:38px;left:0;width:132px;height:30px;border:1px solid rgba(62,230,214,.22);border-radius:4px;will-change:transform}.ghost.g2{top:42px}.ghost.g3{top:46px}
#counter{position:absolute;right:0;top:-24px;text-align:right}.counter-amount{font-size:116px;line-height:.78;font-weight:300;letter-spacing:-.07em}.counter-label{margin-top:19px;color:var(--muted);font-size:17px;letter-spacing:.2em;text-transform:uppercase}
#caption{position:absolute;left:0;bottom:0;font-size:58px;letter-spacing:-.035em;font-weight:300}.caption-accent{color:var(--cyan)}#stamp{position:absolute;right:0;bottom:-6px;padding:12px 18px;border:2px solid var(--green);color:var(--green);font-size:22px;letter-spacing:.16em;text-transform:uppercase;transform:rotate(-6deg);box-shadow:0 0 24px rgba(23,165,107,.35)}
#endcard{position:absolute;inset:0;z-index:6;display:grid;place-items:center;text-align:center;background:radial-gradient(ellipse at center,rgba(39,117,202,.25),transparent 59%),var(--ink);visibility:hidden;transform-origin:center}#endmark{width:660px;height:230px;object-fit:contain;margin:0 auto -14px}.end-title{font-size:78px;line-height:.93;letter-spacing:-.05em;font-weight:300}.end-title em{font-style:normal;color:var(--cyan)}.end-sub{margin-top:28px;color:var(--muted);font-size:22px;letter-spacing:.18em;text-transform:uppercase}.end-url{margin-top:34px;color:var(--cyan);font-size:27px;letter-spacing:.12em}
</style></head><body><main id="stage"><div id="grain"></div><div id="floor"></div><div id="sweep"></div>
<div id="topline"><div class="brand"><span class="brand-dot"></span><span>SPLITSY / MONEY, UNSTUCK</span></div><span id="readout">00:00</span></div><div id="meter"></div>
<img id="scene-logo" src="data:image/png;base64,${logo}"/>
<section id="copy"><div id="eyebrow" class="eyebrow">programmable money for real life</div><div class="headline"><span class="line"><span class="word">One</span> <span class="word">handle.</span></span><span class="line"><span class="word"><em>Any</em></span> <span class="word"><em>direction.</em></span></span></div><div id="sub" class="sub">Send it. Request it. Keep the conversation moving.</div></section>
<div id="nodes"><div class="node" data-key="x"><div><b>@dani</b><small>X handle</small></div><span class="ring"></span></div><div class="node" data-key="discord"><div><b>dani#0420</b><small>Discord</small></div><span class="ring"></span></div><div class="node" data-key="email"><div><b>dani@mail</b><small>Email</small></div><span class="ring"></span></div><div class="node" data-key="wallet"><div><b>0xEE42…</b><small>Wallet</small></div><span class="ring"></span></div></div>
<svg id="wire" viewBox="0 0 1920 1080" preserveAspectRatio="none"><path class="wire-line" d="M1420 372 C1270 480 1270 600 1420 760"/><path class="wire-line" d="M1740 372 C1600 500 1600 650 1740 760"/></svg>
<div id="orbit"><div class="orbit2"></div><div class="orbit3"></div></div>
<section id="railwrap"><div class="rail-title"><span id="verb" class="accent">SEND</span> / <span id="prep">to anyone</span></div><div id="rail"><div id="railpath"></div><div id="chip"><b>$0</b><span class="chip-arrow"></span></div><div class="ghost"></div><div class="ghost g2"></div><div class="ghost g3"></div></div><div id="counter"><div id="amount" class="counter-amount">$0</div><div id="counterlabel" class="counter-label">sent</div></div><div id="caption">Money moves at the speed of a mention.</div><div id="stamp">settled · arc</div></section>
<section id="endcard"><div><img id="endmark" src="data:image/png;base64,${logo}"/><div id="endtitle" class="end-title">Send or <em>request.</em><br/>Anyone, anywhere.</div><div id="endsub" class="end-sub">One rail. Every handle.</div><div id="endurl" class="end-url">splitsy.xyz</div></div></section>
</main><script>window.__TIMELINE__=${timeline};${scene}</script></body></html>`;

class CDP {
  constructor(ws) { this.socket = new WebSocket(ws); this.nextId = 0; this.pending = new Map(); this.ready = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; }); this.socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id && this.pending.has(message.id)) { this.pending.get(message.id)(message); this.pending.delete(message.id); } }; }
  async send(method, params = {}, sessionId) { await this.ready; return new Promise((resolve) => { const id = ++this.nextId; this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method, params, sessionId })); }); }
  close() { this.socket.close(); }
}

async function startChrome() {
  const proc = spawn(CHROME, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", "--mute-audio", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${WORK}/profile`, "about:blank"], { stdio: "ignore" });
  let ws;
  for (let i = 0; i < 80; i++) { try { const response = await fetch(`http://127.0.0.1:${PORT}/json/version`); ws = (await response.json()).webSocketDebuggerUrl; if (ws) break; } catch {} await wait(250); }
  if (!ws) throw new Error("Chrome CDP did not start");
  return { proc, ws };
}

/** Opens the page in headless Chrome and hands back a per-session `send`. */
async function openPage(cdp) {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.result.targetId, flatten: true });
  const session = attached.result.sessionId;
  const S = (method, params) => cdp.send(method, params, session);
  await S("Page.enable");
  await S("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const frameId = (await S("Page.getFrameTree")).result.frameTree.frame.id;
  await S("Page.setDocumentContent", { frameId, html: HTML });
  await wait(900);
  return S;
}

/** Renders one frame and returns its PNG bytes. Throws if the scene itself threw. */
async function capture(S, frame) {
  const evaluation = await S("Runtime.evaluate", { expression: `window.renderFrame(${frame})`, returnByValue: true });
  // CDP nests this one level down. Checking `evaluation.exceptionDetails`
  // silently swallows every throw from the scene and renders a half-drawn
  // frame instead of failing — which is exactly what it did the first time.
  const thrown = evaluation.result?.exceptionDetails;
  if (thrown) throw new Error(`frame ${frame}: ${thrown.exception?.description ?? thrown.text}`);
  await wait(1);
  const shot = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  return Buffer.from(shot.result.data, "base64");
}

async function renderStills() {
  await rm(join(WORK, "stills"), { recursive: true, force: true }); await mkdir(join(WORK, "stills"), { recursive: true });
  const { proc, ws } = await startChrome(); const cdp = new CDP(ws);
  try {
    const S = await openPage(cdp);
    // Numbered by position, not by frame: ffmpeg's image2 demuxer reads a
    // contiguous sequence, and still frames are deliberately not contiguous.
    for (const [index, frame] of STILL_FRAMES.entries()) {
      const png = await capture(S, frame);
      await writeFile(join(WORK, "stills", `still-${String(index).padStart(4, "0")}.png`), png);
      // Alongside the sheet, the frame's own name — the sheet is for looking,
      // this is for checking one shot at full size.
      await writeFile(join(WORK, "stills", `f${String(frame).padStart(4, "0")}.png`), png);
    }
  } finally { cdp.close(); proc.kill("SIGKILL"); }
  // One contact sheet, so fifteen stills are one look rather than fifteen.
  const sheet = spawn("ffmpeg", ["-y", "-v", "error", "-pattern_type", "sequence", "-i", join(WORK, "stills", "still-%04d.png"), "-vf", "scale=640:-1,tile=5x3", "-frames:v", "1", join(ROOT, "out", "motion-stills.png")], { stdio: "inherit" });
  await new Promise((resolve, reject) => sheet.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`stills ffmpeg failed: ${code}`))));
  console.log(`wrote ${join(ROOT, "out", "motion-stills.png")}`);
}

async function run() {
  if (STILLS) return renderStills();
  await rm(WORK, { recursive: true, force: true }); await mkdir(FRAMES, { recursive: true });
  const { proc, ws } = await startChrome(); const cdp = new CDP(ws);
  try {
    const S = await openPage(cdp);
    for (let outputFrame = 0; outputFrame < TOTAL_FRAMES / FRAME_STEP; outputFrame++) {
      const frame = outputFrame * FRAME_STEP;
      await writeFile(join(FRAMES, `frame-${String(outputFrame).padStart(4, "0")}.png`), await capture(S, frame));
      if (outputFrame % 50 === 0) console.log(`captured ${outputFrame}/${TOTAL_FRAMES / FRAME_STEP}`);
    }
  } finally { cdp.close(); proc.kill("SIGKILL"); }

  const silent = join(WORK, "silent.mp4");
  const video = spawn("ffmpeg", ["-y", "-v", "error", "-framerate", String(OUTPUT_FPS), "-i", join(FRAMES, "frame-%04d.png"), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", silent], { stdio: "inherit" });
  await new Promise((resolve, reject) => video.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`video ffmpeg failed: ${code}`))));

  const filters = CUES.map((cue, i) => `[${i + 1}:a]adelay=${Math.round(cue.frame * 1000 / FPS)}|${Math.round(cue.frame * 1000 / FPS)},volume=${cue.volume}${cue.rate ? `,atempo=${cue.rate}` : ""}[a${i}]`).join(";");
  const inputs = CUES.flatMap((cue) => ["-i", join(ROOT, "public/sfx", `${cue.src}.wav`)]);
  const mix = CUES.map((_, i) => `[a${i}]`).join("");
  const audio = spawn("ffmpeg", ["-y", "-v", "error", "-i", silent, ...inputs, "-filter_complex", `${filters};${mix}amix=inputs=${CUES.length}:duration=longest:normalize=0,alimiter=limit=0.92[a]`, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", OUT], { stdio: "inherit" });
  await new Promise((resolve, reject) => audio.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`audio ffmpeg failed: ${code}`))));
  await rm(WORK, { recursive: true, force: true });
  console.log(`wrote ${OUT}`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
