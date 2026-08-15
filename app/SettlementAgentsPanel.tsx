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
// from across the room.
//
// FUNDED MODE ONLY. The agent settles out of ITS OWN balance — the one the user
// tops up on the card below — so the hard ceiling is what it holds, and the caps
// here are enforced by Splitsy before it spends rather than by a contract.
// Mandate mode, where the agent instead pulls the user's own USDC under
// AutopayMandate.sol, is still whole in the backend (lib/autopay.ts,
// app/api/agents/autopay/route.ts, the contract, the PUT that can still write
// one) — nothing in this UI routes anyone into it any more. The one mandate
// control left is the revoke in the unlink warning: a permission you can no
// longer grant must still be withdrawable by whoever already granted it.
//
// Distinct from app/AgentEconomyPanel.tsx, which is Scout's x402 nanopayment
// ledger. Same design tokens, different agents.
import { useCallback, useEffect, useState } from "react";
import { Ban, Bot, CalendarClock, Check, ChevronRight, Link2, Loader2, Plus, ShieldCheck, Wallet, X } from "lucide-react";
import { useAccount, useSignMessage } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { wagmiConfig } from "@/lib/wagmi";
import { assertReceiptSuccess } from "@/lib/bill-split-contracts";
import { ARC_USDC_ADDRESS, publicClient, usdcAbi } from "@/lib/recurring-contracts";
import { buildLinkMessage, buildSigninMessage, SESSION_ENDED_EVENT } from "@/lib/agent-link";
// Type-only, so nothing from the decision core is bundled into this client
// component — it is imported to keep REASONS below exhaustive, not to run.
import type { AutopayDecision } from "@/lib/autopay";
import { encodeRevokeMandate } from "@/lib/registry-calldata";
import JobTrail from "./JobTrail";

// ERC-8004 IdentityRegistry, for the link to the agent's identity NFT. Display
// only — nothing here signs against it.
const IDENTITY_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

// What the top-up field suggests. Enough to cover a couple of small shares plus
// the job fee and the agent's own gas, which is the smallest amount that leaves
// the agent actually able to settle something.
const DEFAULT_FUND_USDC = 2;

// Every rule, in ONE Postgres row per user (autopay_grants upserts on user_id).
// In funded mode the caps are not per-wallet: they bind the agent, and the agent
// is per account, so one set of numbers covers every wallet it settles for.
type Grant = {
  enabled: boolean;
  maxPerBillUsdc: number;
  maxPerDayUsdc: number;
  trustedCreators: string[];
  minCreatorScore: number;
  requireVerifiedHash: boolean;
  requireBillReview: boolean;
};

// The user's own agent, from /api/agents/wallet. One per ACCOUNT: the same
// agent and the same balance cover the Splitsy wallet and the linked browser
// wallet both, which is the line the card has to make unmissable.
//
// One per account is NOT one per person, though, and `otherAgent` is that gap
// made visible: signing in with a browser wallet mints an account of its own, so
// a person with both logins has two accounts and two agents. Linking is what
// merges them back to one.
type AgentWallet = {
  address: string | null;
  tokenId: string | null;
  balanceUsdc: number;
  // The connected wallet's own agent, while it is still a separate one. `enabled`
  // is that account's OWN autopay switch — not this one's — so it is the only
  // honest answer to "can software spend from the agent I cannot configure here?"
  otherAgent: { address: string; balanceUsdc: number; enabled: boolean } | null;
  // Set when the agent above is only ours because linking merged the two
  // accounts. Unlinking hands it back, which the warning has to say.
  agentFromWallet: string | null;
  jobs: {
    billId: string;
    jobId: string | null;
    jobStatus: string | null;
    feeUsdc: number;
    txHash: string | null;
    createdAt: string;
  }[];
};

type LogEntry = {
  // Part of the row's identity, not decoration: (registry, bill, debtor) is the
  // unique key in Postgres, and the bill id repeats across registries.
  registryAddress: string;
  billId: string;
  debtorAddress: string;
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash: string | null;
  createdAt: string;
  // The ERC-8183 job this decision opened. Null on a skip: no job is created
  // for a payment that never happened, so there is nothing to show.
  jobId: string | null;
  jobStatus: string | null;
  feeUsdc: number;
  // Decided by the OTHER account's agent — the one the connected browser wallet
  // signed in as. The trail merges both, so each row has to say which.
  otherAccount: boolean;
};

type MandateBill = {
  billId: string;
  creatorLabel: string;
  remainingUsdc: string;
  dueDateSeconds: number;
  authorized: boolean;
};

// What the chain says about ONE wallet's mandate. Nothing in funded mode reads
// these caps — the panel only asks "is there still a live mandate here?", to
// decide whether to offer the revoke.
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
// Every slug app/api/agents/autopay/route.ts can write. The union is
// load-bearing rather than documentation: the trail reads an UNMAPPED reason as
// the reviewer's own sentence (see `modelWrote`), so a new decideAutopay reason
// that nobody adds a line for here would be dressed up as something a model
// wrote about the user's bill. Typed against lib/autopay.ts, that fails the
// build instead.
type ReasonSlug =
  | AutopayDecision["reason"]
  // Written by the route rather than by decideAutopay: the mandate-mode
  // allowance check, the reviewer failing to reach a verdict at all, and the
  // ways a settlement can break after the rules had already passed.
  | "allowance_short"
  | "review_unavailable"
  | "agent_out_of_funds"
  | "agent_wallet_unavailable"
  | "agent_unfunded"
  | "job_failed"
  | "tx_failed";

const REASONS: Record<ReasonSlug, string> = {
  ok: "Paid",
  disabled: "Autopay is off",
  nothing_owed: "Already settled",
  over_bill_cap: "Above your per-bill cap",
  over_daily_cap: "Would breach your daily cap",
  untrusted_creator: "Creator is not on your list",
  low_creator_score: "Creator's score is below your floor",
  hash_mismatch: "Bill details did not match the chain",
  unverifiable: "No published details to verify",
  // Only reachable on a row written while the account was still in mandate mode.
  allowance_short: "The allowance you had approved ran out",
  review_unavailable: "The agent couldn't check this bill's contents, so it didn't pay",
  agent_out_of_funds: "The agent wallet is empty",
  agent_wallet_unavailable: "The agent wallet is unavailable",
  agent_unfunded: "Your agent's balance is too low — top it up and the next bill will settle",
  job_failed: "The on-chain job could not be completed, so nothing was paid",
  tx_failed: "The payment transaction failed",
};

// A reason no slug above claims can only have come from one line in the whole
// system: logSkip(verdict.reason) in app/api/agents/autopay/route.ts, where the
// bought review refused in prose. That makes "unmapped" an exact test for "a
// model wrote this about your bill", with nothing new stored to support it.
//
// Object.hasOwn, not `in`: `in` walks the prototype, so a one-sentence verdict
// that happened to read "toString" would be shown as a rule the agent applied.
const modelWrote = (reason: string) => !Object.hasOwn(REASONS, reason);

export default function SettlementAgentsPanel() {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [server, setServer] = useState<GrantsResponse | null>(null);
  const [agentWallet, setAgentWallet] = useState<AgentWallet | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [mandates, setMandates] = useState<MandateBill[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "success">("success");
  const [pendingBillId, setPendingBillId] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  // Collapsed by default: the warning matters, but a permanent wall of it above
  // the caps would train people to scroll past the one thing they must read.
  const [showUnlink, setShowUnlink] = useState(false);
  // The top-up dialog. Blank means "use the placeholder", which is why the
  // amount is parsed with a default rather than initialised to "2" — a field
  // someone cleared should not silently re-fill itself.
  const [funding, setFunding] = useState(false);
  const [fundAmount, setFundAmount] = useState("");
  const { address: connectedAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const load = useCallback(() => {
    // The connected address goes here too, and for the same reason as below: the
    // decision log spans both of this person's accounts, and the server can only
    // find the second one from the address the extension is on.
    fetch(`/api/agents/grants${connectedAddress ? `?connected=${connectedAddress}` : ""}`)
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
    // Separate for the same reason, and the only call here that CREATES
    // something: the agent wallet is made on first read, because someone has to
    // see the card before they can fund it. No signedOut handling — the grants
    // call above already answers that, and a second writer would only race it.
    //
    // The connected address is passed because the SERVER cannot see it: a wallet
    // sign-in mints an account of its own, and that account's agent is only
    // findable from the address the extension is currently on.
    fetch(`/api/agents/wallet${connectedAddress ? `?connected=${connectedAddress}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setAgentWallet(d as AgentWallet);
      })
      .catch(() => {});
  }, [connectedAddress]);

  useEffect(load, [load]);

  // Disconnecting a browser wallet — or switching it to another account — ends a
  // wallet session, and the header is what notices (app/SignInMenu.tsx: this
  // panel is only mounted on its own tab, so it cannot watch for it itself). Once
  // the cookie is gone, re-read: everything below belongs to an account nobody is
  // holding any more. GET then 401s and the signed-out card takes over, offering
  // sign-in with whatever wallet is connected now.
  useEffect(() => {
    window.addEventListener(SESSION_ENDED_EVENT, load);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, load);
  }, [load]);

  const linkedAddress = server?.linkedAddress ?? null;
  const mandateAddress = server?.mandateAddress ?? null;
  // Signed in AS a wallet. Then the linked address is the account itself, not a
  // second wallet attached to it — so there is nothing to link and, more
  // importantly, nothing to unlink: unlinking would cut the agent off from the
  // only wallet this account has.
  const walletSignin = server?.provider === "wallet";
  // The linked browser wallet's mandate, if it still has one from before funded
  // mode. The only thing read off it is `enabled` — whether there is anything
  // left to revoke.
  const linkedFacts = linkedAddress ? (server?.onchain[linkedAddress.toLowerCase()] ?? null) : null;
  // A different account is selected in the wallet extension than the one linked.
  // Revoking from it would clear some unrelated account's mandate and report
  // success, leaving the one that actually binds this user alive.
  const wrongAccount =
    !!linkedAddress && !!connectedAddress && connectedAddress.toLowerCase() !== linkedAddress.toLowerCase();

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
        // The mode is sent on every save rather than left to the server's
        // default, which is still 'mandate': this UI only knows how to describe
        // the funded agent, so it must never leave an account in the mode it
        // cannot show. Saving is also what migrates an account armed under the
        // old flow.
        body: JSON.stringify({ ...next, moneyMode: "funded" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(
          body.error === "insufficient_funds"
            ? "Your wallet needs a little test USDC to cover the gas for this."
            : (body.error ?? "Could not save your rules."),
        );
        load(); // pull the server's truth back rather than leaving a lie on screen
        return;
      }
      setMessageTone("success");
      // A tx here means one thing only: the account had a mandate from the old
      // flow on its Splitsy wallet and the save just revoked it. Nothing this
      // form holds is written to the chain any more.
      setMessage(
        body.txHash ? "Rules saved. The old mandate on your Splitsy wallet was revoked." : "Rules saved.",
      );
      if (body.txHash) load();
    } finally {
      setSaving(false);
    }
  }

  // Top up the agent. Two sources, because the two kinds of account keep their
  // money in different places: a browser wallet signs an ordinary USDC transfer
  // itself, while a social account's USDC sits in the Splitsy DCW that only the
  // server can move. Only the sources this account actually has are offered.
  //
  // Deliberately a plain transfer either way, not an approval: the agent's
  // balance IS its spending ceiling (see the note at the top of this file), so
  // funding has to mean handing over custody, not permission.
  async function fundAgent(source: "browser" | "splitsy") {
    const to = agentWallet?.address;
    if (!to) return;
    const amount = Number(fundAmount.trim() || DEFAULT_FUND_USDC);
    if (!Number.isFinite(amount) || amount <= 0) {
      fail("Enter a positive amount.");
      return;
    }

    setSaving(true);
    setMessage("");
    try {
      if (source === "browser") {
        if (!connectedAddress) return fail("Connect a browser wallet first.");
        const walletClient = await getWalletClient(wagmiConfig, { chainId: arcTestnet.id });
        const hash = await walletClient.writeContract({
          address: ARC_USDC_ADDRESS,
          abi: usdcAbi,
          functionName: "transfer",
          // Rounded to USDC's 6 decimals before BigInt, which truncates: an
          // amount like 2.0000001 would otherwise throw rather than send.
          args: [to as `0x${string}`, BigInt(Math.round(amount * 1e6))],
          account: connectedAddress,
          chain: arcTestnet,
        });
        // viem RESOLVES on a reverted transaction rather than throwing, so the
        // receipt is checked — same helper as every other write on this page.
        assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), "Funding your agent");
      } else {
        const res = await fetch("/api/wallet/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to, amount }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return fail(
            body.error === "locked"
              ? "Unlock your Splitsy wallet with your PIN first — open it from the button at the bottom right."
              : body.error === "insufficient_funds"
                ? "Your Splitsy wallet doesn't hold that much USDC."
                : (body.error ?? "Could not fund your agent."),
          );
        }
      }
      setFunding(false);
      setFundAmount("");
      setMessageTone("success");
      setMessage(`Sent ${amount} USDC to your agent. The balance updates once it lands.`);
      load();
      // The balance is read from the chain server-side, which trails the receipt
      // by a block or two — one delayed re-read saves a manual refresh.
      setTimeout(load, 5000);
    } catch (err) {
      fail(err instanceof Error ? err.message : "The transfer was not completed.");
    } finally {
      setSaving(false);
    }
  }

  // An account from a signature, for someone who has a browser wallet and no
  // social login. Needed because everything on this page hangs off an account:
  // the agent's own wallet, the caps, the log. The wallet alone had nowhere to
  // put them, which is why this tab used to be a dead end for wallet-only users.
  async function signInWithWallet() {
    if (!connectedAddress) return;
    setSaving(true);
    try {
      const message = buildSigninMessage(connectedAddress, new Date().toISOString());
      const signature = await signMessageAsync({ message });
      const res = await fetch("/api/auth/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: connectedAddress, message, signature }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(body.error ?? "Could not sign in with that wallet.");
        return;
      }
      // Two outcomes from one route, told apart by whether there was a session to
      // keep: signed out, this signs you in; signed in socially, the account is
      // created and the cookie is left alone (see /api/auth/wallet). The server
      // decides, and `signedOut` is the same input it decided on, so the message
      // cannot disagree with what happened.
      const wasSignedOut = signedOut;
      setSignedOut(false);
      setMessageTone("success");
      setMessage(
        wasSignedOut
          ? ""
          : `${short(connectedAddress)} is signed in here now — its agent and its decisions appear above, and it has an account of its own. You are still signed in as before.`,
      );
      // This panel alone, no page reload: nothing else on screen renders a wallet
      // session differently from a signed-out one. The header's menu shows the
      // same social dropdown either way (a wallet is not a social login), the
      // floating widget stays hidden (it is the Splitsy DCW, which these accounts
      // never use), and HomeClient's `me` only gates the social-creator paths,
      // which need a DCW address a wallet account does not have.
      load();
    } catch {
      fail("You declined the signature, so nothing was created.");
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
    if (!server) return;    try {
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
      // Two accounts collapsing into one is a bigger event than a link, and the
      // agent address on screen is about to CHANGE — say which one won, or the
      // card looks like it lost the agent they funded.
      setMessage(
        body.adoptedAgent
          ? `Wallet linked, and your two agents are now one: ${short(String(body.adoptedAgent))} — that wallet's own agent, balance and all. Unlink to split them apart again.`
          : "Wallet linked. Your agent will settle bills owed by it too.",
      );
      load();
    } catch {
      fail("You declined the signature, so the wallet was not linked.");
    }
  }

  // Never gated behind the wallet-unlock cookie, matching POST /api/agents/link
  // and the settings form: TIGHTENING must never be harder than loosening.
  async function unlinkWallet() {
    setSaving(true);
    try {
      const res = await fetch("/api/agents/link", { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; returnedAgent?: string };
      if (!res.ok) return fail(data.error ?? "Could not unlink that wallet.");
      setShowUnlink(false);
      setMessageTone("success");
      // The agent address on screen changes when a merge is undone, so say which
      // one left and where it went — the alternative is someone reading their own
      // un-merge as a lost balance.
      setMessage(
        data.returnedAgent
          ? `Wallet unlinked, and the two accounts are separate again. ${short(data.returnedAgent)} went back to that wallet's account with its balance; this login is back on its own agent.`
          : linkedFacts?.enabled
            ? "Wallet unlinked. The mandate you armed on it earlier is still live until you revoke it from that wallet."
            : "Wallet unlinked. Your agent no longer settles bills owed by it.",
      );
      load();
    } finally {
      setSaving(false);
    }
  }

  // The last mandate control in this UI, and it only ever takes permission AWAY.
  // Arming is gone with the mode it belonged to; a browser wallet that was armed
  // under it still holds a live mandate plus a USDC approval, and the person who
  // signed those must be able to undo them without a block explorer.
  //
  // The residual approval is left in place, as it always was: payFor is the only
  // function that can spend it, and it reverts with NoMandate once this lands.
  async function revokeMandate() {
    if (!connectedAddress || !mandateAddress) return;
    // The mandate is keyed on msg.sender, so revoking from a different account
    // clears that account's mandate and reports success while the one binding
    // this user stays live.
    if (wrongAccount) {
      fail("Your wallet is on a different account than the one you linked. Switch back to it, or link this one.");
      return;
    }
    setSaving(true);
    try {
      const walletClient = await getWalletClient(wagmiConfig, { chainId: arcTestnet.id });
      const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
      const hash = await walletClient.sendTransaction({
        to: mandateAddress as `0x${string}`,
        data: encodeRevokeMandate(),
        account: connectedAddress,
        chain: arcTestnet,
      });
      // viem RESOLVES waitForTransactionReceipt for a reverted transaction — it
      // does not throw — so the receipt has to be checked or a revert reads as
      // success. Same helper every other browser-wallet flow here routes through.
      assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), "Revoking autopay");
      setMessageTone("success");
      setMessage("Autopay revoked on chain.");
    } catch (err) {
      fail(err instanceof Error ? err.message : "The transaction was not completed.");
    } finally {
      setSaving(false);
      load();
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
              {connectedAddress
                ? "An agent needs an account to belong to — it holds its own balance, its rules and its log. Sign the message below and this wallet becomes one."
                : "Rules are tied to your account, so there is nothing to show until you sign in."}
            </p>
          </div>
        </div>
        <div className="spec-body space-y-3">
          {message ? <div className={`message ${messageTone === "error" ? "message-error" : "message-neutral"}`}>{message}</div> : null}
          <div className="spec-empty">
            <ShieldCheck size={22} />
            <span>
              <strong>No agent can spend on your behalf.</strong>
              <br />
              {connectedAddress
                ? "Signing costs nothing and moves nothing — it only proves the wallet is yours. Your agent gets its own balance, which you fund separately."
                : "Sign in to set the caps and checks your settlement agents run under. Until you do, no permission exists to revoke."}
            </span>
          </div>
          {/* The whole point of this change: a browser wallet is an identity
              here, not just an address someone else's account can point at. */}
          {connectedAddress ? (
            <button className="primary-button" disabled={saving} onClick={signInWithWallet} type="button">
              {saving ? <Loader2 className="animate-spin" size={13} /> : <Wallet size={13} />}
              Sign in with {short(connectedAddress)}
            </button>
          ) : null}
        </div>
      </section>
    );
  }
  if (!grant) return null;

  const grantedCount = mandates.filter((m) => m.authorized).length;
  // "Can software spend for me right now?" In funded mode the answer is this one
  // row — there is no per-wallet mandate to disagree with it, and GET reads it
  // back from the same row rather than from the chain.
  const armed = grant.enabled;
  // Left over from the mandate flow on the linked wallet, and revocable below.
  const staleMandate = linkedFacts?.enabled ?? false;
  // The trail actually holds another account's decisions. Read off the ROWS, not
  // off `otherAgent`: linking merges the accounts, and the rows written before it
  // stay under the account that wrote them, so a merged trail outlives the second
  // agent it came from.
  const mergedTrail = log.some((entry) => entry.otherAccount);
  // The wallet the extension is on RIGHT NOW, when it is none of the three the
  // card already accounts for: not this session's own, not the linked one, and not
  // one whose agent is on screen.
  //
  // This is the state switching wallets in Rabby lands in, and it used to render as
  // nothing at all: an agent row on screen a second ago simply disappeared, with no
  // way to tell whether the agent had gone or the wallet had.
  //
  // Deliberately does NOT distinguish "has no account" from "has one this browser
  // cannot prove", because the server will not say which without a signature — that
  // is what stops an address alone from revealing someone's agent. One button
  // covers both states, since one signature resolves both.
  const unprovenWallet =
    !walletSignin &&
    !agentWallet?.otherAgent &&
    connectedAddress &&
    connectedAddress.toLowerCase() !== (linkedAddress ?? "").toLowerCase()
      ? connectedAddress
      : null;

  return (
    <div className="space-y-4">
      {saving || message ? (
        <div className={`message ${messageTone === "error" ? "message-error" : "message-neutral"}`}>
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="animate-spin" size={13} />
              {/* Same busy flag drives both, so the word has to follow what is
                  actually in flight — "Saving your rules" over a transfer is a
                  lie about where the money is. */}
              {funding ? "Sending to your agent…" : "Saving your rules…"}
            </span>
          ) : (
            message
          )}
        </div>
      ) : null}

      {/* ── Top-up dialog ── The agent's balance is its spending ceiling, so
          this is the one control on the page that RAISES what software can
          spend. It says the amount and the destination in one screen and does
          nothing else. */}
      {funding && agentWallet?.address ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
          onClick={() => (saving ? null : setFunding(false))}
        >
          <div
            className="w-full max-w-sm rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold">Fund your agent</h3>
                <p className="spec-hint">
                  Goes to{" "}
                  <span className="mono">{short(agentWallet.address)}</span> — your agent&rsquo;s own wallet. It can
                  never spend more than it holds.
                </p>
              </div>
              <button
                aria-label="Close"
                className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
                disabled={saving}
                onClick={() => setFunding(false)}
                type="button"
              >
                <X size={16} />
              </button>
            </div>

            {/* Repeated inside the dialog: the page-level banner sits behind
                this overlay, so a rejected transfer would fail silently. */}
            {message && messageTone === "error" ? (
              <div className="message message-error mt-3">{message}</div>
            ) : null}

            <label className="mt-4 block">
              <span className="spec-label">Amount</span>
              <span className="spec-input-wrap">
                <input
                  autoFocus
                  className="spec-input"
                  min={0}
                  onChange={(e) => setFundAmount(e.target.value)}
                  placeholder={String(DEFAULT_FUND_USDC)}
                  step="0.01"
                  type="number"
                  value={fundAmount}
                />
                <span className="spec-input-unit">USDC</span>
              </span>
            </label>

            <div className="mt-4 flex flex-col gap-2">
              {connectedAddress ? (
                <button
                  className="primary-button justify-center"
                  disabled={saving}
                  onClick={() => fundAgent("browser")}
                  type="button"
                >
                  {saving ? <Loader2 className="animate-spin" size={13} /> : <Wallet size={13} />}
                  Send from {short(connectedAddress)}
                </button>
              ) : null}
              {/* Not offered to a wallet account: that DCW exists but they have
                  never funded it, and it is behind a PIN they never set. */}
              {!walletSignin && server?.walletAddress ? (
                <button
                  className={connectedAddress ? "secondary-button justify-center" : "primary-button justify-center"}
                  disabled={saving}
                  onClick={() => fundAgent("splitsy")}
                  type="button"
                >
                  {saving ? <Loader2 className="animate-spin" size={13} /> : <Wallet size={13} />}
                  Send from my Splitsy wallet
                </button>
              ) : null}
              {/* Always true, and the only route left if neither source is
                  available — the agent's address takes an inbound transfer from
                  anywhere. */}
              <span className="spec-hint">
                Or send USDC to{" "}
                <a
                  className="mono underline-offset-2 hover:underline"
                  href={`https://testnet.arcscan.app/address/${agentWallet.address}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {short(agentWallet.address)}
                </a>{" "}
                from any wallet.
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── 01. Autopay rules ── */}
      <section className={`spec-card ${armed ? "spec-card-live" : ""}`}>
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-step">01 · Debtor side</span>
            <h3 className="spec-title">Autopay my share</h3>
            {/* Says whose money moves, in the first sentence. The agent spends
                what YOU sent it and nothing else — no allowance on your wallet,
                so the balance below is the hard ceiling and the rules under it
                are the soft ones Splitsy applies first. */}
            <p className="spec-note">
              When someone bills you, your agent settles your share out of <strong>its own balance</strong> — the one you
              fund below. It can never spend more than it holds, and every rule here is a ceiling checked before it
              pays, never a target.
            </p>
          </div>
          {/* The chip is the state, the switch is the control — no second
              "On/Off" caption repeating what the chip already says. */}
          <div className="flex shrink-0 items-center gap-3">
            <span className={`spec-chip ${armed ? "spec-chip-live" : ""}`}>
              <span className="spec-dot" />
              {armed ? "Armed" : "Idle"}
            </span>
            <Switch
              checked={grant.enabled}
              onChange={(enabled) => save({ ...grant, enabled })}
              size="lg"
              srLabel="Autopay my share"
            />
          </div>
        </div>

        <div className="spec-body space-y-4">
          {/* The agent that spends. It is the user's: they fund it, it holds
              its own balance, and its ERC-8004 identity NFT is theirs. */}
          <div className="spec-row">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <Bot size={14} /> Your agent
                {/* Which of the two is live, said on the row itself. With two
                    agents on screen and one set of rules under them, "which one
                    does this page mean?" is the question the card must answer
                    before anything else on it can be trusted. */}
                {agentWallet?.otherAgent ? <span className="spec-badge">in use here</span> : null}
              </span>
              <span className="spec-hint">
                {agentWallet?.address ? (
                  <>
                    <a
                      className="mono underline-offset-2 hover:underline"
                      href={`https://testnet.arcscan.app/address/${agentWallet.address}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {short(agentWallet.address)}
                    </a>
                    {agentWallet.tokenId ? (
                      <>
                        {" · "}
                        <a
                          className="underline-offset-2 hover:underline"
                          href={`https://testnet.arcscan.app/token/${IDENTITY_REGISTRY_ADDRESS}/instance/${agentWallet.tokenId}`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          identity #{agentWallet.tokenId}
                        </a>
                      </>
                    ) : null}
                  </>
                ) : (
                  "No agent yet — it is created the first time this page loads with Circle configured."
                )}
              </span>
              {/* Said plainly, because the alternative is someone funding twice
                  looking for a second agent that does not exist — or, when there
                  really are two, funding the one that is about to be replaced. */}
              <span className="spec-hint">
                {agentWallet?.otherAgent
                  ? "This one belongs to the login you are in now. You have a second below, because you have two logins."
                  : "One agent covers both your Splitsy wallet and your linked browser wallet. Fund it once."}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="mono text-sm font-semibold">{(agentWallet?.balanceUsdc ?? 0).toFixed(2)} USDC</span>
              {agentWallet?.address ? (
                <button className="primary-button" disabled={saving} onClick={() => setFunding(true)} type="button">
                  <Plus size={13} /> Fund
                </button>
              ) : null}
              {/* The one thing a new user has to do, said where the number is:
                  an empty agent settles nothing, and the log's 'agent_unfunded'
                  row is a worse place to learn that. */}
              <span className="spec-hint">
                {(agentWallet?.balanceUsdc ?? 0) > 0
                  ? "The share, the job fee and its gas all come out of this."
                  : "Nothing settles until you fund it — the fee and gas come out of the same balance."}
              </span>
            </div>
          </div>

          {/* ── The SECOND agent ── Shown only when one exists, which means the
              person signed in with this browser wallet before adding the login
              they are using now: that sign-in minted an account of its own, and
              an account gets an agent. Both hold real balances and neither can
              spend the other's, so hiding one is how USDC ends up in an agent
              nobody can find. Linking below is what merges them. */}
          {agentWallet?.otherAgent ? (
            <div className="spec-row flex-col items-start gap-2">
              <div className="flex w-full flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                    <Bot size={14} /> Your other agent
                    {/* That account's OWN switch, and the reason this row is not
                        trivia: it can be spending while every control on this page
                        belongs to the other login. */}
                    <span className={`spec-chip ${agentWallet.otherAgent.enabled ? "spec-chip-live" : ""}`}>
                      <span className="spec-dot" />
                      {agentWallet.otherAgent.enabled ? "Armed" : "Idle"}
                    </span>
                  </span>
                  <span className="spec-hint">
                    <a
                      className="mono underline-offset-2 hover:underline"
                      href={`https://testnet.arcscan.app/address/${agentWallet.otherAgent.address}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {short(agentWallet.otherAgent.address)}
                    </a>
                  </span>
                  <span className="spec-hint">
                    It belongs to {short(connectedAddress ?? "")}, which signed in as an account of its own before you
                    added this login. <strong>Nothing on this page applies to it</strong> — the ceilings and checks
                    below are one row on the login you are in now, and that account keeps its own copy, which only
                    appears when you sign in with that wallet again.
                  </span>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="mono text-sm font-semibold">
                    {agentWallet.otherAgent.balanceUsdc.toFixed(2)} USDC
                  </span>
                  <span className="spec-hint">the agent above cannot spend this</span>
                </div>
              </div>
              {/* The way out, not a footnote: two agents with two sets of rules is
                  a state nobody should have to hold in their head, and linking is
                  the one action that ends it. The button is in the row below. */}
              <span className="spec-hint">
                <strong>Link {short(connectedAddress ?? "")} below</strong> and the two accounts become one:{" "}
                {short(agentWallet.otherAgent.address)} stays as your only agent, with its balance, and these rules are
                the only ones left.
              </span>
            </div>
          ) : null}

          {/* ── The connected wallet, while it is unproven ── The row above is
              keyed on the wallet the extension is on, so switching accounts in
              Rabby swaps which agent is on screen — and lands here for a wallet
              that has not signed a message in this browser. Said where the
              disappearance happened rather than left to be inferred from a button
              further down. */}
          {unprovenWallet ? (
            <div className="spec-row flex-col items-start gap-2">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                  <Bot size={14} /> {short(unprovenWallet)} isn&rsquo;t signed in here
                </span>
                {/* Does not claim the wallet HAS no agent, which this page cannot
                    know: the server will not reveal whether an address has an
                    account without that address's signature, which is exactly what
                    stops anyone reading a stranger's agent and decisions. */}
                <span className="spec-hint">
                  The wallet your extension is on now hasn&rsquo;t proved itself in this browser, so its agent
                  can&rsquo;t be shown — and if it never signed in, it has none and nothing settles its bills. An
                  agent belongs to the account of the wallet that signed in with it, which is why switching wallets
                  changes what this card shows.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* One control, and it is the one that was missing: linking has
                    its own button in the row below, and this is the only way to
                    surface THIS wallet's own agent.

                    Labelled by its OUTCOME rather than "Sign in with…", because
                    the login does not change any more — POST /api/auth/wallet
                    leaves a social session where it is. A button that says "sign
                    in" while you are already signed in reads as "sign out of
                    this", which is exactly what it used to do. */}
                <button className="secondary-button" disabled={saving} onClick={signInWithWallet} type="button">
                  {saving ? <Loader2 className="animate-spin" size={13} /> : <Wallet size={13} />}
                  Sign to show {short(unprovenWallet)}&rsquo;s agent
                </button>
              </div>
              {/* Two ways out, one signature each, no money either way — and the
                  quieter one is named second because it is the one that leaves
                  you with a single agent to think about. */}
              <span className="spec-hint">
                One signature, nothing moved: its agent, its balance and its decisions then appear beside your own,
                and it gets an account and an agent of its own if it had none. <strong>You stay signed in here.</strong>{" "}
                {linkedAddress
                  ? `To have the agent above cover this wallet instead — no second agent at all — unlink ${short(linkedAddress)} first, then link this one.`
                  : "Or link it below instead: the agent above then settles its bills too, and there is no second agent to fund."}
              </span>
            </div>
          ) : null}

          {/* Which DEBTS the agent settles, which is no longer the same question
              as which wallet it spends from — it always spends its own. A bill
              addressed to a browser wallet is only resolvable to this account
              while that wallet is linked, so linking is what widens the agent's
              reach, not what grants it money. */}
          <div className="spec-row">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <Wallet size={14} /> Bills it settles
              </span>
              <span className="spec-hint">
                {walletSignin
                  ? `Bills owed by ${short(linkedAddress ?? "")} — the wallet you signed in with — and by your Splitsy wallet. One agent, one balance, both.`
                  : linkedAddress
                    ? `Bills owed by your Splitsy wallet and by ${short(linkedAddress)}. Both are paid out of the one agent balance above.`
                    : // A second agent changes this sentence completely: bills owed
                      // by that wallet are NOT unattended, they are settled by the
                      // other agent under the other account's rules. Saying "link
                      // it and the agent covers them too" would imply nothing is
                      // spending for them today, which is the opposite of true.
                      agentWallet?.otherAgent
                      ? `Bills owed by your Splitsy wallet — those, and only those. Bills owed by ${short(connectedAddress ?? "")} are settled by the other agent above, under that account's own rules. Link it and one agent covers both, under these.`
                      : connectedAddress
                        ? `Bills owed by your Splitsy wallet. Link ${short(connectedAddress)} and the same agent covers its bills too — it stays one agent and one balance.`
                        : "Bills owed by your Splitsy wallet. Connect a browser wallet to also have the same agent cover its bills."}
              </span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {/* Three states, and the button only exists in two of them. A
                  wallet sign-in has nothing to link or unlink; a social account
                  with no wallet connected gets the sentence above instead of a
                  button that can only fail. */}
              {walletSignin ? null : linkedAddress ? (
                <button
                  className="secondary-button"
                  disabled={saving}
                  onClick={() => setShowUnlink((v) => !v)}
                  type="button"
                >
                  <X size={13} /> Unlink
                </button>
              ) : connectedAddress ? (
                <button className="secondary-button" disabled={saving} onClick={linkWallet} type="button">
                  <Link2 size={13} /> Link wallet
                </button>
              ) : null}
            </div>
          </div>

          {showUnlink && linkedAddress && !walletSignin ? (
            <div className="spec-row flex-col items-start gap-2">
              {/* Unlinking does LESS than people expect, and the gap is money —
                  for anyone who armed this wallet under the old mandate flow,
                  the standing permission is on the CHAIN and unlinking does not
                  touch it. Revoke first, then unlink, offered as that pair. */}
              <span className="text-sm font-semibold">Unlinking {short(linkedAddress)} does more than one thing</span>
              <ul className="spec-hint list-disc space-y-1 pl-4">
                <li>
                  Autopay for that wallet <strong>stops</strong> — its bills are no longer resolvable to your account.
                </li>
                {/* Two different truths, and the difference is a balance. An agent
                    this account only holds because linking merged two accounts
                    GOES BACK on unlink — the inverse of the adoption — so the
                    reassuring version of this bullet would be a lie about money. */}
                {agentWallet?.agentFromWallet ? (
                  <li>
                    Your agent <strong>goes back</strong> to being that wallet&rsquo;s own, with its balance and its
                    identity NFT: linking is what merged the two accounts, and unlinking un-merges them. This login
                    gets its own agent again — a different address, and an empty one until you fund it or link back.
                  </li>
                ) : (
                  <li>
                    Your agent, its balance and its identity NFT are <strong>untouched</strong> — they belong to your
                    account, not to that wallet.
                  </li>
                )}
                {staleMandate ? (
                  <li>
                    The mandate you armed on it earlier <strong>survives</strong>, along with its USDC approval.
                    Splitsy no longer pulls under it, but revoking is still a transaction only that wallet can send.
                  </li>
                ) : null}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                {/* Signed by the LINKED wallet itself, so it is offered only
                    while that exact account is connected and only while there is
                    something left to revoke. */}
                {staleMandate ? (
                  <button
                    className="secondary-button"
                    disabled={saving || !mandateAddress || !connectedAddress || wrongAccount}
                    onClick={revokeMandate}
                    type="button"
                  >
                    <Ban size={13} /> Revoke the old mandate first
                  </button>
                ) : null}
                <button className="secondary-button" disabled={saving} onClick={unlinkWallet} type="button">
                  <X size={13} /> {staleMandate ? "Unlink anyway" : "Unlink"}
                </button>
              </div>
            </div>
          ) : null}

          {/* ── Ceilings. Enforced HERE, before the agent spends — the chain's
              only ceiling in this mode is the agent's balance. One set per
              account, because the agent is per account. ── */}
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
                : `${grant.trustedCreators.length} address${grant.trustedCreators.length === 1 ? "" : "es"} — no one else can trigger autopay.`}
            </span>
          </label>

          {/* Said rather than implied. The ceilings above are ours to enforce
              now, so the page must not let anyone believe a contract is holding
              them — the agent's balance is the only number the chain bounds. */}
          <div className="spec-row">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <ShieldCheck size={14} /> Who holds these ceilings
              </span>
              <span className="spec-hint">
                Splitsy does. They are checked before your agent spends, not enforced by a contract — so the hard limit
                is the balance above: it can never pay out more than you have sent it.
                {agentWallet?.otherAgent
                  ? ` And they hold for ${short(agentWallet.address ?? "")} only — your other agent runs under the rules stored on its own account.`
                  : ""}
              </span>
            </div>
            <span className="shrink-0 text-right">
              <span className="trail-amount">{(agentWallet?.balanceUsdc ?? 0).toFixed(2)} USDC</span>
              <span className="spec-hint">the only ceiling the chain enforces</span>
            </span>
          </div>

          {/* ── Checks: one row per account, like everything else here. ── */}
          <div className="pt-1">
            <span className="spec-label">Checks on every payment</span>
            <span className="spec-hint">
              {agentWallet?.otherAgent
                ? `These apply to every bill ${short(agentWallet.address ?? "")} looks at, and to nothing your other agent does — one setting per account, and you currently have two.`
                : linkedAddress
                  ? "These apply to bills owed by either of your wallets — one setting on your account."
                  : "These apply to every bill your agent looks at — one setting on your account."}
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
              {/* Deliberately does not promise a line-item check: lib/autopay-review.ts
                  is given the headline fields only, and the receipt image is never sent. */}
              <span className="spec-hint">
                A model reads the bill and refuses if the numbers don&rsquo;t hang together — it weighs the merchant,
                total and your share against each other. It has no line items, so it cannot tell who ordered what.
              </span>

              {/* The one check on this page that is not a rule, so it is the one
                  that has to show its working. Every line below is a claim about
                  lib/autopay-review.ts and has to stay true to it: the field list
                  is that prompt's inputs, the two lists are its refuse/do-not-refuse
                  instructions, and "cannot answer" is FAIL_CLOSED. Nothing here may
                  promise judgment the model was not given the data to make.

                  A real <details>, like JobTrail: no state, keyboard and find-in-page
                  for free. Collapsed by default — someone who just wants the toggle
                  should not have to read an essay to reach it. */}
              <details className="job-trail">
                <summary className="spec-chip job-trail-summary">
                  <ChevronRight className="job-trail-caret" size={12} />
                  <span>how the model judges your bill · $0.002 per review</span>
                </summary>

                <div className="job-trail-body">
                  {/* Said first because it is the part nobody assumes: the verdict is
                      bought from a different wallet, so refusing costs the Settler
                      money it does not recover. */}
                  <p className="job-trail-desc">
                    Bought, not asked for. Your Settler pays the Auditor $0.002 over x402 for each verdict, out of the
                    settlement fee — two different wallets, so the one that judges the bill is not the one that gets
                    paid to settle it.
                  </p>

                  <section>
                    <h4 className="job-trail-head">what it is given</h4>
                    <span className="spec-hint">
                      The merchant, the currency, the bill total, how many people are on it, what an even split would
                      be, your share in USDC, the creator&rsquo;s reputation score, and the names on the bill.{" "}
                      <strong>Never the receipt image, and never the line items.</strong>
                    </span>
                  </section>

                  <section>
                    <h4 className="job-trail-head">it refuses when</h4>
                    <ul className="spec-hint list-disc space-y-1 pl-4">
                      <li>the total is wildly implausible for that kind of merchant</li>
                      <li>your share is more than the entire bill</li>
                      <li>your share is so far above an even split that no ordering would explain it</li>
                      <li>the names on the bill contradict how many people it says are on it</li>
                    </ul>
                  </section>

                  {/* As load-bearing as the list above it. A reviewer people believe
                      is trigger-happy gets switched off, and the prompt is explicit
                      about both of these. */}
                  <section>
                    <h4 className="job-trail-head">it will not refuse for</h4>
                    <ul className="spec-hint list-disc space-y-1 pl-4">
                      <li>a share above the even split, on its own — uneven is the point of splitting a bill</li>
                      <li>a creator with no reputation history yet</li>
                    </ul>
                  </section>

                  <section>
                    <h4 className="job-trail-head">when it cannot answer</h4>
                    <span className="spec-hint">
                      A timeout, an error, or a verdict it cannot parse is a <strong>refusal, never a payment</strong>.
                      It also runs last, after your ceilings — a bill those already stopped never costs a review.
                    </span>
                  </section>

                  <span className="spec-hint">
                    When it refuses, its own sentence is what you read in the trail below.
                  </span>
                </div>
              </details>
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
            {/* Plural once there are two agents to account for: the trail is the
                one place on this page that must never be scoped to whichever
                login you happen to be in, because a decision you cannot see is
                the only kind that matters. */}
            <h3 className="spec-title">What {mergedTrail ? "your agents" : "the agent"} decided</h3>
            <p className="spec-note">
              Every run, including the ones it declined. A skip and its reason is the proof the ceilings above are
              real. A row marked <strong>reviewer</strong> is the model&rsquo;s own sentence about that bill rather than
              a rule it matched.
              {mergedTrail
                ? " Both of your agents are here, each row marked with the one that decided it — the ceilings above bind only the first."
                : ""}
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
                  // The row's full unique key in Postgres. Bill id and debtor
                  // alone are not unique across registries, and a merged trail
                  // lists enough rows for that to actually collide.
                  key={`${entry.registryAddress}-${entry.billId}-${entry.debtorAddress}`}
                >
                  <span className="trail-mark">
                    {entry.decision === "pay" ? <Check size={11} /> : <Ban size={11} />}
                  </span>
                  <span className="min-w-0">
                    <span className="inline-flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                      Bill #{entry.billId}
                      {/* Only on the other agent's rows. Marking every row would
                          be noise; marking the ones that came from an agent whose
                          rules are not on this page is the whole point. The
                          address is the one already shown up in section 01, so
                          the two rows read as the same agent. */}
                      {entry.otherAccount ? (
                        <span className="spec-badge">
                          {agentWallet?.otherAgent ? short(agentWallet.otherAgent.address) : "your other agent"}
                        </span>
                      ) : null}
                      {/* Without this the model's sentence sits in the same slot as
                          "Above your per-bill cap" and reads as one more canned
                          string. The badge is the whole difference between a rule
                          the agent applied and a judgment it made. */}
                      {modelWrote(entry.reason) ? <span className="spec-badge">reviewer</span> : null}
                    </span>
                    {/* Quoted, because it is a quotation. The cast is safe on this
                        branch and only on it: modelWrote is the hasOwn check, so a
                        mapped slug is exactly what is left — which is also why the
                        old `?? entry.reason` fallback is gone rather than moved. */}
                    <span className="spec-hint">
                      {modelWrote(entry.reason) ? `“${entry.reason}”` : REASONS[entry.reason as ReasonSlug]}
                    </span>
                    {/* Only a payment opens a job, so this line appears on pay
                        rows alone. A skip keeps the model's own sentence above
                        and nothing else — there is no job to point at. */}
                    {entry.jobId ? (
                      <JobTrail
                        billId={entry.billId}
                        connectedAddress={connectedAddress}
                        feeUsdc={entry.feeUsdc}
                        jobId={entry.jobId}
                        jobStatus={entry.jobStatus}
                      />
                    ) : null}
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
