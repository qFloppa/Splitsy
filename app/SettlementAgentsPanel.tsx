"use client";

// The surface for the two settlement agents. Three numbered sections:
//   01. Autopay rules — the caps and checks that bind the debtor-side agent.
//   02. Collect mandates — per-bill permissions for the creditor-side agent,
//       each with a visible revoke.
//   03. The decision log — including every skip and its reason. The skips are the
//       point: they are what shows a spending mandate is still constrained.
//
// The "armed" styling on section 01 is load-bearing, not decorative: the lit
// rail and warmed header appear only while the agent is actually permitted to
// spend, so the page always answers "can software move my money right now?"
// from across the room. That answer is read from the chain, never from a local
// flag: the caps in section 01 are enforced by AutopayMandate.sol, and saving
// them signs a transaction from the user's own wallet.
//
// Distinct from app/AgentEconomyPanel.tsx, which is Scout's x402 nanopayment
// ledger. Same design tokens, different agents.
import { useCallback, useEffect, useState } from "react";
import { Ban, Bot, CalendarClock, Check, Link2, Loader2, ShieldCheck, Wallet, X } from "lucide-react";
import { useAccount, useSignMessage } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { wagmiConfig } from "@/lib/wagmi";
import { assertReceiptSuccess } from "@/lib/bill-split-contracts";
import { buildLinkMessage } from "@/lib/agent-link";
import { encodeApprove, encodeRevokeMandate, encodeSetMandate } from "@/lib/registry-calldata";

const USDC_ADDRESS = (process.env.NEXT_PUBLIC_ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

// The approval covers a week of spending at the full daily ceiling, matching
// APPROVAL_DAYS in app/api/agents/grants/route.ts. The two must agree, or the
// same caps would mean different exposure depending on which wallet signed.
const APPROVAL_DAYS = 7n;

// The ceilings that bind ONE wallet. Held by AutopayMandate.sol, keyed on the
// debtor, so a person with two wallets has two independent sets of these.
type Caps = {
  enabled: boolean;
  maxPerBillUsdc: number;
  maxPerDayUsdc: number;
  trustedCreators: string[];
};

// Caps plus the three checks the chain cannot evaluate. Those three live in ONE
// Postgres row per user (autopay_grants upserts on user_id), so they are NOT
// per-wallet however much they sit next to caps here — see the rules block in
// the markup below, which renders them once for that reason.
type Grant = Caps & {
  minCreatorScore: number;
  requireVerifiedHash: boolean;
  requireBillReview: boolean;
};

type LogEntry = {
  billId: string;
  debtorAddress: string;
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash: string | null;
  createdAt: string;
};

type MandateBill = {
  billId: string;
  creatorLabel: string;
  remainingUsdc: string;
  dueDateSeconds: number;
  authorized: boolean;
};

// What the chain says about ONE wallet, as opposed to what this form says.
// Rendered next to the caps so the two can be compared without leaving the page.
type WalletFacts = {
  agentAddress: string | null;
  enabled: boolean;
  maxPerBillUsdc: number;
  maxPerDayUsdc: number;
  trustedCreators: string[];
  allowanceUsdc: number;
  spentTodayUsdc: number;
};

// The GET response, spelled out rather than asserted. The panel used to cast
// `d.onchain` to a flat object; the route now returns a MAP and the cast said
// nothing, so every read threw at runtime while tsc stayed green.
type GrantsResponse = {
  grant: Grant;
  log: LogEntry[];
  linkedAddress: string | null;
  walletAddress: string | null;
  handle: string;
  provider: string;
  mandateAddress: string | null;
  agentAddress: string | null;
  // Keyed by LOWERCASE address. wagmi hands you a checksummed one, so always
  // lowercase before indexing — with noUncheckedIndexedAccess off, tsc will not
  // warn you that the miss types as a hit.
  onchain: Record<string, WalletFacts | undefined>;
};

// Every skip reason decideAutopay can return, in the user's words. An unmapped
// reason falls back to the raw slug rather than being hidden — a decision the
// user cannot read is worse than an ugly one.
const REASONS: Record<string, string> = {
  ok: "Paid",
  disabled: "Autopay is off",
  nothing_owed: "Already settled",
  over_bill_cap: "Above your per-bill cap",
  over_daily_cap: "Would breach your daily cap",
  untrusted_creator: "Creator is not on your list",
  low_creator_score: "Creator's score is below your floor",
  hash_mismatch: "Bill details did not match the chain",
  unverifiable: "No published details to verify",
  allowance_short: "Your approved allowance or balance ran out — press Save to top it up",
  review_unavailable: "The agent couldn't check this bill's contents, so it didn't pay",
  agent_out_of_funds: "The agent wallet is empty",
  agent_wallet_unavailable: "The agent wallet is unavailable",
  tx_failed: "The payment transaction failed",
};

export default function SettlementAgentsPanel() {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [server, setServer] = useState<GrantsResponse | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [mandates, setMandates] = useState<MandateBill[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "success">("success");
  const [pendingBillId, setPendingBillId] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const { address: connectedAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  // Which wallet the caps on this panel describe. The mandate is keyed per
  // debtor on chain, so this is a real choice, not a display preference.
  const [armingWallet, setArmingWallet] = useState<"dcw" | "browser">("dcw");
  const [agentChoice, setAgentChoice] = useState<"hosted" | "own">("hosted");
  const [ownAgent, setOwnAgent] = useState("");

  const load = useCallback(() => {
    fetch("/api/agents/grants")
      .then((r) => {
        // Rules are session-scoped, so a 401 is the normal signed-out state and
        // needs saying — on its own tab, returning nothing reads as a bug.
        setSignedOut(r.status === 401);
        return r.ok ? (r.json() as Promise<GrantsResponse>) : null;
      })
      .then((d) => {
        if (!d) return;
        setGrant(d.grant);
        setServer(d);
        setLog(d.log ?? []);
      })
      .catch(() => {});
    // Separate call because it reads the chain: a slow RPC must not delay the
    // rules form, which is pure database.
    fetch("/api/agents/mandate")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setMandates((d.mandates ?? []) as MandateBill[]);
      })
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  const linkedAddress = server?.linkedAddress ?? null;
  const mandateAddress = server?.mandateAddress ?? null;
  const agentAddress = server?.agentAddress ?? null;
  // The wallet whose on-chain mandate this panel is currently describing.
  const armedAddress = armingWallet === "browser" ? linkedAddress : (server?.walletAddress ?? null);
  const facts = armedAddress ? (server?.onchain[armedAddress.toLowerCase()] ?? null) : null;
  // A different account is selected in the wallet extension than the one linked.
  // Signing from it would set a mandate on a wallet whose rules nothing reads.
  const wrongAccount =
    armingWallet === "browser" &&
    !!linkedAddress &&
    !!connectedAddress &&
    connectedAddress.toLowerCase() !== linkedAddress.toLowerCase();

  function fail(text: string) {
    setMessageTone("error");
    setMessage(text);
  }

  async function save(next: Grant) {
    setGrant(next); // optimistic: the form must not feel like it dropped the edit
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/agents/grants", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Naming the debtor is what stops a blur from server-signing the DCW's
        // mandate while the browser card is the one on screen. It is the LINKED
        // address, never the connected one: a wallet can switch accounts under
        // us, and the route 400s an address it does not recognise rather than
        // substituting the DCW.
        body: JSON.stringify(
          armingWallet === "browser" && linkedAddress ? { ...next, debtorAddress: linkedAddress } : next,
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(
          body.error === "insufficient_funds"
            ? "Your wallet needs a little test USDC to cover the gas for signing this mandate."
            : (body.error ?? "Could not save your rules."),
        );
        load(); // pull the chain's truth back rather than leaving a lie on screen
        return;
      }
      setMessageTone("success");
      // A caps change is a transaction; a score-floor change is not. Saying
      // which happened is the difference between "we stored your preference"
      // and "the chain now enforces this". For a browser wallet the server holds
      // no key, so nothing was signed and the ceilings on chain have NOT moved —
      // say so, or the form reads as binding when it is only a draft.
      setMessage(
        body.txHash
          ? "Mandate signed on chain."
          : body.signWith === "wallet"
            ? "Rules saved. Press Arm on chain to put these ceilings on the chain."
            : "Rules saved.",
      );
      // The caps just moved on chain, so the allowance and today's spend moved
      // with them. Never show those from memory.
      if (body.txHash) load();
    } finally {
      setSaving(false);
    }
  }

  // Proof that whoever holds this session also holds the wallet. The message is
  // rebuilt server-side from the session's own handle and provider, so both must
  // be passed through exactly as GET returned them.
  async function linkWallet() {
    if (!connectedAddress) {
      fail("Connect a browser wallet first.");
      return;
    }
    if (!server) return;
    try {
      const message = buildLinkMessage(connectedAddress, server.handle, server.provider, new Date().toISOString());
      const signature = await signMessageAsync({ message });
      const res = await fetch("/api/agents/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: connectedAddress, message, signature }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(body.error ?? "Could not link that wallet.");
        return;
      }
      setMessageTone("success");
      setMessage("Wallet linked. You can now arm autopay from it.");
      load();
    } catch {
      fail("You declined the signature, so the wallet was not linked.");
    }
  }

  // Two transactions, because an EOA has no executeBatch. setMandate FIRST, the
  // reverse of the DCW batch, and deliberately:
  //   * setMandate alone -> payFor reverts inside safeTransferFrom. No money moves.
  //   * lowering caps -> the tighter ceiling binds before the allowance is topped up.
  //   * raising caps -> the old allowance still bounds exposure until approve lands.
  // Approve-first would instead open a window with a fresh allowance under the
  // old, looser caps.
  async function armOnChain(next: Grant, revoke = false) {
    if (!connectedAddress || !mandateAddress) return;
    // The mandate is keyed on msg.sender, so signing from a different account
    // than the linked one arms a wallet whose rules and log nothing reads. Refuse
    // rather than write a mandate that quietly does nothing.
    if (wrongAccount) {
      fail("Your wallet is on a different account than the one you linked. Switch back to it, or link this one.");
      return;
    }
    setSaving(true);
    try {
      const walletClient = await getWalletClient(wagmiConfig, { chainId: arcTestnet.id });
      const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
      const account = connectedAddress;
      // viem RESOLVES waitForTransactionReceipt for a reverted transaction — it
      // does not throw — so the receipt has to be checked or a revert reads as
      // success. assertReceiptSuccess is the same helper every other browser-
      // wallet flow in this app routes through (lib/bill-split-contracts.ts).
      // Throwing here is also what makes the ordering argument above real: a
      // reverted setMandate must not fall through to approve, or the old, looser
      // mandate ends up with a freshly topped-up allowance.
      const send = async (to: `0x${string}`, data: `0x${string}`, action: string) => {
        const hash = await walletClient.sendTransaction({ to, data, account, chain: arcTestnet });
        assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), action);
        return hash;
      };

      if (revoke) {
        // One transaction, matching the DCW path. The residual approval is inert:
        // payFor is the only function that can spend it, and it now reverts with
        // NoMandate.
        await send(mandateAddress as `0x${string}`, encodeRevokeMandate(), "Revoking autopay");
      } else {
        const agent = agentChoice === "own" ? ownAgent.trim() : (agentAddress ?? "");
        if (!/^0x[a-fA-F0-9]{40}$/.test(agent)) {
          // Two unrelated failures behind one regex. Telling someone who chose
          // Splitsy's agent to "enter an address" points them at a field they
          // never filled in and cannot fill in without changing their answer.
          fail(
            agentChoice === "own"
              ? "Enter the address of the agent wallet that may spend for you."
              : "Splitsy's agent wallet isn't available right now, so there is no address to name in the mandate. Reload the page, or point this at your own agent wallet.",
          );
          return;
        }
        const creators = next.trustedCreators.map((a) => a as `0x${string}`);
        const maxPerBill = BigInt(Math.round(next.maxPerBillUsdc * 1_000_000));
        const maxPerDay = BigInt(Math.round(next.maxPerDayUsdc * 1_000_000));
        await send(
          mandateAddress as `0x${string}`,
          encodeSetMandate(agent as `0x${string}`, maxPerBill, maxPerDay, creators),
          "Setting your mandate",
        );
        await send(
          USDC_ADDRESS,
          encodeApprove(mandateAddress as `0x${string}`, maxPerDay * APPROVAL_DAYS),
          "Approving the allowance",
        );
      }
      setMessageTone("success");
      setMessage(revoke ? "Autopay revoked on chain." : "Mandate armed on chain.");
    } catch (err) {
      fail(err instanceof Error ? err.message : "The transaction was not completed.");
    } finally {
      setSaving(false);
      // In `finally`, not on the success path alone: this is two transactions, so
      // a rejected `approve` still leaves a LIVE mandate from the first one. Not
      // refetching there would keep pre-arm facts on screen under an error banner,
      // hiding the half that took.
      load();
    }
  }

  // Switching wallets must switch the NUMBERS too. `grant`'s caps come from the
  // DCW's mandate, so leaving them on screen under the browser card would show
  // one wallet's ceilings while claiming to describe another. An unarmed wallet
  // has no ceilings of its own, so the draft stays — there is nothing truer to
  // show it.
  //
  // `enabled` is deliberately NOT reseeded. It is the answer to "can software
  // move my money right now?", and the browser branch already reads it straight
  // from `facts.enabled`. Copying an armed browser wallet's `true` into the form
  // would leave it there when you switch back to an unarmed DCW, lighting the
  // rail and checking the Switch for a wallet holding no mandate — the one thing
  // the note at the top of this file says the styling must never do.
  function selectWallet(which: "dcw" | "browser") {
    setArmingWallet(which);
    const address = which === "browser" ? linkedAddress : server?.walletAddress;
    const next = address ? server?.onchain[address.toLowerCase()] : null;
    if (grant && next?.enabled) {
      setGrant({
        ...grant,
        maxPerBillUsdc: next.maxPerBillUsdc,
        maxPerDayUsdc: next.maxPerDayUsdc,
        trustedCreators: next.trustedCreators,
      });
    }
  }

  async function toggleMandate(billId: string, authorized: boolean) {
    setPendingBillId(billId);
    setMessage("");
    try {
      const res = await fetch("/api/agents/mandate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billId, authorized }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(
          body.error === "insufficient_funds"
            ? "Your wallet needs a little test USDC to cover the gas for this."
            : (body.error ?? "Could not update the mandate."),
        );
        return;
      }
      // Re-read rather than flipping locally: the mandate lives on chain, and
      // showing a permission state we have not confirmed is the one thing this
      // section must never do.
      load();
    } catch (err) {
      fail(err instanceof Error ? err.message : "Could not update the mandate.");
    } finally {
      setPendingBillId(null);
    }
  }

  if (signedOut) {
    return (
      <section className="spec-card">
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-kicker">
              <span className="spec-icon">
                <ShieldCheck size={15} />
              </span>
              <span className="spec-step">Signed out</span>
            </span>
            <h3 className="spec-title">Nothing is authorized</h3>
            <p className="spec-note">
              Rules are tied to your account, so there is nothing to show until you sign in.
            </p>
          </div>
        </div>
        <div className="spec-body">
          <div className="spec-empty">
            <ShieldCheck size={22} />
            <span>
              <strong>No agent can spend on your behalf.</strong>
              <br />
              Sign in to set the caps and checks your settlement agents run under. Until you do, no permission exists to
              revoke.
            </span>
          </div>
        </div>
      </section>
    );
  }
  if (!grant) return null;

  const grantedCount = mandates.filter((m) => m.authorized).length;
  const browser = armingWallet === "browser";
  // "Can software move my money from THIS wallet right now?" — read from the
  // selected wallet's own mandate, never from the form. grant.enabled describes
  // the Splitsy wallet only, so a browser card showing it would answer for the
  // wrong wallet.
  const armed = browser ? (facts?.enabled ?? false) : grant.enabled;

  return (
    <div className="space-y-4">
      {saving || message ? (
        <div className={`message ${messageTone === "error" ? "message-error" : "message-neutral"}`}>
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="animate-spin" size={13} /> Saving your rules…
            </span>
          ) : (
            message
          )}
        </div>
      ) : null}

      {/* ── 01. Autopay rules ── */}
      <section className={`spec-card ${armed ? "spec-card-live" : ""}`}>
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-step">01 · Debtor side</span>
            <h3 className="spec-title">Autopay my share</h3>
            {/* The old copy said the agent paid "from its own wallet". It does
                not any more, and the difference is the entire security story:
                the agent moves YOUR money, under a mandate a contract enforces,
                which is why the ceilings below are worth reading. */}
            <p className="spec-note">
              When someone bills you, the agent pays from <strong>your</strong> wallet — but only inside the ceilings
              below, and those ceilings are held by a contract, not by us. Every rule is a ceiling, never a target.
            </p>
          </div>
          {/* The chip is the state, the switch is the control — no second
              "On/Off" caption repeating what the chip already says. The switch
              is offered for the Splitsy wallet alone: we hold its key, so a flip
              can sign. A browser wallet arms itself, below. */}
          <div className="flex shrink-0 items-center gap-3">
            <span className={`spec-chip ${armed ? "spec-chip-live" : ""}`}>
              <span className="spec-dot" />
              {armed ? "Armed" : "Idle"}
            </span>
            {browser ? null : (
              <Switch
                checked={grant.enabled}
                onChange={(enabled) => save({ ...grant, enabled })}
                size="lg"
                srLabel="Autopay my share"
              />
            )}
          </div>
        </div>

        <div className="spec-body space-y-4">
          {/* Which wallet these ceilings bind. The mandate is keyed per debtor on
              chain, so both wallets can be armed at once with different numbers —
              this picks which one you are looking at and editing. */}
          <div className="spec-row">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <Wallet size={14} /> Pay from
              </span>
              <span className="spec-hint">
                {!linkedAddress
                  ? "Link your browser wallet to arm autopay from it"
                  : browser
                    ? `Your own wallet ${short(linkedAddress)}. Splitsy holds no key for it, so you sign its mandate yourself.`
                    : "Your Splitsy wallet. Ceiling changes are signed for you as you save."}
              </span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <div className="segmented-control text-xs" role="group" aria-label="Wallet to arm">
                <button
                  className={`tab-button ${browser ? "" : "tab-button-active"}`}
                  onClick={() => selectWallet("dcw")}
                  type="button"
                >
                  Splitsy wallet
                </button>
                <button
                  className={`tab-button ${browser ? "tab-button-active" : ""}`}
                  disabled={!linkedAddress}
                  onClick={() => selectWallet("browser")}
                  type="button"
                >
                  Browser wallet
                </button>
              </div>
              {linkedAddress ? null : (
                <button className="secondary-button" disabled={saving} onClick={linkWallet} type="button">
                  <Link2 size={13} /> Link wallet
                </button>
              )}
            </div>
          </div>

          {/* Who may spend under the mandate. One address, straight into
              setMandate's first argument — no server logic, and no reason to
              force everyone onto our agent. */}
          <div className="spec-row">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <Bot size={14} /> Agent
              </span>
              <span className="spec-hint">
                {agentChoice === "own"
                  ? "The only address that may call payFor under this mandate."
                  : `Splitsy's hosted agent${agentAddress ? ` (${short(agentAddress)})` : ""}. It can spend only inside the ceilings below.`}
              </span>
            </div>
            <div className="segmented-control shrink-0 text-xs" role="group" aria-label="Agent wallet">
              <button
                className={`tab-button ${agentChoice === "own" ? "" : "tab-button-active"}`}
                onClick={() => setAgentChoice("hosted")}
                type="button"
              >
                Splitsy&rsquo;s agent
              </button>
              <button
                className={`tab-button ${agentChoice === "own" ? "tab-button-active" : ""}`}
                onClick={() => setAgentChoice("own")}
                type="button"
              >
                My own agent wallet
              </button>
            </div>
          </div>

          {agentChoice === "own" ? (
            <label className="block">
              <span className="spec-label">Agent wallet address</span>
              <input
                className="spec-input"
                onChange={(e) => setOwnAgent(e.target.value)}
                placeholder="0x…"
                type="text"
                value={ownAgent}
              />
              {/* A silent failure needs a sentence, because it cannot produce a
                  log row: nothing calls payFor, so nothing is ever decided. */}
              <span className="spec-hint">
                This must be a wallet you control. Naming an address you don&rsquo;t control switches autopay off
                silently — nothing can call <span className="mono">payFor</span>, so no payment happens and nothing is
                logged.
              </span>
            </label>
          ) : null}

          {/* ── Ceilings: PER WALLET. These four are the mandate, and the mandate
              is keyed on the debtor, so they describe the wallet selected above
              and nothing else. ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="spec-label">Ceiling per bill</span>
              <span className="spec-input-wrap">
                <input
                  className="spec-input"
                  min={0}
                  onBlur={() => save(grant)}
                  onChange={(e) => setGrant({ ...grant, maxPerBillUsdc: Number(e.target.value) })}
                  step="0.01"
                  type="number"
                  value={grant.maxPerBillUsdc}
                />
                <span className="spec-input-unit">USDC</span>
              </span>
            </label>
            <label>
              <span className="spec-label">Ceiling per day</span>
              <span className="spec-input-wrap">
                <input
                  className="spec-input"
                  min={0}
                  onBlur={() => save(grant)}
                  onChange={(e) => setGrant({ ...grant, maxPerDayUsdc: Number(e.target.value) })}
                  step="0.01"
                  type="number"
                  value={grant.maxPerDayUsdc}
                />
                <span className="spec-input-unit">USDC</span>
              </span>
            </label>
          </div>

          <label className="block">
            <span className="spec-label">Allowed creators</span>
            <textarea
              className="spec-textarea"
              onBlur={() => save(grant)}
              onChange={(e) =>
                setGrant({
                  ...grant,
                  trustedCreators: e.target.value.split("\n").map((a) => a.trim()).filter(Boolean),
                })
              }
              placeholder="0x…  (one address per line)"
              rows={2}
              value={grant.trustedCreators.join("\n")}
            />
            <span className="spec-hint">
              {grant.trustedCreators.length === 0
                ? "Empty means any creator can trigger autopay, within the ceilings above. Up to 10 addresses."
                : `${grant.trustedCreators.length} address${grant.trustedCreators.length === 1 ? "" : "es"}, stored on chain — no one else can trigger autopay.`}
            </span>
          </label>

          {/* The browser wallet's chain half. The server holds no key for it, so
              nothing above has reached the chain until this is pressed — and the
              button says which numbers it is about to commit. */}
          {browser ? (
            <div className="spec-row">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                  <Wallet size={14} /> Sign the mandate yourself
                </span>
                <span className="spec-hint">
                  {!mandateAddress
                    ? "Autopay isn't configured in this deployment, so there is no mandate contract to sign against."
                    : !connectedAddress
                      ? "Connect your wallet to sign."
                      : wrongAccount
                        ? `Your wallet is on ${short(connectedAddress)}, but ${short(linkedAddress ?? "")} is the linked one. Switch accounts, or link this one.`
                        : "Two transactions: the ceilings first, then the allowance that funds them. Approving the first alone can never move money."}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  className="primary-button"
                  disabled={saving || !mandateAddress || !connectedAddress || wrongAccount}
                  onClick={() => armOnChain(grant)}
                  type="button"
                >
                  {saving ? <Loader2 className="animate-spin" size={13} /> : <ShieldCheck size={13} />} Arm on chain
                </button>
                <button
                  className="secondary-button"
                  disabled={saving || !mandateAddress || !connectedAddress || wrongAccount || !facts?.enabled}
                  onClick={() => armOnChain(grant, true)}
                  type="button"
                >
                  <X size={13} /> Revoke
                </button>
              </div>
            </div>
          ) : null}

          {/* The proof, not a reassurance. Everything here is read back off the
              chain after the mandate is signed, so a claim in the copy above
              that the contract does not actually hold shows up as a mismatch
              right underneath it. */}
          {mandateAddress && facts?.enabled ? (
            <div className="spec-row spec-row-on">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                  <Link2 size={14} /> Enforced on chain
                </span>
                <span className="spec-hint">
                  The ceilings above are held by{" "}
                  <a
                    className="underline underline-offset-2"
                    href={`https://testnet.arcscan.app/address/${mandateAddress}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    a contract
                  </a>
                  , not by this app. Anyone can call it; only{" "}
                  <span className="mono">{facts.agentAddress ? short(facts.agentAddress) : "the named agent"}</span>{" "}
                  can spend under it, and nobody can exceed these numbers.
                  {/* Both sides lowercased: the top-level address is lowercased
                      server-side, the mandate's comes back EIP-55 checksummed, so
                      === would say "no" for a live Splitsy mandate. */}
                  {facts.agentAddress && agentAddress && facts.agentAddress.toLowerCase() !== agentAddress
                    ? " It is not Splitsy's agent — you named this one yourself."
                    : ""}
                </span>
              </div>
              <span className="shrink-0 text-right">
                <span className="trail-amount">{facts.allowanceUsdc.toFixed(2)} USDC</span>
                {/* The one bound that is not in the form: the total this mandate
                    may ever pull from you. It runs down as the agent spends and
                    is topped back up whenever you save a change. */}
                <span className="spec-hint">approved in total · {facts.spentTodayUsdc.toFixed(2)} spent today</span>
              </span>
            </div>
          ) : null}

          {/* ── Checks: PER USER, not per wallet. autopay_grants upserts on
              user_id, so these three live in ONE row and bind every wallet you
              arm. Rendering them inside a per-wallet card would be a lie: moving
              the score floor here also moves the floor gating the other wallet's
              payments. Rendered once, under their own heading, saying so. ── */}
          <div className="pt-1">
            <span className="spec-label">Checks on every payment</span>
            <span className="spec-hint">
              {linkedAddress
                ? "These apply to both your wallets — they are one setting on your account, not per wallet."
                : "These apply to every wallet you arm — they are one setting on your account, not per wallet."}
            </span>
          </div>

          <label className="block">
            <span className="spec-label">Creator score floor</span>
            <span className="spec-input-wrap">
              <input
                className="spec-input"
                max={100}
                min={0}
                onBlur={() => save(grant)}
                onChange={(e) => setGrant({ ...grant, minCreatorScore: Number(e.target.value) })}
                step={1}
                type="number"
                value={grant.minCreatorScore}
              />
              <span className="spec-input-unit">{grant.minCreatorScore === 0 ? "OFF" : "/ 100"}</span>
            </span>
            {/* Stated plainly because it is the one rule that fails open. */}
            <span className="spec-hint">A creator with no history yet still passes — no history is not a bad score.</span>
          </label>

          <div className={`spec-row ${grant.requireVerifiedHash ? "spec-row-on" : ""}`}>
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <ShieldCheck size={14} /> Only pay verified bills
              </span>
              <span className="spec-hint">
                The merchant, total and split must match what the creator committed on chain. Turn this off and the
                agent will pay bills it cannot check.
              </span>
            </div>
            <Switch
              checked={grant.requireVerifiedHash}
              onChange={(requireVerifiedHash) => save({ ...grant, requireVerifiedHash })}
              srLabel="Only pay verified bills"
            />
          </div>

          {/* Distinct from the hash check above, and worth its own row: that one
              proves the details match what was committed, this one asks whether
              the details are reasonable. A verified bill can still charge you for
              four mains you did not eat. */}
          <div className={`spec-row ${grant.requireBillReview ? "spec-row-on" : ""}`}>
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <ShieldCheck size={14} /> Check the bill&rsquo;s contents before paying
              </span>
              <span className="spec-hint">
                The agent reads the receipt and refuses if your share doesn&rsquo;t match what&rsquo;s on it.
              </span>
            </div>
            <Switch
              checked={grant.requireBillReview}
              onChange={(requireBillReview) => save({ ...grant, requireBillReview })}
              srLabel="Check the bill's contents before paying"
            />
          </div>
        </div>
      </section>

      {/* ── 02. Collect mandates ── */}
      <section className="spec-card">
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-step">02 · Creditor side</span>
            <h3 className="spec-title">Let creators collect after the due date</h3>
            {/* A consent UI that hides its scope is the actual security bug in
                this feature, so the scope is spelled out per bill below, not
                once in a footnote. */}
            <p className="spec-note">
              Granting this is per bill and you can withdraw it at any time. It never lets anyone take more than your
              remaining share, and never before the due date.
            </p>
          </div>
          {mandates.length > 0 ? (
            <span className={`spec-chip ${grantedCount > 0 ? "spec-chip-live" : ""}`}>
              <span className="spec-dot" />
              {grantedCount} of {mandates.length} granted
            </span>
          ) : null}
        </div>

        <div className="spec-body">
          {mandates.length === 0 ? (
            <div className="spec-empty">
              <CalendarClock size={22} />
              <span>
                <strong>No bills with a due date.</strong>
                <br />
                A mandate only makes sense once there is a deadline to collect after, so bills appear here as soon as
                one has a due date.
              </span>
            </div>
          ) : (
            <ul className="space-y-2">
              {mandates.map((bill) => (
                <li className={`spec-row ${bill.authorized ? "spec-row-on" : ""}`} key={bill.billId}>
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="spec-badge">#{bill.billId}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{bill.creatorLabel}</div>
                      <div className="spec-hint">
                        After {formatDue(bill.dueDateSeconds)}, can pull up to{" "}
                        <span className="mono font-semibold">{bill.remainingUsdc} USDC</span> — your remaining share —
                        from your approved balance.
                      </div>
                    </div>
                  </div>
                  <button
                    className={bill.authorized ? "secondary-button" : "primary-button"}
                    disabled={pendingBillId === bill.billId}
                    onClick={() => toggleMandate(bill.billId, !bill.authorized)}
                    type="button"
                  >
                    {pendingBillId === bill.billId ? (
                      <Loader2 className="animate-spin" size={13} />
                    ) : bill.authorized ? (
                      <X size={13} />
                    ) : (
                      <Check size={13} />
                    )}
                    {bill.authorized ? "Revoke" : "Allow"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── 03. Decision log ── */}
      <section className="spec-card">
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-step">03 · Audit trail</span>
            <h3 className="spec-title">What the agent decided</h3>
            <p className="spec-note">
              Every run, including the ones it declined. A skip and its reason is the proof the ceilings above are
              real.
            </p>
          </div>
          {log.length > 0 ? (
            <span className="spec-chip">
              {log.length} decision{log.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        <div className="spec-body">
          {log.length === 0 ? (
            <div className="spec-empty">
              <Ban size={22} />
              <span>
                <strong>No decisions yet.</strong>
                <br />
                The first time an agent looks at one of your bills, what it decided — and why — is written here.
              </span>
            </div>
          ) : (
            <ol>
              {log.map((entry) => (
                <li
                  className={`trail-row ${entry.decision === "pay" ? "trail-done" : ""}`}
                  key={`${entry.billId}-${entry.debtorAddress}`}
                >
                  <span className="trail-mark">
                    {entry.decision === "pay" ? <Check size={11} /> : <Ban size={11} />}
                  </span>
                  <span className="min-w-0">
                    <span className="text-sm font-semibold">Bill #{entry.billId}</span>
                    <span className="spec-hint">{REASONS[entry.reason] ?? entry.reason}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="trail-amount">
                      {entry.decision === "pay" ? `${entry.amountUsdc.toFixed(2)} USDC` : "no payment"}
                    </span>
                    <span className="spec-hint">{formatWhen(entry.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

// A switch drawn from a real checkbox: the input keeps the native keyboard and
// screen-reader behaviour (space toggles, state is announced), and the track and
// knob are pure CSS off `peer-checked`. No JS state, nothing to desync.
export function Switch({
  checked,
  disabled,
  onChange,
  size = "sm",
  srLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  size?: "sm" | "lg";
  srLabel: string;
}) {
  const lg = size === "lg";
  return (
    <label
      className={`inline-flex shrink-0 select-none items-center gap-2 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        aria-label={srLabel}
        checked={checked}
        className="peer sr-only"
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        type="checkbox"
      />
      <span
        className={`relative rounded-full bg-[var(--border-strong)] shadow-inner transition-colors duration-200
          after:absolute after:rounded-full after:bg-white after:shadow-[0_1px_3px_rgba(7,20,33,0.4)]
          after:transition-transform after:duration-200 after:ease-out after:content-['']
          peer-checked:bg-[var(--accent)]
          peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2
          peer-focus-visible:outline-[var(--accent)] peer-active:after:scale-95
          ${
            lg
              ? "h-7 w-[3.1rem] after:left-[4px] after:top-[4px] after:h-5 after:w-5 peer-checked:after:translate-x-[1.4rem]"
              : "h-[22px] w-10 after:left-[3px] after:top-[3px] after:h-4 after:w-4 peer-checked:after:translate-x-[18px]"
          }`}
      />
    </label>
  );
}

function short(address: string) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}

function formatDue(seconds: number) {
  if (!seconds) return "the due date";
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatWhen(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
