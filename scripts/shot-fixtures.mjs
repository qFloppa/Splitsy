// Markup fixtures for scripts/shot.mjs.
//
// These reproduce states that need a wallet and a real transaction to reach, so
// they can be looked at without one. Each `inject` runs in the page, so the type,
// the theme tokens and the backdrop are the app's own — only the markup is
// synthetic, and it is copied from the JSX that renders it for real.
const EXTERNAL_LINK =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

const billLive = `
<section class="bill-poster bill-live">
  <div class="bill-poster-head">
    <span class="settle-label" data-tone="ok">Committed</span>
    <div class="bill-poster-marks">
      <span class="bill-poster-fact">Arc Testnet</span>
      <a class="iou-row-tx" href="#">0x8f2c…41ab${EXTERNAL_LINK}</a>
    </div>
  </div>
  <div class="bill-poster-body">
    <div class="bill-live-lede">
      <h3 class="bill-display bill-live-title">Bill <b>#51</b> is live</h3>
      <span class="settlement-stamp bill-live-stamp">On Arc</span>
    </div>
    <p class="bill-poster-note">Signed from your own wallet. Each payer settles their own share straight into the bill, and you claim what arrives.</p>
    <div class="bill-cell bill-live-link">
      <span class="settle-label">Anyone with this link can pay</span>
      <div class="bill-live-link-row">
        <a class="bill-live-url" href="#">http://localhost:3001/pay/6zQHv5hje0p13HRqJvU7tp</a>
        <button class="iou-provider bill-live-copy" type="button">copy</button>
      </div>
      <div class="bill-cell-rule"></div>
      <p class="bill-options-hint">Save it now — it isn't shown again anywhere. Whoever holds it can cover any payer's share without signing in.</p>
    </div>
  </div>
</section>`;

const verify = (tone, lines) => `
<div class="doc-note bill-verify" data-tone="${tone}">
  <p class="settle-label">${lines.title}</p>
  ${lines.body}
  <div class="bill-verify-tools">
    <button class="iou-provider bill-verify-toggle" type="button">the receipt on chain</button>
    <button class="iou-provider bill-verify-toggle" type="button">what does this mean</button>
  </div>
  <div class="bill-verify-detail">
    <p><b>1. Genuine bill on Arc.</b> When this bill was created, Splitsy wrote a tamper-proof fingerprint of its details onto the Arc blockchain, where it can't be edited.</p>
    <p><b>2. Total matches the receipt.</b> The receipt image is committed too, so your browser re-read it and confirmed its total matches what you're being charged.</p>
    <p class="bill-verify-hash">0x9a3f77c1be04d2e8a6512cf0b73d9184ee25ac60f1b8d47a903e2c5187fb6d0a</p>
  </div>
</div>`;

const flowStep = (n, label, state, hint, tx) => `
<li class="flow-step" data-state="${state}">
  <div class="flow-step-line">
    <span class="settle-label">${n} · ${label}</span>
    ${tx ? `<a class="iou-row-tx" href="#">transaction${EXTERNAL_LINK}</a>` : ""}
  </div>
  <p class="flow-step-hint">${hint}</p>
  <div class="flow-step-rule"></div>
</li>`;

const flow = (status, title, sub, steps, foot, tone) => `
<div class="flow-backdrop"></div>
<div class="flow-panel" data-status="${status}">
  <div class="flow-head">
    <div class="bill-poster-head">
      <span class="settle-label">bill #51</span>
      ${status === "running" ? "" : '<button class="iou-provider" type="button">close</button>'}
    </div>
    <h2 class="flow-title" data-status="${status}">${title}</h2>
    <p class="bill-poster-note">${sub}</p>
  </div>
  <ol class="flow-steps">${steps}</ol>
  <div class="bill-poster-foot flow-foot">
    <p class="bill-poster-msg"${tone ? ` data-tone="${tone}"` : ""}>${foot}</p>
    ${status === "running" ? "" : '<button class="settle-action" type="button">' + (status === "success" ? "done" : "close") + " ›</button>"}
  </div>
</div>`;

// Injected as a sibling of the bills tab's first real poster, so it inherits the
// same container measure the real confirmation would — appending to <main> instead
// spans the raw viewport and misreports every max-width in the block.
const atTop = (html) => `
  const anchor = document.querySelector(".bill-poster");
  if (!anchor) return { error: "no .bill-poster to anchor to — is /app on the bills tab?" };
  const host = document.createElement("div");
  host.id = "shot-host";
  host.innerHTML = ${JSON.stringify(html)};
  anchor.parentNode.insertBefore(host, anchor);
`;

const asOverlay = (html) => `
  const host = document.createElement("div");
  host.id = "shot-host";
  host.innerHTML = ${JSON.stringify(html)};
  document.body.appendChild(host);
`;

// The wallet panel is position: fixed and anchored to a viewport corner, which the
// height-fitted screenshot below cannot frame — resizing the viewport moves the
// thing being measured. The board drops that anchoring and lays the panel's states
// out side by side, so one shot compares them.
//
// Anchored at the document origin and painted opaque, rather than appended in
// normal flow: the host route's own content would otherwise sit above the board,
// putting it thousands of pixels down a long page. The runner sizes the viewport to
// `height + top`, so that `top` became a 2880x4800 capture of mostly legal copy —
// which is where Page.captureScreenshot stalled.
const asBoard = (html) => `
  const host = document.createElement("div");
  host.id = "shot-host";
  host.style.cssText = "position:absolute;top:0;left:0;width:100%;z-index:99;background:var(--background);display:flex;flex-wrap:wrap;align-items:flex-start;gap:2rem;padding:2rem";
  host.innerHTML = ${JSON.stringify(html)};
  document.body.appendChild(host);
  host.querySelectorAll(".wallet-panel, .wallet-hail").forEach((p) => { p.style.position = "static"; });
`;

const X_MARK = '<img src="/x.png" width="13" height="13" alt="" style="display:inline-block">';
const HANDLE = `<span class="wallet-handle">${X_MARK}@ana_mfr</span>`;
const ARROW =
  '<svg class="lp-row-out" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>';
const CLOSE =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

const tabs = (active) =>
  ["wallet", "send", "receive", "history"]
    .map(
      (t) =>
        `<button class="iou-provider bill-toggle" type="button"${t === active ? ' aria-current="true"' : ""}>${t}</button>`,
    )
    .join("");

// One panel, its head and identity bands fixed, its tab body swapped. Copied from
// XAuthControl's JSX — `gate` drops the balance and tab rails the way the PIN
// gates do, since those render before a wallet can be used at all.
const panel = (active, body, gate) => `
<div class="wallet-panel">
  <div class="wallet-grip">
    <span class="settle-label">wallet</span>
    <span class="wallet-grip-end">
      <button class="iou-provider" type="button">sign out</button>
      <button class="wallet-x" type="button">${CLOSE}</button>
    </span>
  </div>
  <div class="wallet-body">
    <div class="wallet-who">
      <img class="wallet-who-avatar" src="/splitsy.png" alt="">
      <span class="wallet-who-name">${HANDLE}</span>
    </div>
    ${
      gate
        ? '<div class="wallet-band">'
        : `<div class="wallet-band">
      <div class="iou-rail"><span>balance</span><button type="button">refresh</button></div>
      <p class="wallet-figure">128.40<span class="wallet-unit">USDC</span></p>
    </div>
    <div class="wallet-tabs">${tabs(active)}</div>
    <div class="wallet-tab-body">`
    }${body}</div>
  </div>
</div>`;

const walletTab = `
  <p class="wallet-note">A Circle wallet on <b>Arc Testnet</b>, tied to ${HANDLE}. Pay and get paid in USDC — no crypto setup needed.</p>
  <div class="wallet-band">
    <div class="iou-rail"><span>address</span><button type="button">copy</button></div>
    <p class="wallet-proof">0x7bE4c1F0a92D5b83Ee61c40aF7d2B9c8153Ea6D4</p>
    <a class="settle-trigger wallet-out" href="#">add test USDC${ARROW}</a>
  </div>`;

const sendTab = `
  <div class="iou-rail"><span>send to</span><span>128.40 left</span></div>
  <div class="wallet-line" data-mono><input value="0x9F31aa07Ce4b28D6105fEc93A7b04D8e21cB6f50"></div>
  <div class="wallet-line" data-figure><input value="42.60"><span class="wallet-unit">USDC</span></div>
  <button class="settle-action" type="button">send ›</button>`;

const historyTab = `
  <div class="wallet-rows">
    <a class="lp-row" href="#"><span><span class="wallet-dir" data-in>received</span><span class="lp-row-body"> from 0x21fA…9c04 · 27/08/2026</span></span><span class="wallet-amount"><span class="wallet-dir" data-in>+18.00</span>${ARROW}</span></a>
    <a class="lp-row" href="#"><span><span class="wallet-dir">sent</span><span class="lp-row-body"> to 0x8c07…41ab · 26/08/2026</span></span><span class="wallet-amount"><span class="wallet-dir">−42.60</span>${ARROW}</span></a>
    <div class="lp-row"><span><span class="wallet-dir">sent</span><span class="lp-row-body"> to 0x4d92…7be1 · 24/08/2026</span></span><span class="wallet-amount"><span class="wallet-dir">−7.25</span></span></div>
  </div>`;

const setPinGate = `
  <p class="settle-label">choose a wallet PIN</p>
  <p class="wallet-note">Set a 4–8 digit PIN before using your wallet. You'll need it to send USDC. Enter it twice to confirm.</p>
  <div class="wallet-line" data-pin><input type="password" value="1234"></div>
  <div class="wallet-line" data-pin><input type="password" value="12"></div>
  <p class="wallet-note" data-tone="warn">The PINs don't match yet.</p>
  <button class="settle-action" type="button" disabled>set PIN ›</button>`;

// The closed state — the only part of this control most of the app ever shows.
const hail = `
<button class="wallet-hail" type="button">
  <span class="wallet-hail-word">wallet</span>
  <span class="wallet-hail-mark"><img src="/splitsy.png" alt=""></span>
</button>
<button class="wallet-hail" type="button">
  <span class="wallet-hail-word">wallet</span>
  <span class="wallet-hail-mark"><span class="wallet-initial">a</span></span>
</button>`;

export default {
  // Hosted on /disclaimer rather than /app: the panel needs nothing from the page
  // but the fonts, the theme tokens and the backdrop, and /app is a heavy wagmi
  // client whose `load` event the runner can wait on indefinitely.
  "wallet-panel": {
    url: "/disclaimer",
    selector: "#shot-host",
    inject: asBoard(panel("wallet", walletTab) + panel("send", sendTab) + panel("history", historyTab) + panel("", setPinGate, true) + hail),
  },

  "signin-email": { url: "/signin/email", selector: ".iou-page", inject: "" },

  "bill-live": { selector: ".bill-live", inject: atTop(billLive) },

  "verify-ok": {
    selector: ".bill-verify",
    inject: atTop(
      verify("ok", {
        title: "Verified on Arc · Trattoria del Ponte",
        body:
          "<p>Genuine bill on Arc — the details shown here are exactly what the creator committed, and can't have been edited since.</p>" +
          "<p>Pay by 12/09/2026 to keep your on-chain payment reputation strong.</p>" +
          "<p>Total matches the receipt (~$42.60).</p>",
      }),
    ),
  },

  "verify-warn": {
    selector: ".bill-verify",
    inject: atTop(
      verify("warn", {
        title: "Warning — the total was changed · Trattoria del Ponte",
        body:
          "<p>Genuine bill on Arc — the details shown here are exactly what the creator committed, and can't have been edited since.</p>" +
          "<p data-tone=\"warn\">Total was changed — the receipt reads about $28.10, but you're charged $42.60. Ask the creator before paying.</p>",
      }),
    ),
  },

  "flow-running": {
    selector: ".flow-panel",
    inject: asOverlay(
      flow(
        "running",
        "Settling on Arc",
        "Paying $42.60 USDC toward bill #51.",
        flowStep("01", "Connect to Arc Testnet", "done", "confirmed", false) +
          flowStep("02", "Approve USDC", "active", "Let the bill registry move your USDC", false) +
          flowStep("03", "Send payment", "pending", "Settle the debt on Arc with a memo", false),
        "Confirm each step in your wallet",
        null,
      ),
    ),
  },

  "flow-success": {
    selector: ".flow-panel",
    inject: asOverlay(
      flow(
        "success",
        "Payment settled",
        "Paid $42.60 USDC toward bill #51.",
        flowStep("01", "Connect to Arc Testnet", "done", "confirmed", false) +
          flowStep("02", "Approve USDC", "done", "confirmed", true) +
          flowStep("03", "Send payment", "done", "confirmed", true),
        "All transactions confirmed",
        "success",
      ),
    ),
  },

  "flow-error": {
    selector: ".flow-panel",
    inject: asOverlay(
      flow(
        "error",
        "Payment failed",
        "Your wallet needs more test USDC to cover this share.",
        flowStep("01", "Connect to Arc Testnet", "done", "confirmed", false) +
          flowStep("02", "Approve USDC", "done", "confirmed", true) +
          flowStep("03", "Send payment", "error", "failed", false),
        "No funds were lost",
        "error",
      ),
    ),
  },
};
