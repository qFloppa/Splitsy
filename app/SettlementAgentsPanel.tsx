"use client";

// The surface for the two settlement agents. Four numbered sections, the fourth
// (Scout's x402 ledger) in app/AgentEconomyPanel.tsx:
//   01. Autopay — the agent, its balance, and the caps and checks that bind it.
//   02. Collect mandates — per-bill permissions for the creditor-side agent,
//       each with a visible revoke.
//   03. The decision log — including every skip and its reason. The skips are the
//       point: they are what shows a spending mandate is still constrained.
//
// SET AS POSTERS, not as spec cards — the same system both bills subtabs use, so
// the app reads as one product rather than five screens that shipped together.
// See "the bill poster" and "the agent poster" in globals.css, and the note at
// the top of app/SpecCard.tsx on why a tab picks one system and stays in it. The
// translation is almost all reuse: the agent's balance is a .bill-figure, its
// ceilings are .bill-cell figures you type into, and a trusted creator, a collect
// mandate and a decision are each one .bill-payer row — a headline with
// everything that qualifies it on the footnote rail underneath.
//
// The "armed" styling on section 01 is load-bearing, not decorative: the
// section's own top rule draws itself in ink only while the agent is actually
// permitted to spend, so the page always answers "can software move my money
// right now?" from across the room. The marks rail says it in words too, because
// a hairline is not a state a screen reader can read.
//
// FUNDED MODE ONLY. The agent settles out of ITS OWN balance — the one the user
// tops up in 01 — so the hard ceiling is what it holds, and the caps here are
// enforced by Splitsy before it spends rather than by a contract.
// Mandate mode, where the agent instead pulls the user's own USDC under
// AutopayMandate.sol, is still whole in the backend (lib/autopay.ts,
// app/api/agents/autopay/route.ts, the contract, the PUT that can still write
// one) — nothing in this UI routes anyone into it any more. The one mandate
// control left is the revoke in the unlink warning: a permission you can no
// longer grant must still be withdrawable by whoever already granted it.
//
// Distinct from app/AgentEconomyPanel.tsx, which is Scout's x402 nanopayment
// ledger. Same design system, different agents.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useAccount, useSignMessage } from "wagmi";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { arcWalletClient } from "@/lib/wagmi";
import { assertReceiptSuccess } from "@/lib/bill-split-contracts";
import { ARC_USDC_ADDRESS, publicClient, usdcAbi } from "@/lib/recurring-contracts";
import { buildLinkMessage, buildSigninMessage, SESSION_ENDED_EVENT } from "@/lib/agent-link";
// Type-only, so nothing from the decision core is bundled into this client
// component — it is imported to keep REASONS below exhaustive, not to run.
import type { AutopayDecision } from "@/lib/autopay";
import { encodeRevokeMandate } from "@/lib/registry-calldata";
import { PosterCell, PosterFact, PosterValue, SectionHead, revealMotion, sectionMotion, type Step } from "./SpecCard";
import JobTrail from "./JobTrail";

const EXPLORER = "https://testnet.arcscan.app";

// ERC-8004 IdentityRegistry, for the link to the agent's identity NFT. Display
// only — nothing here signs against it.
const IDENTITY_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

// What the top-up field suggests. Enough to cover a couple of small shares plus
// the job fee and the agent's own gas, which is the smallest amount that leaves
// the agent actually able to settle something.
const DEFAULT_FUND_USDC = 2;

// The PUT caps the list, so the UI stops offering rows past the same number
// rather than letting someone type an eleventh and have it silently dropped.
const MAX_TRUSTED_CREATORS = 10;

const looksLikeAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value.trim());

// ── the tab's four sections, named once ──────────────────────────────────────
//
// Three of these render here and the fourth in app/AgentEconomyPanel.tsx, while
// the contents rail that indexes all four is a PosterHero up in HomeClient. Three
// files describing the same four sections is exactly how an index ends up
// promising something the page does not deliver — the old rail called section 04
// "Scout" while the section itself called it "Third-party agent" — so every one of
// them now reads these rows instead of restating them.
//
// See SectionHead in SpecCard.tsx for why a section on this tab has to say its own
// name at all: four sections on one scroll, each a lede pair over a list of rows,
// and until now each one opened with nothing but a 0.72rem caps kicker.
export const AGENT_STEPS: readonly Step[] = [
  // Noun phrases, not sentences, because section 01 renders in a state where no
  // agent exists at all — a title that read "your agent pays for you" would be
  // contradicted by its own hero figure ("No agent can spend on your behalf") two
  // lines below it. A title names what a section is about; the figure under it is
  // what is actually true right now.
  { index: "01", kicker: "Debtor side", title: "The agent that pays for you" },
  { index: "02", kicker: "Creditor side", title: "What others may collect" },
  { index: "03", kicker: "Audit trail", title: "Every decision it made" },
  { index: "04", kicker: "Third-party agent", title: "An agent with its own books" },
];

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

// The two skips that are the system working rather than something to look at:
// a bill that was already settled, and autopay being off because you switched it
// off. Every other skip wants something from you — a cap raised, a creator
// allowed, the agent funded, a suspect bill checked — so it takes the warn tone.
//
// Kept narrow on purpose. Warn on every skip would colour "Already settled" like
// a failure, and a colour that fires on everything is a colour people stop
// reading. Same rule the recurring tab applies to "not due yet".
const BENIGN_SKIPS = new Set<string>(["nothing_owed", "disabled"]);

// What the tab's masthead needs to light its contents rail — the same shape
// XHistoryPanel reports its count up in. The rail is the poster system's progress
// readout, and it can only be honest about a section it is told about.
export type AgentTabState = { armed: boolean; granted: number; decisions: number };

export default function SettlementAgentsPanel({ onState }: { onState?: (state: AgentTabState) => void }) {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [server, setServer] = useState<GrantsResponse | null>(null);
  const [agentWallet, setAgentWallet] = useState<AgentWallet | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [mandates, setMandates] = useState<MandateBill[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "success">("success");
  // 02's own message. Separate state rather than a tag on the one above, because
  // the alternative is reporting a failed "allow" up in 01 next to a form the
  // user was not touching — each section answers for its own actions.
  const [mandateMessage, setMandateMessage] = useState("");
  const [mandateTone, setMandateTone] = useState<"error" | "success">("success");
  const [pendingBillId, setPendingBillId] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  // Collapsed by default: the warning matters, but a permanent wall of it above
  // the caps would train people to scroll past the one thing they must read.
  const [showUnlink, setShowUnlink] = useState(false);
  // The top-up field, revealed in place rather than in a dialog — a modal would
  // cover the balance it exists to raise. Blank means "use the placeholder",
  // which is why the amount is parsed with a default rather than initialised to
  // "2": a field someone cleared should not silently re-fill itself.
  const [funding, setFunding] = useState(false);
  const [fundAmount, setFundAmount] = useState("");
  // The top-up landing is the confirmation that funding worked — the balance is
  // read from the chain server-side and trails the receipt by a block or two, so
  // the figure moving is the last thing to happen. Counted rather than compared
  // at render time: a boolean derived from a ref would be stripped by the next
  // re-render and cut its own animation short.
  const [balanceFlashes, setBalanceFlashes] = useState(0);
  const previousBalance = useRef<number | null>(null);
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

  // "Can software spend for me right now?" In funded mode the answer is this one
  // row — there is no per-wallet mandate to disagree with it, and GET reads it
  // back from the same row rather than from the chain.
  const armed = grant?.enabled ?? false;
  const grantedCount = mandates.filter((m) => m.authorized).length;

  // Reported up so the masthead's contents rail can light the sections that are
  // live. Above the early returns, where every hook has to be — a signed-out tab
  // still has a rail, and it should read as four cold steps rather than as four
  // it never heard about.
  useEffect(() => {
    onState?.({ armed, granted: grantedCount, decisions: log.length });
  }, [armed, grantedCount, log.length, onState]);

  const agentBalance = agentWallet?.balanceUsdc ?? 0;
  useEffect(() => {
    if (previousBalance.current !== null && previousBalance.current !== agentBalance) {
      setBalanceFlashes((count) => count + 1);
    }
    previousBalance.current = agentBalance;
  }, [agentBalance]);

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
        //
        // The creator list is cleaned on the WIRE and not in state: a row you
        // just added is empty, and dropping it out from under the caret the
        // moment any other field saves is worse than sending nothing for it.
        body: JSON.stringify({
          ...next,
          trustedCreators: next.trustedCreators.map((address) => address.trim()).filter(Boolean),
          moneyMode: "funded",
        }),
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
        const walletClient = await arcWalletClient();
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
      const walletClient = await arcWalletClient();
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

  // The allowed-creator list, edited a row at a time. Each row is one line of
  // poster type, so the operations are the list ones a payer list already has —
  // and every one of them commits, because there is no separate save on this
  // page and a creator you dropped must not come back on the next load.
  function editCreators(next: string[]) {
    if (!grant) return;
    void save({ ...grant, trustedCreators: next });
  }

  async function toggleMandate(billId: string, authorized: boolean) {
    setPendingBillId(billId);
    setMandateMessage("");
    try {
      const res = await fetch("/api/agents/mandate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billId, authorized }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMandateTone("error");
        setMandateMessage(
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
      setMandateTone("error");
      setMandateMessage(err instanceof Error ? err.message : "Could not update the mandate.");
    } finally {
      setPendingBillId(null);
    }
  }

  if (signedOut) {
    // A poster with nothing to report, which is the honest shape for it: the
    // sentence is set at the size the balance would have been, because "nothing
    // is authorized" is this tab's most important possible reading.
    return (
      <motion.section className="bill-poster" {...sectionMotion(0)}>
        <SectionHead
          marks={
            <span className="settle-label" data-tone="ok">
              nothing is authorized
            </span>
          }
          note={
            connectedAddress
              ? "An agent needs an account to belong to — it holds its own balance, its rules and its log. Signing costs nothing and moves nothing; it only proves the wallet is yours."
              : "Rules are tied to your account, so there is nothing to show until you sign in. Until you do, no permission exists to revoke."
          }
          step={AGENT_STEPS[0]}
        />

        <div className="bill-poster-body">
          <div className="bill-poster-lede">
            <div className="bill-cell">
              <span className="settle-label">Right now</span>
              {/* h4 under the section's own h3 — the sentence is what this
                  section is ABOUT, not what it is called. */}
              <h4 className="bill-display">No agent can spend on your behalf</h4>
              <div className="bill-cell-rule" />
            </div>
          </div>

          {message ? (
            <p className="bill-poster-msg" data-tone={messageTone === "error" ? "error" : undefined} role="status">
              {message}
            </p>
          ) : null}

          {/* The whole point of the wallet sign-in: a browser wallet is an
              identity here, not just an address someone else's account can
              point at. With none connected there is nothing to offer, and the
              standfirst above already says so. */}
          {connectedAddress ? (
            <div className="bill-poster-foot">
              <button className="settle-action" disabled={saving} onClick={signInWithWallet} type="button">
                {saving ? "signing…" : `sign in with ${short(connectedAddress)}`} ›
              </button>
              <div className="bill-poster-total">
                <span className="settle-label">Its agent gets</span>
                <span>
                  a balance <em>you fund separately</em>
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </motion.section>
    );
  }
  if (!grant) return null;

  // Left over from the mandate flow on the linked wallet, and revocable below.
  const staleMandate = linkedFacts?.enabled ?? false;
  const balanceUsdc = agentBalance;
  // What the revealed top-up would send, mirroring fundAgent's own parse so the
  // "it would hold" figure cannot disagree with what the transfer does. Junk
  // reads as 0 rather than NaN — the transfer refuses it either way, and a
  // figure set at rail size must not say "NaN" while someone is still typing.
  const fundUsdc = (() => {
    const parsed = Number(fundAmount.trim() || DEFAULT_FUND_USDC);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  })();
  // The trail actually holds another account's decisions. Read off the ROWS, not
  // off `otherAgent`: linking merges the accounts, and the rows written before it
  // stay under the account that wrote them, so a merged trail outlives the second
  // agent it came from.
  const mergedTrail = log.some((entry) => entry.otherAccount);
  // The wallet the extension is on RIGHT NOW, when it is none of the three the
  // section already accounts for: not this session's own, not the linked one, and
  // not one whose agent is on screen.
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

  // Which DEBTS the agent settles — no longer the same question as which wallet
  // it spends from, since it always spends its own. Short enough to sit on the
  // rail as a figure would; the hint under the options rail carries the rest.
  const settlesFor = walletSignin
    ? "both your wallets"
    : linkedAddress
      ? "both your wallets"
      : agentWallet?.otherAgent
        ? "your Splitsy wallet only"
        : "your Splitsy wallet";

  return (
    <>
      {/* ── 01. Autopay ───────────────────────────────────────────────────────
          The agent is the masthead and its balance is the hero figure, because
          in funded mode the balance IS the ceiling: every rule under it is one
          Splitsy checks before spending, and the only limit the chain holds is
          this number. Armed, the section's own top rule draws itself in ink —
          see "the agent poster" in globals.css. */}
      <motion.section className="bill-poster" data-armed={armed} {...sectionMotion(0)}>
        <SectionHead
          marks={
            <>
              {/* The one fact this tab exists to answer, in words as well as in
                  the rule above — a hairline is not a state a reader can hear. */}
              <span className="settle-label" data-tone={armed ? "ok" : undefined}>
                {armed ? "armed · it can spend now" : "idle"}
              </span>
              {agentWallet?.tokenId ? (
                <a
                  className="iou-row-tx"
                  href={`${EXPLORER}/token/${IDENTITY_REGISTRY_ADDRESS}/instance/${agentWallet.tokenId}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  identity #{agentWallet.tokenId}
                </a>
              ) : null}
              {agentWallet?.address ? (
                <button
                  aria-pressed={funding}
                  className="iou-provider bill-toggle"
                  onClick={() => setFunding((open) => !open)}
                  type="button"
                >
                  top it up
                </button>
              ) : null}
            </>
          }
          note="When someone bills you, your agent settles your share out of its own balance — the one you top up here. It can never spend more than it holds, and every ceiling below is a limit checked before it pays rather than a figure it aims at."
          step={AGENT_STEPS[0]}
        />

        <div className="bill-poster-body">
          {/* The agent, and what it holds. Same lede pair a bill uses for the
              merchant and the total, and for the same reason: the address is
              what this section is about, and the balance is the figure you came
              to read. The explorer link rides the footnote rail underneath —
              mono, dim and openable, the way every other hash on this poster is
              evidence rather than a headline. */}
          <div className="bill-poster-lede">
            <div className="bill-cell">
              <span className="settle-label">Your agent</span>
              {/* h4 under the section's own h3: the address names the agent this
                  section is about, and the section already named itself. */}
              <h4 className="bill-display">
                {agentWallet?.address ? short(agentWallet.address) : "no agent yet"}
              </h4>
              <div className="bill-cell-rule" />
            </div>
            <div className="bill-cell" data-total>
              <span className="settle-label">It holds</span>
              <div className="bill-figure">
                <span className="bill-currency">$</span>
                {/* Flashed only when the figure CHANGES, never on arrival: a
                    balance that goes green the first time you open the tab is
                    claiming money landed when none did, and on this page tint is
                    state. The count is the key as well as the gate, so the
                    animation replays on each real change and does not restart on
                    the unrelated re-renders load() causes. */}
                <span className={balanceFlashes > 0 ? "balance-flash" : undefined} key={balanceFlashes}>
                  {balanceUsdc.toFixed(2)}
                </span>
              </div>
              <div className="bill-cell-rule" />
            </div>
          </div>

          {/* The full address, under the short one the masthead is set in: the
              headline is legible and the footnote is checkable. .bill-payer-meta
              is the poster's footnote rail wherever a line needs one, which is
              what this is — the caption to the pair above. */}
          <div className="bill-payer-meta">
            {agentWallet?.address ? (
              <a
                className="iou-row-tx"
                href={`${EXPLORER}/address/${agentWallet.address}`}
                rel="noreferrer"
                target="_blank"
              >
                {agentWallet.address}
              </a>
            ) : (
              <span className="bill-poster-fact">
                created the first time this tab loads with Circle configured
              </span>
            )}
            {agentWallet?.otherAgent ? <span className="settle-label">in use here</span> : null}
          </div>

          {/* ── The top-up ── Revealed in place rather than in a dialog: a modal
              would cover the balance it exists to raise, and the destination is
              already on the rail above. Deliberately a plain transfer either
              way, not an approval — the agent's balance is its ceiling, so
              funding means handing over custody, not permission. */}
          <AnimatePresence>
            {funding && agentWallet?.address ? (
              <motion.div key="top-up" {...revealMotion}>
                <div className="bill-poster-rail">
                  <div className="bill-cell">
                    <span className="settle-label">Send</span>
                    <div className="bill-figure-sm">
                      <span className="bill-currency">$</span>
                      <PosterValue
                        ariaLabel="Amount to send to your agent, in USDC"
                        decimal
                        onChange={setFundAmount}
                        placeholder={String(DEFAULT_FUND_USDC)}
                        value={fundAmount}
                      />
                    </div>
                    <div className="bill-cell-rule" />
                  </div>
                  <PosterFact label="To" value={short(agentWallet.address)} />
                  <PosterFact label="It would hold" value={`$${(balanceUsdc + fundUsdc).toFixed(2)}`} />
                </div>

                {/* Only the sources this account actually has: a browser wallet
                    signs an ordinary USDC transfer itself, while a social
                    account's USDC sits in the Splitsy DCW that only the server
                    can move. A wallet account is offered neither — that DCW
                    exists but is behind a PIN they never set. */}
                {connectedAddress || (!walletSignin && server?.walletAddress) ? (
                  <div className="bill-poster-foot">
                    {connectedAddress ? (
                      <button
                        className="settle-action"
                        disabled={saving}
                        onClick={() => fundAgent("browser")}
                        type="button"
                      >
                        {saving ? "sending…" : `send from ${short(connectedAddress)}`} ›
                      </button>
                    ) : null}
                    {!walletSignin && server?.walletAddress ? (
                      <button
                        className={connectedAddress ? "iou-provider" : "settle-action"}
                        disabled={saving}
                        onClick={() => fundAgent("splitsy")}
                        type="button"
                      >
                        {connectedAddress
                          ? "or from my splitsy wallet"
                          : `${saving ? "sending…" : "send from my splitsy wallet"} ›`}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <p className="bill-options-hint">
                  The share, the job fee and the agent&rsquo;s own gas all come out of this balance — and it can never
                  pay out more than you have sent it. Any wallet can send to {agentWallet.address} directly.
                </p>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* ── The SECOND agent ── Another agent, so it takes the line an agent
              takes: shown only when one exists, which means the person signed in
              with this browser wallet before adding the login they are using
              now. That sign-in minted an account of its own, and an account gets
              an agent. Both hold real balances and neither can spend the
              other's, so hiding one is how USDC ends up in an agent nobody can
              find. Linking below is what merges them. */}
          <AnimatePresence>
            {agentWallet?.otherAgent ? (
              <motion.div key="other-agent" {...revealMotion}>
                <div className="bill-payers">
                  <div className="bill-payer">
                    <div className="bill-payer-line">
                      <span className="bill-payer-target">{short(agentWallet.otherAgent.address)}</span>
                      <span className="bill-payer-share">
                        <span className="bill-currency">$</span>
                        {agentWallet.otherAgent.balanceUsdc.toFixed(2)}
                      </span>
                    </div>
                    <div className="bill-payer-meta">
                      {/* That account's OWN switch, and the reason this row is
                          not trivia: it can be spending while every control on
                          this page belongs to the other login. */}
                      <span
                        className="settle-label"
                        data-tone={agentWallet.otherAgent.enabled ? "warn" : undefined}
                      >
                        {agentWallet.otherAgent.enabled ? "armed, and not by these rules" : "idle"}
                      </span>
                      <span className="bill-poster-fact">your other agent</span>
                      <span className="bill-poster-fact">
                        belongs to <b>{short(connectedAddress ?? "")}</b>
                      </span>
                      <a
                        className="iou-row-tx"
                        href={`${EXPLORER}/address/${agentWallet.otherAgent.address}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {short(agentWallet.otherAgent.address)}
                      </a>
                    </div>
                  </div>
                </div>
                {/* The way out, not a footnote: two agents under two sets of
                    rules is a state nobody should have to hold in their head,
                    and linking is the one action that ends it. */}
                <p className="bill-options-hint">
                  That wallet signed in as an account of its own before you added this login, and nothing on this page
                  applies to it — the ceilings and checks below are one row on the login you are in now. Link{" "}
                  {short(connectedAddress ?? "")} below and the two accounts become one:{" "}
                  {short(agentWallet.otherAgent.address)} stays as your only agent, with its balance, and these rules
                  are the only ones left.
                </p>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* ── The connected wallet, while it is unproven ── The rail above is
              keyed on the wallet the extension is on, so switching accounts in
              Rabby swaps which agent is on screen — and lands here for a wallet
              that has not signed a message in this browser. Said where the
              disappearance happened rather than left to be inferred from a
              control further down. */}
          <AnimatePresence>
            {unprovenWallet ? (
              <motion.div key="unproven" {...revealMotion}>
                <div className="bill-options">
                  <span className="bill-poster-fact">
                    <b>{short(unprovenWallet)}</b> isn&rsquo;t signed in here
                  </span>
                  {/* Labelled by its OUTCOME rather than "sign in", because the
                      login does not change — POST /api/auth/wallet leaves a
                      social session where it is. A control that says "sign in"
                      while you are already signed in reads as "sign out of
                      this", which is exactly what it used to do. */}
                  <button className="iou-provider" disabled={saving} onClick={signInWithWallet} type="button">
                    {saving ? "signing…" : "show its agent"}
                  </button>
                </div>
                {/* Does not claim the wallet HAS no agent, which this page cannot
                    know: the server will not reveal whether an address has an
                    account without that address's signature, which is exactly
                    what stops anyone reading a stranger's agent and decisions. */}
                <p className="bill-options-hint">
                  The wallet your extension is on now hasn&rsquo;t proved itself in this browser, so its agent
                  can&rsquo;t be shown — and if it never signed in, it has none and nothing settles its bills. One
                  signature, nothing moved: its agent, its balance and its decisions then appear beside your own, and
                  you stay signed in here.{" "}
                  {linkedAddress
                    ? `To have the agent above cover this wallet instead — no second agent at all — unlink ${short(linkedAddress)} first, then link this one.`
                    : "Or link it below instead: the agent above then settles its bills too, and there is no second agent to fund."}
                </p>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* ── The ceilings ── Typed straight into the figures they set, and
              committed on blur the way every figure on the bills poster is.
              Enforced HERE, before the agent spends: the chain's only ceiling in
              this mode is the balance above. One set per account, because the
              agent is per account. */}
          <div className="bill-poster-rail">
            <PosterCell
              decimal
              label="Ceiling per bill"
              onBlur={() => save(grant)}
              onChange={(value) => setGrant({ ...grant, maxPerBillUsdc: Number(value) || 0 })}
              prefix="$"
              value={String(grant.maxPerBillUsdc)}
            />
            <PosterCell
              decimal
              label="Ceiling per day"
              onBlur={() => save(grant)}
              onChange={(value) => setGrant({ ...grant, maxPerDayUsdc: Number(value) || 0 })}
              prefix="$"
              value={String(grant.maxPerDayUsdc)}
            />
            <PosterCell
              decimal
              label="Creator score floor"
              // Clamped on the way out rather than under the caret: someone
              // typing 100 passes through 1 and 10, and a field that fights the
              // second keystroke is worse than one that tidies up after the last.
              onBlur={() => save({ ...grant, minCreatorScore: Math.min(100, Math.max(0, grant.minCreatorScore)) })}
              onChange={(value) => setGrant({ ...grant, minCreatorScore: Number(value) || 0 })}
              placeholder="0"
              value={String(grant.minCreatorScore)}
            />
            <PosterFact label="Settles bills owed by" value={settlesFor} />
          </div>

          {/* ── Allowed creators ── One address, one line of poster type, with
              its own remove: the same payer row the bills poster sets a split
              in. It replaced a textarea of newline-separated addresses, which
              was the last box left on this section — and a list you can read a
              row at a time is also a list you can check a row at a time. */}
          {grant.trustedCreators.length > 0 ? (
            <div className="bill-payers">
              {grant.trustedCreators.map((creator, index) => (
                <div
                  className="bill-payer"
                  // The index, and safe as one: rows are only ever appended, and
                  // removal happens through a button click, which blurs the
                  // field first — so no PosterValue can carry its half-typed
                  // value into the row that takes its place.
                  key={`creator-${index}`}
                >
                  <div className="bill-payer-line">
                    <span className="bill-payer-target">
                      <PosterValue
                        ariaLabel={`Allowed creator ${index + 1}`}
                        compact={looksLikeAddress(creator) ? short(creator) : null}
                        onBlur={() => save(grant)}
                        onChange={(value) =>
                          setGrant({
                            ...grant,
                            trustedCreators: grant.trustedCreators.map((entry, at) =>
                              at === index ? value : entry,
                            ),
                          })
                        }
                        placeholder="0x…"
                        value={creator}
                      />
                    </span>
                  </div>
                  <div className="bill-payer-meta">
                    {/* An address that is not one can never match a creator, so
                        the row says so rather than waiting for a skip in the
                        trail to explain it. */}
                    <span
                      className="settle-label"
                      data-tone={creator.trim() !== "" && !looksLikeAddress(creator) ? "warn" : undefined}
                    >
                      {creator.trim() === ""
                        ? "empty"
                        : looksLikeAddress(creator)
                          ? "on wallet"
                          : "not a wallet address"}
                    </span>
                    <button
                      className="iou-provider bill-payer-remove"
                      onClick={() =>
                        editCreators(grant.trustedCreators.filter((_, at) => at !== index))
                      }
                      type="button"
                    >
                      remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {grant.trustedCreators.length < MAX_TRUSTED_CREATORS ? (
            <div className="bill-add">
              <button
                className="iou-provider"
                onClick={() => setGrant({ ...grant, trustedCreators: [...grant.trustedCreators, ""] })}
                type="button"
              >
                + allow a creator
              </button>
            </div>
          ) : null}

          {/* ── The checks ── Four settings that used to be four bordered rows
              with a paragraph each; here they are four words on one line, and a
              word that is ON says so by going full-strength with a lit rule
              under it. */}
          <div className="bill-options">
            <button
              aria-pressed={grant.requireVerifiedHash}
              className="iou-provider bill-toggle"
              disabled={saving}
              onClick={() => save({ ...grant, requireVerifiedHash: !grant.requireVerifiedHash })}
              type="button"
            >
              only verified bills
            </button>
            <button
              aria-pressed={grant.requireBillReview}
              className="iou-provider bill-toggle"
              disabled={saving}
              onClick={() => save({ ...grant, requireBillReview: !grant.requireBillReview })}
              type="button"
            >
              check the contents
            </button>
            {/* Three states, and the control only exists in two of them. A
                wallet sign-in has nothing to link or unlink; a social account
                with no wallet connected gets the hint instead of a button that
                can only fail. */}
            {walletSignin ? null : linkedAddress ? (
              <button
                aria-pressed={showUnlink}
                className="iou-provider bill-toggle"
                onClick={() => setShowUnlink((open) => !open)}
                type="button"
              >
                unlink {short(linkedAddress)}
              </button>
            ) : connectedAddress ? (
              <button className="iou-provider" disabled={saving} onClick={linkWallet} type="button">
                link {short(connectedAddress)}
              </button>
            ) : null}
          </div>

          {/* One line each, and only when there is something to say: what an
              armed option actually does, or what a switched-off check stops
              stopping. Off and available, a control explains nothing. */}
          <p className="bill-options-hint">
            {grant.trustedCreators.length === 0
              ? `Any creator can trigger autopay, within the ceilings above — up to ${MAX_TRUSTED_CREATORS} addresses once you start naming them.`
              : `${grant.trustedCreators.length} address${grant.trustedCreators.length === 1 ? "" : "es"} — no one else can trigger autopay.`}
          </p>

          {/* Said rather than implied, and said every time. The ceilings above
              are ours to enforce, so the page must not let anyone believe a
              contract is holding them: the agent's balance is the only number
              the chain bounds. */}
          <p className="bill-options-hint">
            Splitsy holds these ceilings and checks them before your agent spends — they are not enforced by a
            contract, so the hard limit is the ${balanceUsdc.toFixed(2)} it holds: it can never pay out more than you
            have sent it.
            {agentWallet?.otherAgent
              ? ` And they hold for ${short(agentWallet.address ?? "")} only — your other agent runs under the rules stored on its own account.`
              : ""}
          </p>

          {/* Why the control isn't there, which is the other thing a hint is
              for: with no wallet connected there is nothing to link, and a
              button that can only fail is worse than the sentence. */}
          {!walletSignin && !linkedAddress && !connectedAddress ? (
            <p className="bill-options-hint">
              Connect a browser wallet and you can link it here — the same agent then covers bills owed by it too, out
              of the one balance, with no second agent to fund.
            </p>
          ) : null}

          {grant.minCreatorScore === 0 ? null : (
            // Stated plainly because it is the one rule that fails open.
            <p className="bill-options-hint">
              A creator scoring under {grant.minCreatorScore} of 100 is refused — but one with no history yet still
              passes, because no history is not a bad score. Set the floor to 0 to switch it off.
            </p>
          )}

          {grant.requireVerifiedHash ? null : (
            <p className="bill-options-hint">
              Verified bills only is off, so the agent will pay bills whose merchant, total and split it cannot check
              against what the creator committed on chain.
            </p>
          )}

          {grant.requireBillReview ? (
            <p className="bill-options-hint">
              A model reads each bill and refuses if the numbers don&rsquo;t hang together — it weighs the merchant,
              total and your share against each other. It has no line items, so it cannot tell who ordered what.
            </p>
          ) : null}

          {armed && balanceUsdc <= 0 ? (
            <p className="bill-options-hint">
              Armed with an empty balance: nothing will settle until you top the agent up, and until then the trail
              below records every attempt as <span className="mono">agent_unfunded</span>.
            </p>
          ) : null}

          {/* ── Unlinking ── It does LESS than people expect, and the gap is
              money: for anyone who armed this wallet under the old mandate flow
              the standing permission is on the CHAIN, and unlinking does not
              touch it. Revoke first, then unlink, offered as that pair. */}
          <AnimatePresence>
            {showUnlink && linkedAddress && !walletSignin ? (
              <motion.div key="unlink" {...revealMotion}>
                <ul className="bill-options-hint list-disc space-y-1 pl-4">
                  <li>
                    Autopay for {short(linkedAddress)} stops — its bills are no longer resolvable to your account.
                  </li>
                  {/* Two different truths, and the difference is a balance. An
                      agent this account only holds because linking merged two
                      accounts GOES BACK on unlink — the inverse of the adoption
                      — so the reassuring version of this line would be a lie
                      about money. */}
                  {agentWallet?.agentFromWallet ? (
                    <li>
                      Your agent goes back to being that wallet&rsquo;s own, with its balance and its identity NFT:
                      linking is what merged the two accounts, and unlinking un-merges them. This login gets its own
                      agent again — a different address, and an empty one until you fund it or link back.
                    </li>
                  ) : (
                    <li>
                      Your agent, its balance and its identity NFT are untouched — they belong to your account, not to
                      that wallet.
                    </li>
                  )}
                  {staleMandate ? (
                    <li>
                      The mandate you armed on it earlier survives, along with its USDC approval. Splitsy no longer
                      pulls under it, but revoking is still a transaction only that wallet can send.
                    </li>
                  ) : null}
                </ul>
                <div className="bill-options">
                  {/* Signed by the LINKED wallet itself, so it is offered only
                      while that exact account is connected and only while there
                      is something left to revoke. */}
                  {staleMandate ? (
                    <button
                      className="iou-provider"
                      disabled={saving || !mandateAddress || !connectedAddress || wrongAccount}
                      onClick={revokeMandate}
                      type="button"
                    >
                      revoke the old mandate first
                    </button>
                  ) : null}
                  <button className="iou-provider" disabled={saving} onClick={unlinkWallet} type="button">
                    {staleMandate ? "unlink anyway" : "unlink"}
                  </button>
                </div>
                {staleMandate && wrongAccount ? (
                  <p className="bill-options-hint">
                    Your wallet is on a different account than the one you linked. The mandate is keyed on the sender,
                    so switch back to {short(linkedAddress)} to revoke it.
                  </p>
                ) : null}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* The one check on this page that is not a rule, so it is the one
              that has to show its working. Every line below is a claim about
              lib/autopay-review.ts and has to stay true to it: the field list is
              that prompt's inputs, the two lists are its refuse/do-not-refuse
              instructions, and "cannot answer" is FAIL_CLOSED. Nothing here may
              promise judgment the model was not given the data to make.

              A real <details>, like JobTrail: no state, keyboard and
              find-in-page for free, and set as the poster's own chrome-less
              disclosure — the same one the bills tab opens line items with. */}
          <details className="bill-items">
            <summary>
              <span className="settle-label">how the model judges your bill</span>
              <span className="bill-items-total">
                $0.002 per review
                <ChevronDown className="bill-items-chevron" size={16} />
              </span>
            </summary>

            {/* Said first because it is the part nobody assumes: the verdict is
                bought from a different wallet, so refusing costs the Settler
                money it does not recover. */}
            <p className="bill-options-hint">
              Bought, not asked for. Your Settler pays the Auditor $0.002 over x402 for each verdict, out of the
              settlement fee — two different wallets, so the one that judges the bill is not the one that gets paid to
              settle it. It also runs last, after your ceilings: a bill those already stopped never costs a review.
            </p>

            <div className="bill-poster-rail">
              <PosterFact label="It is given" value="9 headline fields" />
              <PosterFact label="It never sees" value="the receipt, the line items" />
              <PosterFact label="Cannot answer" value="counts as a refusal" />
            </div>

            {/* Two lists, set as captions rather than as entries: a disclosure
                nested under a section is explanation, and "it refuses when" at
                payer-row scale would out-shout the figures it explains. */}
            <p className="bill-options-hint settle-label">it refuses when</p>
            <ul className="bill-options-hint list-disc space-y-1 pl-4">
              <li>the total is wildly implausible for that kind of merchant</li>
              <li>your share is more than the entire bill</li>
              <li>your share is so far above an even split that no ordering would explain it</li>
              <li>the names on the bill contradict how many people it says are on it</li>
            </ul>

            {/* As load-bearing as the list above it. A reviewer people believe is
                trigger-happy gets switched off, and the prompt is explicit about
                both of these. */}
            <p className="bill-options-hint settle-label">it will not refuse for</p>
            <ul className="bill-options-hint list-disc space-y-1 pl-4">
              <li>a share above the even split, on its own — uneven is the point of splitting a bill</li>
              <li>a creator with no reputation history yet</li>
            </ul>

            <p className="bill-options-hint">
              What it is given: the merchant, the currency, the bill total, how many people are on it, what an even
              split would be, your share in USDC, the creator&rsquo;s reputation score and the names on the bill. Never
              the receipt image, and never the line items. When it refuses, its own sentence is what you read in the
              trail below.
            </p>
          </details>

          {message ? (
            <p
              className="bill-poster-msg"
              data-tone={messageTone === "error" ? "error" : "success"}
              role="status"
            >
              {message}
            </p>
          ) : null}

          {/* The commit. Arming is what this section is for, so it takes the
              word rather than a switch in the header — and the arithmetic that
              justifies pressing it sits opposite, as it does on every other
              poster: the ceiling the agent will apply today, out of what it
              actually holds. */}
          <div className="bill-poster-foot">
            <button className="settle-action" disabled={saving} onClick={() => save({ ...grant, enabled: !armed })} type="button">
              {saving ? "saving…" : armed ? "disarm autopay" : "arm autopay"} ›
            </button>
            <div className="bill-poster-total" data-tone={armed && balanceUsdc <= 0 ? "warn" : undefined}>
              <span className="settle-label">Ceiling today</span>
              <span>
                ${grant.maxPerDayUsdc.toFixed(2)} <em>from a balance of ${balanceUsdc.toFixed(2)}</em>
              </span>
            </div>
          </div>
        </div>
      </motion.section>

      {/* ── 02. Collect mandates ──────────────────────────────────────────────
          One bill, one line: the creator who would collect, and the most they
          could ever pull. Everything that qualifies it — the date it unlocks,
          whether you have granted it, the word that grants or withdraws it —
          rides the footnote rail, which is where a permission's terms belong. */}
      <motion.section className="bill-poster" {...sectionMotion(1)}>
        <SectionHead
          marks={
            mandates.length > 0 ? (
              <span className="bill-poster-fact">
                <b>{grantedCount}</b> of <b>{mandates.length}</b> granted
              </span>
            ) : null
          }
          note="Granting this is per bill and you can withdraw it at any time. It never lets anyone take more than your remaining share, and never before the due date."
          step={AGENT_STEPS[1]}
        />

        <div className="bill-poster-body">
          {mandates.length === 0 ? (
            <div className="iou-ledger">
              <p className="iou-empty">
                No bills with a due date yet. A mandate only makes sense once there is a deadline to collect after, so
                bills appear here as soon as one has one.
              </p>
            </div>
          ) : (
            <div className="bill-payers">
              {mandates.map((bill) => (
                <div className="bill-payer" key={bill.billId}>
                  <div className="bill-payer-line">
                    <span className="bill-payer-target">{bill.creatorLabel}</span>
                    {/* Dim until granted, the way an unassigned payer's share
                        is: this is what they COULD pull, not what they can. */}
                    <span className="bill-payer-share" data-empty={!bill.authorized}>
                      <span className="bill-currency">$</span>
                      {bill.remainingUsdc}
                    </span>
                  </div>
                  <div className="bill-payer-meta">
                    <span className="settle-label" data-tone={bill.authorized ? "ok" : undefined}>
                      {bill.authorized ? "granted" : "not granted"}
                    </span>
                    <span className="bill-poster-fact">
                      bill <b>#{bill.billId}</b>
                    </span>
                    <span className="bill-poster-fact">
                      not before <b>{formatDue(bill.dueDateSeconds)}</b>
                    </span>
                    <span className="bill-poster-fact">your remaining share, and no more</span>
                    {/* A word that says what it does, rather than a toggle whose
                        label changes under aria-pressed — the state is already
                        said by "granted" at the head of the rail. */}
                    <button
                      className="iou-provider bill-payer-remove"
                      disabled={pendingBillId === bill.billId}
                      onClick={() => toggleMandate(bill.billId, !bill.authorized)}
                      type="button"
                    >
                      {pendingBillId === bill.billId
                        ? bill.authorized
                          ? "withdrawing…"
                          : "allowing…"
                        : bill.authorized
                          ? "withdraw"
                          : "allow"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {mandateMessage ? (
            <p
              className="bill-poster-msg"
              data-tone={mandateTone === "error" ? "error" : "success"}
              role="status"
            >
              {mandateMessage}
            </p>
          ) : null}
        </div>
      </motion.section>

      {/* ── 03. Decision log ─────────────────────────────────────────────────
          Every run, including the ones it declined — and a skip is a row of
          exactly the same weight as a payment, because a skip and its reason is
          the proof the ceilings in 01 are real. The headline is the bill and the
          amount; the reason, the timestamp, the agent that decided it and the
          on-chain ceremony behind it are all footnotes to that line. */}
      <motion.section className="bill-poster" {...sectionMotion(2)}>
        <SectionHead
          marks={
            <>
              {log.length > 0 ? (
                <span className="bill-poster-fact">
                  <b>{log.length}</b> decision{log.length === 1 ? "" : "s"}
                </span>
              ) : null}
              {mergedTrail ? <span className="bill-poster-fact">both of your agents</span> : null}
            </>
          }
          note={
            mergedTrail
              ? "What your agents decided, newest first. Both are here, each row marked with the one that decided it — the ceilings in 01 bind only the first. A row marked reviewer carries the model's own sentence about that bill rather than a rule it matched."
              : "What the agent decided, newest first. A row marked reviewer carries the model's own sentence about that bill rather than a rule it matched, and every figure links to the transaction that carried it."
          }
          step={AGENT_STEPS[2]}
        />

        <div className="bill-poster-body">
          {log.length === 0 ? (
            <div className="iou-ledger">
              <p className="iou-empty">
                No decisions yet. The first time an agent looks at one of your bills, what it decided — and why — is
                written here.
              </p>
            </div>
          ) : (
            <div className="bill-payers">
              {log.map((entry) => {
                const quoted = modelWrote(entry.reason);
                return (
                  <div
                    className="bill-payer"
                    // The row's full unique key in Postgres. Bill id and debtor
                    // alone are not unique across registries, and a merged trail
                    // lists enough rows for that to actually collide.
                    key={`${entry.registryAddress}-${entry.billId}-${entry.debtorAddress}`}
                  >
                    <div className="bill-payer-line">
                      <span className="bill-payer-target">Bill #{entry.billId}</span>
                      <span className="bill-payer-share" data-empty={entry.decision !== "pay"}>
                        {entry.decision === "pay" ? (
                          <>
                            <span className="bill-currency">$</span>
                            {entry.amountUsdc.toFixed(2)}
                          </>
                        ) : (
                          "no payment"
                        )}
                      </span>
                    </div>

                    <div className="bill-payer-meta">
                      <span
                        className="settle-label"
                        data-tone={
                          entry.decision === "pay" ? "ok" : BENIGN_SKIPS.has(entry.reason) ? undefined : "warn"
                        }
                      >
                        {entry.decision === "pay" ? "paid" : "skipped"}
                      </span>
                      <span className="bill-poster-fact">{formatWhen(entry.createdAt)}</span>
                      <span className="bill-poster-fact">
                        owed by <b>{short(entry.debtorAddress)}</b>
                      </span>
                      {/* Without this the model's sentence sits in the same slot
                          as "Above your per-bill cap" and reads as one more
                          canned string. The mark is the whole difference between
                          a rule the agent applied and a judgment it made. */}
                      {quoted ? <span className="settle-label">reviewer</span> : null}
                      {/* Only on the other agent's rows. Marking every row would
                          be noise; marking the ones that came from an agent whose
                          rules are not on this page is the whole point. */}
                      {entry.otherAccount ? (
                        <span className="settle-label">
                          {agentWallet?.otherAgent ? short(agentWallet.otherAgent.address) : "your other agent"}
                        </span>
                      ) : null}
                      {entry.txHash ? (
                        <a
                          className="iou-row-tx"
                          href={`${EXPLORER}/tx/${entry.txHash}`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {short(entry.txHash)}
                        </a>
                      ) : null}
                    </div>

                    {/* Quoted, because it is a quotation. The cast is safe on
                        this branch and only on it: modelWrote is the hasOwn
                        check, so a mapped slug is exactly what is left — which
                        is also why the old `?? entry.reason` fallback is gone
                        rather than moved. */}
                    {quoted ? (
                      <p className="agent-verdict">&ldquo;{entry.reason}&rdquo;</p>
                    ) : (
                      <p className="bill-options-hint">{REASONS[entry.reason as ReasonSlug]}</p>
                    )}

                    {/* Only a payment opens a job, so this appears on pay rows
                        alone. A skip keeps the reason above and nothing else —
                        there is no job to point at. */}
                    {entry.jobId ? (
                      <JobTrail
                        billId={entry.billId}
                        connectedAddress={connectedAddress}
                        feeUsdc={entry.feeUsdc}
                        jobId={entry.jobId}
                        jobStatus={entry.jobStatus}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </motion.section>
    </>
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
