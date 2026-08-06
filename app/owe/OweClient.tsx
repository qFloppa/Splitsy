"use client";

import confetti from "canvas-confetti";
import gsap from "gsap";
import { Mail, Moon, Sun, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { arcTestnet } from "viem/chains";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { billMetadataHash } from "@/lib/bill-metadata";
import {
  BILL_SPLIT_REGISTRY_ADDRESS,
  createBillSplit,
  createBillSplitWallet,
  ensureBillSplitWalletOnArc,
  isBillRegistryConfigured,
  transferArcUsdc,
  usdcToBillUnits,
} from "@/lib/bill-split-contracts";
import {
  askBody,
  compactTarget,
  detectProvider,
  ledgerNet,
  ledgerRows,
  looksLikeAddress,
  looksLikeEmail,
  nextProvider,
  pickSigner,
  planIou,
  targetName,
  typableAmount,
  type IouDirection,
  type IouLedgerRow,
  type IouPlan,
  type IouSigner,
} from "@/lib/iou";
import { providerDisplay } from "@/lib/provider-display";
import type { AccountProvider, IdentityProvider } from "@/lib/types";
import { useTheme } from "@/lib/use-theme";
import { wagmiConfig } from "@/lib/wagmi";
import { DISCORD_PATH } from "../ProviderTag";
import XAuthControl from "../XAuthControl";

type Me = { id: string; provider?: AccountProvider | null; handle: string; walletAddress: string | null };

// A row the user just made, held locally until the dashboard has indexed it.
// `note` is kept because the ledger's server rows are netted per counterparty
// and have no description to show — this is the only place the sentence
// survives verbatim.
type RecentRow = IouLedgerRow & { note: string; state: "pending" | "settled" };

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const money = (n: number) => n.toFixed(2);

// The composer's fields, snapshotted so a failed commit can put them back
// exactly as typed rather than making the user retype a sentence we lost.
type Draft = { direction: IouDirection; target: string; provider: IdentityProvider; amount: string; note: string };
const EMPTY: Draft = { direction: "i-owe", target: "", provider: "x", amount: "", note: "" };

// Shared with the split form's "Create as" control, so picking a creator in one
// place is remembered in the other.
const CREATOR_IDENTITY_KEY = "splitsy-creator-identity";

// Read at first render rather than in an effect. It can't cause a hydration
// mismatch: the preference only matters once BOTH identities are live, and both
// arrive asynchronously (the session over fetch, the wallet over wagmi's
// reconnect), so the first client render draws the same markup the server did.
// The catch covers the server (no `window`) and private mode (localStorage
// throws rather than returning null) with the same default the split form uses.
const savedSigner = (): IouSigner => {
  try {
    return window.localStorage.getItem(CREATOR_IDENTITY_KEY) === "social" ? "social" : "wallet";
  } catch {
    return "wallet";
  }
};

// What the ghost under the rule offers while the note is empty. Specific and
// lowercase: a suggestion that reads like something a person actually owed for
// says what belongs here in a way "description" never does. Never submitted —
// these are placeholders, so the list can say anything true of a debt.
const REASONS = [
  "the cab home",
  "last night's ramen",
  "coffee, twice",
  "your half of the airbnb",
  "the groceries",
  "two concert tickets",
  "the bar tab",
  "gas money",
  "that vinyl you took",
  "brunch, obviously",
  "the wifi bill",
  "spotify, again",
  "the birthday cake",
  "a parking ticket",
  "the ramen you swore you'd cover",
];

// Long enough to read the line, notice it, and look away — then it changes. A
// swap runs ~1.2s, so a reason holds for a shade over four and a half seconds.
const GHOST_DWELL = 3.4;

/**
 * FLIP: measure, mutate, measure, play the difference.
 *
 * `mutate` has to change the DOM synchronously for the second read to see it,
 * which is why every caller wraps its setState in flushSync. Everything here is
 * a transform, so nothing in this function affects layout for anyone else.
 */
function flip(nodes: Element[], mutate: () => void, duration = 0.55) {
  if (reduced()) {
    mutate();
    return;
  }
  const before = new Map(nodes.map((n) => [n, n.getBoundingClientRect()]));
  mutate();
  for (const node of nodes) {
    const from = before.get(node);
    // A token can be removed by the mutation itself — "I" only exists in one of
    // the two sentences. A detached node measures as zeros, which would read as
    // an enormous delta and animate something nobody can see.
    if (!from || !node.isConnected) continue;
    const to = node.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    gsap.fromTo(node, { x: dx, y: dy }, { x: 0, y: 0, duration, ease: "expo.out" });
  }
}

/** Type-size ratio between two elements — the scale that makes one land as the other. */
const scaleBetween = (from: Element, to: Element) =>
  parseFloat(getComputedStyle(to).fontSize) / parseFloat(getComputedStyle(from).fontSize);

export default function OweClient() {
  const [me, setMe] = useState<Me | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<boolean | null>(null);
  const [serverRows, setServerRows] = useState<IouLedgerRow[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [reload, setReload] = useState(0);
  const [preferred, setPreferred] = useState<IouSigner>(savedSigner);
  const [targetFocused, setTargetFocused] = useState(false);
  const { theme, setTheme } = useTheme();

  const sentenceRef = useRef<HTMLDivElement>(null);
  const ruleRef = useRef<HTMLDivElement>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const ledgerShown = useRef(false);
  const seq = useRef(0);

  const { address, connector } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { switchChainAsync } = useSwitchChain();

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // A "wallet" account is not a Splitsy wallet: signing in with a browser wallet
  // creates an account with no Circle DCW behind it, so the server-signed rails
  // have nothing to sign with. For that session the connected wallet IS the
  // identity — the same call XAuthControl makes when it renders nothing.
  const socialAddress = me && me.provider !== "wallet" ? me.walletAddress : null;
  const walletAddress = address ?? null;
  const signer = pickSigner(socialAddress, walletAddress, preferred);
  const bothIdentities = Boolean(socialAddress && walletAddress);
  // The two targets the composer refuses: your own handle, and the wallet that
  // would sign this IOU. The OTHER of your two wallets stays a legitimate
  // counterparty — the same rule the split form applies to its creator identity.
  const myIdentity = {
    ...(me && me.provider !== "wallet" ? { provider: me.provider ?? "x", handle: me.handle } : {}),
    signerAddress: signer === "wallet" ? walletAddress : socialAddress,
  };
  // Every wallet whose bills belong in this ledger — a dual-identity user's
  // browser-wallet asks would otherwise be invisible here.
  const ledgerWallets = [socialAddress, walletAddress].filter((a): a is string => Boolean(a)).join(",");

  // The provider a bare handle will actually be tagged with. Email gives itself
  // away; anything else follows the picker. Recomputed rather than stored so the
  // avatar, the footnote and the commit can never disagree about who this is.
  const provider = detectProvider(draft.target, draft.provider);
  const display = providerDisplay({ provider, handle: draft.target });
  // The short form of a pasted target, or null while the full thing should show.
  // An address compacts the moment it is complete — it is pasted, never typed,
  // so there is no caret to keep up with. An email IS typed, and passes the
  // email regex several characters before it is finished ("…@gmail.c"), so it
  // waits for the blur rather than rewriting the field under the caret.
  const compact = targetFocused && !looksLikeAddress(draft.target) ? null : compactTarget(draft.target);
  // Which wallet the footnote names. providerDisplay shortens an address the
  // same way it does everywhere else, so "as 0xab…cdef" reads consistently.
  const signerLabel = (() => {
    if (signer === "wallet") return providerDisplay({ provider: "wallet", handle: walletAddress }).label;
    if (!me) return "your Splitsy wallet";
    const d = providerDisplay({ provider: me.provider, handle: me.handle });
    return `${d.prefix}${d.label}`;
  })();
  const ready = draft.target.trim() !== "" && draft.amount.trim() !== "";
  const rows: (IouLedgerRow | RecentRow)[] = [
    ...recent,
    // ponytail: joined on label, the only key the two sides share — a recent row
    // carries a handle, a server row carries an address the dashboard resolved
    // back to that same handle. A miss leaves a duplicate for one session, not
    // a wrong balance.
    ...serverRows.filter((s) => !recent.some((r) => r.label.toLowerCase() === s.label.toLowerCase())),
  ];
  const net = ledgerNet(rows);

  useEffect(() => {
    let live = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => live && setMe(d.user ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  function choosePreferred(next: IouSigner) {
    setPreferred(next);
    try {
      window.localStorage.setItem(CREATOR_IDENTITY_KEY, next);
    } catch {
      // Full/unavailable storage — the choice still applies for this session.
    }
  }

  // The standing balance, straight off the treasury plan the dashboard already
  // computes: netted per counterparty, labelled with handles, signed by
  // direction. `reload` is bumped after a commit rather than calling a refetch
  // function, so every setState here stays inside the fetch's own callback.
  useEffect(() => {
    if (!ledgerWallets) return;
    let live = true;
    fetch(`/api/dashboard?wallets=${ledgerWallets}`)
      .then((r) => r.json())
      .then((d) => {
        if (live && Array.isArray(d?.treasury?.positions)) setServerRows(ledgerRows(d.treasury.positions));
      })
      // A ledger that fails to load is a quieter page, not a broken one — the
      // composer is the point and works without it.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ledgerWallets, reload]);

  // Reveal once fonts are in, so the clip measures real glyphs. Same delay
  // ladder as the settle deck: sentence, then note, then action.
  //
  // Three states, not two, and the server renders none of them: no attribute
  // means no clip, so a page that never hydrates shows the composer instead of
  // an empty poster. "false" arms the clip, and the frame after that flips it
  // to "true" — the browser needs to paint the closed state once for there to
  // be anything to transition from.
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      setRevealed(false);
      requestAnimationFrame(() => requestAnimationFrame(() => live && setRevealed(true)));
    });
    return () => {
      live = false;
    };
  }, []);

  // Stagger the standing balance in under the composer, exactly once. Re-running
  // it per row would fight `demote`, which owns the animation of the row you
  // just made — two tweens on one element, and the later one wins mid-flight.
  useEffect(() => {
    const node = ledgerRef.current;
    if (!node || revealed !== true || reduced() || ledgerShown.current || serverRows.length === 0) return;
    ledgerShown.current = true;
    const ctx = gsap.context(() => {
      gsap.from("[data-iou-row]", { y: 14, autoAlpha: 0, duration: 0.6, ease: "expo.out", stagger: 0.06 });
    }, node);
    return () => ctx.revert();
  }, [revealed, serverRows.length]);

  // The rule draws itself once the sentence has landed. Three branches, one per
  // reveal state: un-hydrated pages get a drawn rule, the armed frame gets a
  // closed one, and only the flip to "true" animates — a single `fromTo` here
  // would snap the rule shut and redraw it every time the state changed.
  useEffect(() => {
    const rule = ruleRef.current;
    if (!rule) return;
    if (revealed === null || reduced()) gsap.set(rule, { scaleX: 1 });
    else if (revealed === false) gsap.set(rule, { scaleX: 0 });
    else gsap.to(rule, { scaleX: 1, duration: 0.7, ease: "expo.out", delay: 0.18 });
  }, [revealed]);

  /**
   * The rotating suggestion under the rule.
   *
   * The span's children are written by hand, not rendered: React is never given
   * any, so it has nothing to reconcile and the composer's per-keystroke
   * re-renders can't clobber a tween mid-flight. It is aria-hidden and purely
   * decorative — the input keeps its label and its native "what for?"
   * placeholder, which CSS hides only once this span has something in it, so a
   * page that never hydrates still says what the field is for.
   *
   * Per character, not per word: the stagger is what makes a swap read as being
   * written rather than crossfaded.
   */
  useEffect(() => {
    const host = ghostRef.current;
    const input = noteRef.current;
    if (!host || !input) return;

    const write = (text: string) => {
      host.replaceChildren(
        ...Array.from(text, (ch) => {
          const span = document.createElement("span");
          span.className = "iou-ghost-ch";
          // An inline-block holding a plain space collapses to nothing, and
          // every char needs to be inline-block for the transform to apply.
          span.textContent = ch === " " ? " " : ch;
          return span;
        }),
      );
      return Array.from(host.children);
    };

    // Shuffled once and then consumed in order, so nothing repeats until every
    // reason has had a turn. Independent random draws would say "brunch" twice
    // running often enough to look broken. Fisher-Yates, on a copy.
    const queue = [...REASONS];
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }

    // The first suggestion is written, not animated in: the composer's own
    // reveal is already wiping this line into view, and a second entrance
    // underneath it reads as a stutter.
    write(queue[0]);
    if (reduced()) return;

    let index = 0;
    let live = true;
    let timer = gsap.delayedCall(GHOST_DWELL, tick);

    function swap(text: string) {
      const outgoing = Array.from(host!.children);
      gsap
        .timeline()
        // `amount`, not `each`: the stagger is spread across however many
        // characters there are, so "brunch, obviously" and "the ramen you swore
        // you'd cover" take exactly as long as each other. Per-character timing
        // would make a long reason crawl and a short one snap.
        .to(outgoing, { yPercent: -70, autoAlpha: 0, duration: 0.28, ease: "power2.in", stagger: { amount: 0.18 } }, 0)
        // Blur the line, not each character: one filtered layer for the whole
        // phrase instead of twenty, and the phrase is what the eye tracks.
        .to(host!, { filter: "blur(3px)", duration: 0.28, ease: "power2.in" }, 0)
        .add(() => {
          if (!live) return;
          const incoming = write(text);
          gsap.fromTo(
            incoming,
            { yPercent: 70, autoAlpha: 0 },
            { yPercent: 0, autoAlpha: 1, duration: 0.52, ease: "expo.out", stagger: { amount: 0.24 } },
          );
          gsap.to(host!, { filter: "blur(0px)", duration: 0.44, ease: "expo.out" });
        });
    }

    function tick() {
      if (!live) return;
      // Frozen while the field is in use: a phrase that moves under the caret is
      // a distraction, and one that changes after you've typed isn't a
      // suggestion any more — it's the page arguing with you.
      if (!input!.value && document.activeElement !== input) {
        index = (index + 1) % queue.length;
        swap(queue[index]);
      }
      // Chained rather than an interval, so the dwell starts after the swap
      // lands. GSAP's ticker is rAF-driven, so a backgrounded tab stops paying
      // for this entirely.
      timer = gsap.delayedCall(GHOST_DWELL, tick);
    }

    return () => {
      live = false;
      timer.kill();
      // The swap's enter tweens are created inside a callback, so they belong to
      // no timeline this scope still holds — kill by target instead.
      gsap.killTweensOf([host, ...Array.from(host.children)]);
    };
  }, []);

  /**
   * The signature move. Flipping the debt swaps which noun comes first, because
   * the debtor is always the subject — so the handle physically travels across
   * the sentence and the verb changes under it. The motion IS the meaning here,
   * which is the only reason it earns 550ms.
   */
  function toggleDirection() {
    const sentence = sentenceRef.current;
    const next: IouDirection = draft.direction === "i-owe" ? "owes-me" : "i-owe";
    if (!sentence) {
      set({ direction: next });
      return;
    }
    const tokens = Array.from(sentence.querySelectorAll("[data-token]"));
    flip(tokens, () => flushSync(() => set({ direction: next })));
    if (reduced()) return;
    // The verb crossfades a beat behind the handle so the eye follows the name
    // across and finds the new word already there.
    const verb = sentence.querySelector("[data-token='verb']");
    if (verb) gsap.fromTo(verb, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.42, ease: "expo.out", delay: 0.04 });
  }

  /** Commit: the sentence shrinks into the ledger row it just became. */
  function demote(plan: IouPlan, id: string) {
    const sentence = sentenceRef.current;
    const row: RecentRow = {
      id,
      // An address is shortened here too — a 42-character label would run the
      // row off the page, and it is what the dashboard's own rows will show once
      // the bill is indexed.
      label: provider === "wallet" ? targetName(plan) : `${display.prefix}${plan.handle}`,
      direction: draft.direction,
      amountUsd: plan.amountUsd,
      payBillIds: [],
      note: plan.note,
      state: "pending",
    };
    if (!sentence || reduced()) {
      flushSync(() => {
        setRecent((r) => [row, ...r]);
        setDraft({ ...EMPTY, direction: draft.direction });
      });
      return;
    }

    const from = sentence.getBoundingClientRect();
    // A clone, not the element itself: the composer is about to be emptied, and
    // flying a blank sentence down to the ledger would animate nothing.
    const clone = sentence.cloneNode(true) as HTMLElement;
    // Inputs don't clone their live values (value is a property, not an
    // attribute), so copy each one across or the clone flies down empty.
    const originals = sentence.querySelectorAll("input");
    clone.querySelectorAll("input").forEach((input, i) => input.setAttribute("value", originals[i]?.value ?? ""));
    Object.assign(clone.style, {
      position: "fixed",
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      margin: "0",
      pointerEvents: "none",
      zIndex: "30",
    });
    clone.setAttribute("aria-hidden", "true");
    document.body.appendChild(clone);

    flushSync(() => {
      setRecent((r) => [row, ...r]);
      setDraft({ ...EMPTY, direction: draft.direction });
    });

    const landing = ledgerRef.current?.querySelector(`[data-iou-row="${id}"]`);
    const to = landing?.getBoundingClientRect();
    gsap.to(clone, {
      x: to ? to.left - from.left : 0,
      y: to ? to.top - from.top : 120,
      scale: landing ? scaleBetween(sentence, landing) : 0.2,
      autoAlpha: 0,
      transformOrigin: "left top",
      duration: 0.7,
      ease: "expo.out",
      onComplete: () => clone.remove(),
    });
    if (landing) gsap.from(landing, { autoAlpha: 0, duration: 0.4, delay: 0.32 });
    gsap.from(sentence, { y: 14, autoAlpha: 0, duration: 0.5, ease: "expo.out", delay: 0.2 });
  }

  /**
   * The reverse: a row grows back into the composer. Used both when a commit
   * fails and when a row is tapped to recall it — the same gesture either way,
   * because in both cases a line of ledger is becoming an editable sentence.
   */
  function promote(rowId: string, restore: Draft, drop: boolean) {
    const sentence = sentenceRef.current;
    const row = ledgerRef.current?.querySelector(`[data-iou-row="${rowId}"]`);
    const apply = () =>
      flushSync(() => {
        if (drop) setRecent((r) => r.filter((x) => x.id !== rowId));
        setDraft(restore);
      });

    if (!sentence || !row || reduced()) {
      apply();
      targetRef.current?.focus();
      return;
    }
    const from = row.getBoundingClientRect();
    const scale = scaleBetween(sentence, row);
    apply();
    const after = sentence.getBoundingClientRect();
    gsap.fromTo(
      sentence,
      { x: from.left - after.left, y: from.top - after.top, scale, transformOrigin: "left top", autoAlpha: 0.4 },
      { x: 0, y: 0, scale: 1, autoAlpha: 1, duration: 0.62, ease: "expo.out" },
    );
    targetRef.current?.focus();
  }

  // Tapping a row re-states it in the composer. One handler for every row rather
  // than a closure each: the row already carries its id as an attribute for the
  // flip to find it by, so the click can read the same one.
  function recallRow(event: React.MouseEvent<HTMLButtonElement>) {
    const id = event.currentTarget.dataset.iouRow;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    promote(
      row.id,
      {
        direction: row.direction,
        target: row.label.replace(/^@/, ""),
        // Bare handles come back as X; an email re-detects itself, and a Discord
        // name is one tap on the footnote away.
        provider: "x",
        amount: money(row.amountUsd),
        note: "note" in row ? row.note : "",
      },
      false,
    );
  }

  // A handle → the address the registry will use. Pre-mints a Splitsy wallet for
  // someone who has never signed in, which is why the paying rails check they
  // can actually pay BEFORE calling this.
  async function resolveTarget(plan: IouPlan): Promise<`0x${string}`> {
    // An address is its own answer, and the resolve route only knows the three
    // handle namespaces — asking it about a wallet would 400.
    if (plan.provider === "wallet") return plan.handle as `0x${string}`;
    const resolved = await fetch("/api/onchain-bills/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participants: [{ provider: plan.provider, handle: plan.handle }] }),
    }).then((r) => r.json());
    const to = resolved?.resolved?.[0]?.address;
    if (!to) throw new Error(resolved?.error || "Couldn't find a wallet for that handle.");
    return to as `0x${string}`;
  }

  // Connect (if needed), land on Arc, and hand back a wallet ready to sign.
  // HomeClient's connectWallets minus everything this page has no use for — no
  // recurring tabs, no bridge session, no registry sweep.
  async function connectWallet() {
    const active = connector ?? connectors[0];
    if (!active) throw new Error("No browser wallet found — install one, then try again.");
    if (!address) await connectAsync({ connector: active, chainId: arcTestnet.id });
    await switchChainAsync({ chainId: arcTestnet.id });
    return createBillSplitWallet(await getWalletClient(wagmiConfig, { chainId: arcTestnet.id }));
  }

  // The way in for someone holding their own keys. /owe has no sign-in menu, and
  // before this the page had nothing to offer them at all.
  async function connectFromMeta() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await connectWallet();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect that wallet.");
    } finally {
      setBusy(false);
    }
  }

  // Server-signed: a one-participant bill in the registry. I'm the splitter, so
  // I'm the one who can claim it — which is exactly what "owes me" means.
  async function sendAsk(plan: IouPlan) {
    const res = await fetch("/api/onchain-bills/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(askBody(plan)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't put that on Arc.");
  }

  // A direct transfer. The registry can't hold "I owe you" — createBill makes
  // msg.sender the splitter, so recording this on-chain would mean signing as
  // the other person. I hold the money and I'm the one who owes it, so there is
  // nothing for escrow to coordinate: just pay.
  //
  // ponytail: no deferred "I owe" — that needs an off-chain row against a
  // creditor who may not have an account. Add bill_debts-backed IOUs when
  // someone actually asks to record a debt they can't yet pay.
  async function settleNow(plan: IouPlan) {
    const to = await resolveTarget(plan);

    const res = await fetch("/api/wallet/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, amount: plan.amountUsd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        data.error === "insufficient_funds"
          ? "Not enough USDC in your wallet."
          : data.error === "locked"
            ? "Unlock your wallet first — the wallet button, bottom right."
            : data.error || "Transfer failed.",
      );
    }
  }

  // The same ask, signed in the user's own wallet instead of their Splitsy one.
  // It has to build the bill EXACTLY as app/api/onchain-bills/create does —
  // "@handle" label, no receipt, no due date — because those fields are the
  // metadataHash, and a payer verifies an IOU by recomputing it.
  async function askWithWallet(plan: IouPlan) {
    if (!isBillRegistryConfigured()) throw new Error("The bill registry isn't configured yet.");
    const wallet = await connectWallet();
    const to = await resolveTarget(plan);
    // A handle can resolve to the wallet doing the signing (they linked it), and
    // the registry would happily record a bill you owe yourself.
    if (to.toLowerCase() === wallet.account.toLowerCase()) throw new Error("That handle is your own wallet.");

    const body = askBody(plan);
    // Same helper the server rail's label comes from, because this string is
    // hashed — see targetName.
    const labels = [targetName(plan)];
    await ensureBillSplitWalletOnArc(wallet);
    const created = await createBillSplit({
      ...wallet,
      metadataHash: billMetadataHash({
        merchant: body.merchant,
        currency: body.currency,
        total: body.total,
        participantLabels: labels,
        receiptHash: "",
      }),
      participants: [to],
      owedAmounts: [usdcToBillUnits(plan.amountUsd.toFixed(2))],
    });

    // The details behind the hash. Fire-and-forget (the bill is already real),
    // but never silent: without this the debtor sees an amount and no sentence.
    void fetch("/api/onchain-bills/preimage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registryAddress: BILL_SPLIT_REGISTRY_ADDRESS,
        billId: created.billId.toString(),
        merchant: body.merchant,
        currency: body.currency,
        total: body.total,
        participantLabels: labels,
        participantProviders: [plan.provider],
        receiptHash: "",
      }),
    })
      .then(async (r) => {
        if (!r.ok) console.error("Publishing the IOU preimage failed:", r.status, await r.text());
      })
      .catch(() => {});
  }

  // The settle, signed in the user's own wallet: one USDC transfer on Arc. Same
  // reasoning as settleNow — an "I owe you" has no registry shape — only the
  // signature comes from the browser rather than the server.
  async function settleWithWallet(plan: IouPlan) {
    const wallet = await connectWallet();
    const to = await resolveTarget(plan);
    if (to.toLowerCase() === wallet.account.toLowerCase()) throw new Error("That handle is your own wallet.");
    await ensureBillSplitWalletOnArc(wallet);
    await transferArcUsdc({ ...wallet, to, amount: usdcToBillUnits(plan.amountUsd.toFixed(2)) });
  }

  async function commit() {
    if (busy) return;
    const planned = planIou(draft, myIdentity);
    if (!planned.ok) {
      setError(planned.error);
      return;
    }
    if (!signer) {
      setError("Connect a wallet or sign in to settle up.");
      return;
    }
    const plan = planned.plan;

    // Check the lock BEFORE anything animates or resolves. Resolving a handle
    // pre-mints a wallet for it, and doing that on behalf of someone who then
    // can't pay leaves a wallet behind for nothing. A browser wallet has no lock
    // to check — the extension asks at signing time, which is the same gate.
    if (plan.kind === "settle" && signer === "social") {
      const pin = await fetch("/api/wallet/pin")
        .then((r) => r.json())
        .catch(() => ({}));
      if (!pin.unlocked) {
        setError("Unlock your wallet first — the wallet button, bottom right.");
        return;
      }
    }

    const snapshot = draft;
    // A counter, not the content: committing "@dani $20" twice is a normal thing
    // to do, and two rows sharing an id would make the second one un-animatable.
    seq.current += 1;
    const id = `local-${seq.current}`;
    setError("");
    setBusy(true);
    demote(plan, id);

    try {
      // Four rails, one grid: the sentence picks ask-vs-settle, the signer picks
      // who writes it.
      if (plan.kind === "ask") await (signer === "wallet" ? askWithWallet(plan) : sendAsk(plan));
      else await (signer === "wallet" ? settleWithWallet(plan) : settleNow(plan));
      setRecent((r) => r.map((x) => (x.id === id ? { ...x, state: "settled" } : x)));
      if (plan.kind === "settle" && !reduced()) {
        void confetti({
          colors: ["#2775ca", "#3ee6d6", "#17a56b"],
          origin: { y: 0.5 },
          particleCount: 110,
          spread: 68,
          startVelocity: 36,
        });
      }
      setReload((n) => n + 1);
    } catch (err) {
      // Put the sentence back exactly as typed. A failed payment that silently
      // eats what you wrote is the thing that makes a demo feel fake.
      promote(id, snapshot, true);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const verb = draft.direction === "i-owe" ? "owe" : "owes me";
  const action = draft.direction === "i-owe" ? "settle" : "send the ask";

  // The handle token, with its avatar. Rendered by a function because it appears
  // at two different places in the sentence and must be the SAME element in both
  // — a remounted node has no previous rect, and the flip would have nothing to
  // animate from.
  //
  // Only X shows a face. Discord has no username→avatar CDN, and for an email or
  // a wallet a stranger's face is a liability rather than a confirmation: the
  // Gravatar behind an address you mistyped belongs to whoever owns that
  // address, so a wrong target would still look right. The platform mark says
  // which namespace this is; the text says who, and is the thing to check.
  const mark =
    !draft.target.trim() || (provider === "x" && display.avatarSrc) ? null : provider === "discord" ? (
      // Sized in `em` so it reads as a letter in the word rather than a badge
      // stuck beside it. Its entrance is a CSS animation rather than a tween:
      // the composer re-renders on every keystroke, so an inline ref callback
      // would replay the pop with each letter typed.
      <svg className="iou-mark" fill="#5865f2" role="img" aria-label="Discord" viewBox="0 0 127.14 96.36">
        <path d={DISCORD_PATH} />
      </svg>
    ) : provider === "email" ? (
      <Mail aria-label="Email" className="iou-mark" role="img" strokeWidth={1.25} />
    ) : provider === "wallet" ? (
      <Wallet aria-label="Wallet" className="iou-mark" role="img" strokeWidth={1.25} />
    ) : null;

  const handleToken = (
    <span className="iou-who" data-token="target" key="target">
      {mark}
      {provider === "x" && display.avatarSrc && draft.target.trim() ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className="iou-avatar"
          data-loaded="false"
          onLoad={(e) => {
            const img = e.currentTarget;
            img.dataset.loaded = "true";
            if (!reduced()) gsap.from(img, { scale: 0.4, autoAlpha: 0, duration: 0.36, ease: "back.out(1.8)" });
          }}
          src={display.avatarSrc}
        />
      ) : null}
      {/* The "@" belongs to X handles only — Discord, email and wallets don't
          carry one, and providerDisplay is where that rule already lives. It sits
          outside the sizing slot because the mirror is hidden: anything inside it
          is measured, never seen. */}
      {display.prefix ? <span className="iou-static">{display.prefix}</span> : null}
      {/* Compacted, the slot measures the SHORT text and the input's own glyphs
          go transparent, so a 42-character address occupies eleven characters of
          sentence instead of three lines of it. The value is untouched — this is
          a display, not a truncation, and the caret still shows. */}
      <span className="iou-slot" data-compact={compact ? "" : undefined}>
        <span aria-hidden className="iou-mirror">
          {compact || draft.target || "someone"}
        </span>
        {compact ? (
          <span aria-hidden className="iou-compact">
            {compact}
          </span>
        ) : null}
        <input
          aria-label="Who — a handle, an email address, or a wallet address"
          autoComplete="off"
          className="iou-field"
          onBlur={() => setTargetFocused(false)}
          onChange={(e) => set({ target: e.target.value.replace(/^@/, "") })}
          onFocus={() => setTargetFocused(true)}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          placeholder="someone"
          ref={targetRef}
          spellCheck={false}
          value={draft.target}
        />
      </span>
    </span>
  );

  const verbToken = (
    <button
      aria-label={`Direction: ${draft.direction === "i-owe" ? "you owe them" : "they owe you"}. Tap to flip.`}
      aria-pressed={draft.direction === "owes-me"}
      className="iou-verb"
      data-token="verb"
      key="verb"
      onClick={toggleDirection}
      type="button"
    >
      {verb}
    </button>
  );

  return (
    <main className="iou-page">
      <div className="iou-rail">
        <Link href="/app">← receipts</Link>
        <span className="iou-rail-end">
          arc testnet
          {/* This page is its own surface — there is no app chrome around it to
              carry the switch, so it sits at the end of the rail it already has.
              Same hook and same Moon/Sun pair as the landing nav, so the choice
              is remembered across both. */}
          <button
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            className="iou-theme"
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
            type="button"
          >
            {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
          </button>
        </span>
      </div>

      <div className="iou-composer" data-revealed={revealed === null ? undefined : revealed}>
        <div className="iou-sentence" data-reveal ref={sentenceRef}>
          {draft.direction === "i-owe" ? (
            <>
              <span className="iou-static" data-token="subject" key="subject">
                I
              </span>
              {verbToken}
              {handleToken}
            </>
          ) : (
            <>
              {handleToken}
              {verbToken}
            </>
          )}
          <span className="iou-money" data-filled={draft.amount !== ""} data-token="amount" key="amount">
            <span className="iou-currency">$</span>
            <span className="iou-slot">
              <span aria-hidden className="iou-mirror iou-amount">
                {draft.amount || "0.00"}
              </span>
              <input
                aria-label="How much"
                autoComplete="off"
                className="iou-field iou-amount"
                inputMode="decimal"
                // Gated live rather than validated after: this number is set at
                // 7rem, and letting junk into it looks like the page is broken.
                // Seven figures is where the gate stops — see typableAmount.
                onChange={(e) => typableAmount(e.target.value) && set({ amount: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && commit()}
                placeholder="0.00"
                value={draft.amount}
              />
            </span>
          </span>
        </div>

        <div className="iou-rule" ref={ruleRef} />

        <div className="iou-note-wrap" data-reveal>
          {/* Empty on the server and until the effect writes into it, which is
              what arms the CSS that hides the real placeholder — so no-JS keeps
              "what for?" and everyone else gets the rotating one. Ordered before
              the input so that rule can be a sibling selector. */}
          <span aria-hidden className="iou-ghost" ref={ghostRef} />
          <input
            aria-label="What for"
            className="iou-note"
            maxLength={120}
            onChange={(e) => set({ note: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            placeholder="what for?"
            ref={noteRef}
            value={draft.note}
          />
        </div>

        <div className="iou-meta" data-reveal>
          {error ? (
            <p className="iou-error" role="status">
              {error}
            </p>
          ) : null}
          {/* Only when the answer isn't already obvious from what was typed —
              an email address and a 0x address both name their own namespace. */}
          {draft.target.trim() && !looksLikeEmail(draft.target) && !looksLikeAddress(draft.target) ? (
            <button className="iou-provider" onClick={() => set({ provider: nextProvider(provider) })} type="button">
              on {provider}
            </button>
          ) : null}
          {/* Who signs: on an ask that's who gets paid, on a settle it's whose
              USDC moves. A choice only when both identities are live; otherwise
              it just names the one that will, and with neither it's the way in. */}
          {signer ? (
            <button
              className="iou-provider"
              disabled={!bothIdentities}
              onClick={() => choosePreferred(signer === "social" ? "wallet" : "social")}
              type="button"
            >
              as {signerLabel}
            </button>
          ) : (
            <button className="iou-provider" disabled={busy} onClick={connectFromMeta} type="button">
              connect a wallet
            </button>
          )}
        </div>

        <button
          className="settle-action"
          data-reveal
          disabled={busy || !ready}
          onClick={commit}
          type="button"
        >
          {busy ? "…" : action} ›
        </button>
      </div>

      <div className="iou-ledger" ref={ledgerRef}>
        <div className="iou-ledger-head">
          <span>open</span>
          <span>{net === 0 ? "square" : net > 0 ? `+$${money(net)} to you` : `−$${money(-net)}`}</span>
        </div>
        {rows.length === 0 ? (
          <p className="iou-empty">Nothing outstanding.</p>
        ) : (
          rows.map((row) => {
            const mine = row.direction === "i-owe";
            const note = "note" in row ? row.note : "";
            const state = "state" in row ? row.state : undefined;
            // A counterparty the dashboard could only label by address renders
            // as "0xab12…cdef", which is not a handle and can't go back into the
            // sentence. Those rows read; they don't recall.
            const recallable = !row.label.includes("…") && state !== "pending";
            return (
              <button
                className="iou-row"
                data-iou-row={row.id}
                data-state={state}
                disabled={!recallable}
                key={row.id}
                onClick={recallRow}
                type="button"
              >
                <span>
                  {mine ? `I owe ${row.label}` : `${row.label} owes me`}
                  {note ? <span className="iou-row-note"> · {note}</span> : null}
                </span>
                <span className="iou-row-amount">${money(row.amountUsd)}</span>
              </button>
            );
          })
        )}
      </div>

      <XAuthControl />
    </main>
  );
}
