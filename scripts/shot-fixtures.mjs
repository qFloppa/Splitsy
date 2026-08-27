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

export default {
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
