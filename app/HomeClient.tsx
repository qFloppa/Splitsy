"use client";

import {
  Bot,
  Check,
  ChevronDown,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
  Moon,
  Sun,
  Wallet,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import confetti from "canvas-confetti";
import gsap from "gsap";
import Image from "next/image";
import Link from "next/link";
import { ChangeEvent, DragEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { getAddress } from "viem";
import { arcTestnet } from "viem/chains";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DiscordIcon, XIcon } from "@/components/landing/ProviderIcons";
import BillVerification from "./BillVerification";
import WalletMark from "./WalletMark";
import XAuthControl from "./XAuthControl";
import SignInMenu from "./SignInMenu";
import XHistoryPanel from "./XHistoryPanel";
import DashboardPanel from "./DashboardPanel";
import IouClient from "./IouClient";
import AgentEconomyPanel from "./AgentEconomyPanel";
import { gatewayReceiptUrl } from "./JobTrail";
import SettlementAgentsPanel, { AGENT_STEPS, type AgentTabState } from "./SettlementAgentsPanel";
import { HistoryCard, PaidBillStamp } from "./HistoryCard";
import { PosterCell, PosterFact, PosterHero, PosterValue, SectionHead, legendOf, type Step } from "./SpecCard";
import { nextProvider, validHandle } from "@/lib/iou";
import {
  bridgeSourceChains,
  bridgeUsdcToArc,
  BridgeSourceChain,
  type BridgeStepEvent,
  type BridgeSummary,
  type BrowserWalletSession,
  createBrowserWalletSessionFromConnector,
} from "@/lib/appkit-bridge";
import {
  approveBillRegistry,
  billMetadataHash,
  BILL_SPLIT_REGISTRY_ADDRESS,
  BillActivity,
  BillSplitDebt,
  BillSplitWallet,
  billUnitsToUsdc,
  createBillSplit,
  createBillSplitWallet,
  ensureBillSplitWalletOnArc,
  hashReceiptBytes,
  isBillRegistryConfigured,
  payBillDebtWithMemo,
  readArcUsdcBalance,
  readBillActivity,
  readBillsForSplitter,
  settleBills,
  readDebtsForWallet,
  usdcToBillUnits,
  claimBillFunds,
  refundBillPayment,
} from "@/lib/bill-split-contracts";
import { refundableNow } from "@/lib/treasury";
import { buildSettleItems, settleItemId, type OwnedDebt, type SocialDebt } from "@/lib/settle-items";
import SettleDeck from "./SettleDeck";
import { useSocialDebts } from "@/lib/use-social-debts";
import {
  authorizeRecurringPayment,
  approveUsdc,
  claimRecurringFunds,
  createRecurringTab,
  createRecurringWallet,
  ensureRecurringWalletOnArc,
  readRecurringEvents,
  readRecurringTab,
  readRecurringTabsForWallet,
  RecurringEvent,
  RecurringTabState,
  RecurringWallet,
  unitsToUsdc,
  usdcToUnits,
} from "@/lib/recurring-contracts";
import {
  billDiscount,
  emptyParsedBill,
  equalSplit,
  normalizeParsedBill,
  retotalBill,
  ParsedBill,
  SplitParticipant,
} from "@/lib/snapsplit";
import { newShareToken } from "@/lib/pay-link";
import { providerDisplay } from "@/lib/provider-display";
import { ReputationBadge } from "./ReputationBadge";
import type { AccountProvider, IdentityProvider } from "@/lib/types";
import type { TreasurySettleSelection } from "@/lib/dashboard-types";
import { shouldPayLeg } from "@/lib/treasury";
import { useTheme } from "@/lib/use-theme";
import { arcWalletClient } from "@/lib/wagmi";

// A collapse/expand toggle that survives reloads. null = auto (caller decides
// from list length); an explicit tap persists true/false to localStorage.
// localStorage may be unavailable (private mode) — then it just isn't remembered.
function usePersistedExpand(key: string): [boolean | null, (next: boolean) => void] {
  const [value, setValue] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key);
      // localStorage is an external store and is unreadable during SSR, so
      // hydrating from it in an effect is the only way to avoid a server/client
      // markup mismatch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === "true" || saved === "false") setValue(saved === "true");
    } catch {
      // Keep the auto default.
    }
  }, [key]);
  const set = (next: boolean) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      // Choice still applies for this session.
    }
  };
  return [value, set];
}

type FxQuote = {
  amountUsd: number;
  rate: number;
  source: string;
  asOf: string;
};

// What /api/scout/scan reports back about the agent's run: every nanopayment it
// made, what it cost, and how much of today's cap is left.
type ScoutReport = {
  payments: { endpoint: string; amountUsd: number; tx: string | null; confidence?: number }[];
  totalSpentUsd: number;
  budgetRemainingUsd: number;
  degraded: boolean;
  agent: { address: string; tokenId: string | null };
};

type OcrState = "idle" | "reading" | "ready" | "error";
export type BillRunState = "idle" | "connecting" | "working" | "success" | "error";
type RecurringRunState = "idle" | "connecting" | "working" | "error" | "success";
type AppTab = "bills" | "settle" | "recurring" | "dashboard" | "agents" | "iou";
type RecurringCycle = "test" | "weekly" | "monthly" | "custom";
type RecurringMemberInput = {
  id: string;
  // Holds a 0x wallet address OR an identity handle/email — same dual meaning as
  // SplitParticipant.walletAddress, so a recurring tab can mix members across
  // wallets and platforms just like a one-off bill.
  address: string;
  share: string;
  // How to interpret `address` when it isn't a 0x value. Undefined defaults to
  // "x"; email is auto-detected. Mirrors SplitParticipant.provider.
  provider?: IdentityProvider | "wallet";
};
type FlowStepState = "pending" | "active" | "done" | "error";
// `icon: FlowStepIcon` stood here, mapping each step to a lucide glyph for the
// circle the progress dialog drew around it. The dialog numbers its steps now —
// which is the fact a reader wanted from that circle, and it comes from the
// array — so the field went with the glyph. See ProgressModal.
type FlowStep = {
  key: string;
  label: string;
  hint: string;
  state: FlowStepState;
  explorerUrl?: string;
};
export type ProgressFlow = {
  kind: "pay" | "bridge" | "claim";
  open: boolean;
  // Which deck section owns this flow, as settleItemId(). Lets the Settle deck
  // render the step ticker inside the right section. Null for flows that aren't
  // about a single debt (the multi-position settle, the recurring top-up).
  subjectKey: string | null;
  amountLabel: string;
  contextLabel: string;
  status: "running" | "success" | "error";
  errorMessage: string;
  // Overrides the footer status while running — server-side (Circle wallet)
  // flows have no browser-wallet confirmations to point at.
  runningLabel?: string;
  steps: FlowStep[];
};

// The labels complete the word "every" — the recurring poster sets the interval
// as a sentence ("every week", "every 14 days"), so an option that read "Weekly"
// or "Custom" would not be grammar. "days" is the custom case: picking it puts an
// editable day count in front of it, which is the only difference between the
// four.
const recurringCycleOptions: Array<{ id: RecurringCycle; label: string; seconds: bigint }> = [
  { id: "test", label: "3 minutes", seconds: 3n * 60n },
  { id: "weekly", label: "week", seconds: 7n * 24n * 60n * 60n },
  { id: "monthly", label: "month", seconds: 30n * 24n * 60n * 60n },
  { id: "custom", label: "days", seconds: 30n * 24n * 60n * 60n },
];

// Downscale a receipt photo to <=1000px and re-encode as JPEG q0.7 in the
// browser, so a 2–4 MB phone photo becomes ~80 KB before it's hashed, committed
// on-chain, and uploaded. Returns the exact bytes that get fingerprinted.
async function compressReceipt(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
  if (!blob) throw new Error("Compression failed");
  return new Uint8Array(await blob.arrayBuffer());
}

// A debtor field accepts any target: a 0x wallet address, an email address, or
// an X/Discord handle. Wallet and email are auto-detected from the value; the
// row's provider picker only disambiguates X vs Discord for bare handles.
const looksLikeAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim());
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
// Only called for non-address rows, so "wallet" never reaches the API. Email is
// auto-detected from the value; a bare handle falls back to the picked provider
// (X/Discord), defaulting to X.
const detectRowProvider = (value: string, provider?: IdentityProvider | "wallet"): IdentityProvider =>
  looksLikeEmail(value)
    ? "email"
    : provider === "discord" || provider === "email"
      ? provider
      : "x";
const rowProvider = (p: SplitParticipant): IdentityProvider => detectRowProvider(p.walletAddress, p.provider);

// base64-encode raw bytes for JSON transport to the publish route.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// A yyyy-mm-dd string from an <input type="date"> → Unix seconds at the END of
// that local day, or undefined for empty/invalid input. `new Date("yyyy-mm-dd")`
// parses as UTC midnight, so we build the date from parts in local time instead
// — the creator means "due that calendar day where they are".
//
// End of day, not midnight, for two reasons: "pay by the 5th" means any time on
// the 5th, and since v2 the registry stores this and REJECTS a due date already
// in the past — local midnight today is always in the past.
function dueDateToUnix(value: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor(date.getTime() / 1000);
}

// A dual-identity user (signed in social + connected browser wallet) has TWO
// Arc wallets that can create/pay/claim bills: their Circle DCW and their own
// non-custodial wallet. Registry rows are tagged with the wallet they were read
// for, so pay/claim can route each bill to the right signer — the server (DCW)
// or the browser wallet — instead of guessing from global connection state.
// Declared in lib/settle-items so the ordering function can be unit-tested
// without pulling this "use client" module into scope. Aliased rather than
// re-declared: two structurally identical types are exactly how they drift.
type OwnedBillSplitDebt = OwnedDebt;

// Which identity signs createBill (and therefore owns the bill + collects the
// payments) when both are available. Persisted so the picker remembers the
// creator's last choice across sessions.
type CreatorIdentity = "wallet" | "social";
const CREATOR_IDENTITY_KEY = "splitsy-creator-identity";

// The paper trail at the foot of the dashboard tab, continuing the numbering of
// the four readings DashboardPanel draws above it. Keyed rather than an array
// because these three are mutually exclusive views of the same thing, not a
// sequence — `empty` stands in for `handle` when there is nothing to list, which
// is why it takes the same 05 and never appears beside it.
//
// Named for the same reason every other section here is: see SectionHead in
// SpecCard.tsx. Not in DashboardPanel's own contents rail, which indexes the four
// readings only — the trail is a coda, and it was outside the rail before it had
// a title too.
const RECORD_STEPS: Record<"handle" | "wallet" | "empty", Step> = {
  handle: { index: "05", kicker: "By handle", title: "Settled for a handle" },
  wallet: { index: "06", kicker: "By wallet", title: "Settled on chain" },
  empty: { index: "05", kicker: "Records", title: "Nothing has settled yet" },
};

export default function HomeClient({ testCycleEnabled = false }: { testCycleEnabled?: boolean }) {  const [activeTab, setActiveTab] = useState<AppTab>("bills");
  // What the agents tab's masthead needs to light its contents rail. Reported up
  // by SettlementAgentsPanel, which is the only thing that knows — same shape as
  // XHistoryPanel's onCount, and for the same reason: the rail is above the
  // sections it indexes.
  const [agentState, setAgentState] = useState<AgentTabState>({ armed: false, granted: 0, decisions: 0 });
  const { theme, setTheme } = useTheme();
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [error, setError] = useState("");
  const [imagePreview, setImagePreview] = useState("");
  // The chosen photo's file name, for the plate's caption. Held separately because
  // the <input type=file> is the only other place it lives, and that isn't
  // reactive — a caption read off the ref would go stale on the next render.
  const [previewName, setPreviewName] = useState("");
  // The compressed receipt bytes + their keccak256, captured at scan time so the
  // exact image can be committed on-chain and published for payers to eyeball.
  // Null for hand-entered bills (no photo).
  const [receiptCommit, setReceiptCommit] = useState<{ bytes: Uint8Array; hash: `0x${string}` } | null>(null);
  const [isDraggingBill, setIsDraggingBill] = useState(false);
  const [manualBillEntry, setManualBillEntry] = useState(false);
  const [bill, setBill] = useState<ParsedBill>({
    ...emptyParsedBill,
    merchant: "Upload a bill",
  });
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  // What Scout did and spent on the last scan — rendered as a receipt under the
  // parsed bill. Null when no agent ran (unconfigured Scout, or manual entry).
  const [scoutReport, setScoutReport] = useState<ScoutReport | null>(null);
  const [splitMode, setSplitMode] = useState<"equal" | "manual">("equal");
  // Optional "pay by" date for the split, as a yyyy-mm-dd string from a <input
  // type=date> ("" = no due date). Committed into the on-chain metadata hash and
  // used to grade payment-reputation timeliness; absent leaves scoring unchanged.
  const [dueDateInput, setDueDateInput] = useState("");
  const [escrowUntilFull, setEscrowUntilFull] = useState(false);
  // "Anyone can pay": mints a share link at creation. Off by default — a bill
  // that anyone holding a URL can pay into is a choice, not a default.
  const [publicPayLink, setPublicPayLink] = useState(false);
  // Set on success by BOTH creation paths, so the confirmation can offer the
  // link regardless of which wallet wrote the bill.
  const [shareLinkUrl, setShareLinkUrl] = useState<string>("");
  // The number the confirmation poster sets as its headline. It cannot read
  // submittedBillId for it: that one is scoped to the review panel and is cleared
  // by the resetSplitForm() which is itself what REVEALS the confirmation. Set by
  // both creation paths, cleared when a new bill starts.
  const [liveBillId, setLiveBillId] = useState<string>("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [bridgeSession, setBridgeSession] = useState<BrowserWalletSession | null>(null);
  const [recurringCycle, setRecurringCycle] = useState<RecurringCycle>("weekly");
  const [customCycleDays, setCustomCycleDays] = useState("30");
  const [billWallet, setBillWallet] = useState<BillSplitWallet | null>(null);
  const [billState, setBillState] = useState<BillRunState>("idle");
  const [billMessage, setBillMessage] = useState("");
  const [debtMessages, setDebtMessages] = useState<Record<string, { message: string; tone: "error" | "neutral" | "success" }>>({});
  const [progressFlow, setProgressFlow] = useState<ProgressFlow | null>(null);
  const [submittedBillId, setSubmittedBillId] = useState<bigint | null>(null);
  const [debts, setDebts] = useState<OwnedBillSplitDebt[]>([]);
  const [splitterBills, setSplitterBills] = useState<OwnedBillSplitDebt[]>([]);
  const [arcUsdcBalance, setArcUsdcBalance] = useState<bigint | null>(null);
  const [partialPayments, setPartialPayments] = useState<Record<string, string>>({});
  const [claimAmounts, setClaimAmounts] = useState<Record<string, string>>({});
  const [participantShareInputs, setParticipantShareInputs] = useState<Record<string, string>>({});
  // Off-chain (social) history count, reported up by the self-fetching X history
  // panel so the shared History panel can gate across both debt systems.
  const [socialHistoryCount, setSocialHistoryCount] = useState(0);
  // The off-chain debts owed by the signed-in handle. The Settle deck wants them
  // as data rather than as rows, so the fetch lives here now.
  const { debts: socialDebts, reload: reloadSocialDebts } = useSocialDebts();
  // The signed-in Splitsy user (social creator), if any — lets a DCW user create
  // an on-chain bill server-side without a browser wallet. Provider + handle are
  // kept so the split form can reject the creator tagging themselves.
  const [me, setMe] = useState<{
    walletAddress: string | null;
    provider: IdentityProvider | null;
    handle: string | null;
  } | null>(null);
  // Which of the user's two identities creates a bill when BOTH are live (signed
  // in social + connected browser wallet). Defaults to the browser wallet — the
  // pre-picker behavior — and remembers the last explicit choice.
  const [creatorIdentity, setCreatorIdentity] = useState<CreatorIdentity>("wallet");
  const [recurringWallet, setRecurringWallet] = useState<RecurringWallet | null>(null);
  const [recurringState, setRecurringState] = useState<RecurringRunState>("idle");
  const [recurringMessage, setRecurringMessage] = useState("");
  const [recurringCreateMessage, setRecurringCreateMessage] = useState("");
  const [recurringCreateMessageTone, setRecurringCreateMessageTone] = useState<"error" | "neutral" | "success">("neutral");
  const [recurringTotalUsd, setRecurringTotalUsd] = useState("200.00");
  const [recurringCycleCount, setRecurringCycleCount] = useState("3");
  const [recurringSplitMode, setRecurringSplitMode] = useState<"equal" | "manual">("equal");
  const [recurringMembers, setRecurringMembers] = useState<RecurringMemberInput[]>([
    { id: "rec-member-1", address: "", share: "0.00", provider: "wallet" },
    { id: "rec-member-2", address: "", share: "0.00", provider: "wallet" },
  ]);
  const [tabAddressInput, setTabAddressInput] = useState("");
  const [activeTabAddress, setActiveTabAddress] = useState<`0x${string}` | null>(null);
  const [tabState, setTabState] = useState<RecurringTabState | null>(null);
  const [walletTabs, setWalletTabs] = useState<RecurringTabState[]>([]);
  const [tabEvents, setTabEvents] = useState<RecurringEvent[]>([]);
  const [authorizationAmount, setAuthorizationAmount] = useState("");
  const [participants, setParticipants] = useState<SplitParticipant[]>([
    {
      id: "payer-1",
      label: "Payer 1",
      walletAddress: "",
      amountUsd: 0,
      status: "unpaid",
    },
    {
      id: "payer-2",
      label: "Payer 2",
      walletAddress: "",
      amountUsd: 0,
      status: "unpaid",
    },
  ]);
  const { address, connector } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();

  // Which address to read the registry for: the connected browser wallet, or —
  // for a signed-in social user with no browser wallet — their DCW address, so
  // their registry debts/claims load without ever connecting a wallet. This is
  // the PRIMARY address (balance display, render gating); refreshBillRegistry
  // itself reads bills/debts for BOTH identity wallets when both are live.
  const registryReadAddress = (billWallet?.account ?? me?.walletAddress ?? null) as `0x${string}` | null;
  // The wallet the recurring tab UI reads and acts for: the connected browser
  // wallet, or — for a social user with no browser wallet — their Circle DCW.
  // When it's the DCW, authorize/revoke/claim route through the server (PIN
  // gated) instead of a browser signature, mirroring the one-off pay/claim flow.
  const recurringActingAccount = (recurringWallet?.account ?? me?.walletAddress ?? null) as `0x${string}` | null;
  const recurringViaServer = !recurringWallet && Boolean(me?.walletAddress);
  const socialWalletAddress = (me?.walletAddress ?? null) as `0x${string}` | null;
  // The browser wallet the split form would sign with: the built app wallet, or
  // the raw wagmi connection while the app wallet is still being (re)built.
  const connectedWalletAccount = (billWallet?.account ?? address ?? null) as `0x${string}` | null;
  // Both identities live → the split form shows the "Create as" picker and the
  // submit honors it. With one (or neither), there is nothing to choose.
  const canChooseCreator = Boolean(socialWalletAddress && connectedWalletAccount);
  const createAsSocial = Boolean(socialWalletAddress) && (!connectedWalletAccount || (canChooseCreator && creatorIdentity === "social"));
  // How the social option reads in the "Create as" picker: "@handle" for X,
  // bare handle for Discord, the email address for email identities.
  const socialCreatorLabel = (() => {
    if (!me?.handle) return "Splitsy wallet";
    const display = providerDisplay({ provider: me.provider, handle: me.handle });
    return `${display.prefix}${display.label}`;
  })();
  useEffect(() => {
    if (registryReadAddress) void refreshBillRegistry(registryReadAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryReadAddress, socialWalletAddress]);

  // Load recurring tabs when the social (DCW) identity becomes available — even
  // if a browser wallet is already connected, since its earlier sweep ran before
  // the social address existed and so misses the DCW-side tabs (e.g. settler on
  // one tab via wallet, payer on another via social). Wallet connections sweep
  // from connectWallets(), which unions in the social address when present.
  useEffect(() => {
    if (socialWalletAddress) void refreshRecurringTabsForWallet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socialWalletAddress]);

  // On-chain debts still owed.
  //
  // A refundable debt belongs here even with nothing remaining: the payer who
  // settled their whole share is exactly the person a failed all-or-nothing bill
  // owes money back to, and filtering on `remaining > 0` alone would hide them.
  // Safe to read the clock in render — `debts` starts empty and only fills from
  // a client effect, so no row exists at hydration time to mismatch.
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const activeWalletDebts = registryReadAddress
    ? debts.filter((debt) => debt.remaining > 0n || refundableNow(debt, debt.paid, nowSeconds) > 0n)
    : [];
  // The Settle tab's badge, from the same ordering function the deck renders, so
  // the two can't disagree about what's pending. Chrome sections don't count.
  const settleCount = buildSettleItems({
    socialDebts,
    walletDebts: activeWalletDebts,
    splitterBills,
    nowSeconds,
  }).filter((item) => item.kind !== "divider" && item.kind !== "end").length;
  // Whether the wallet side has any history record (paid / pending-as-creditor /
  // claimed), so the shared History panel can show one empty state across both
  // the social and wallet systems.
  const walletHistoryEmpty =
    !billWallet ||
    (debts.every((debt) => debt.remaining > 0n) &&
      splitterBills.every((debt) => debt.totalPaid >= debt.totalOwed) &&
      splitterBills.every((debt) => !(debt.claimable <= 0n && debt.claimed > 0n)));

  const confirmedUsd = fxQuote?.amountUsd ?? (bill.currency === "USD" ? bill.total : 0);
  const displayParticipants = useMemo(() => {
    return splitMode === "equal" ? equalSplit(confirmedUsd, participants) : participants;
  }, [confirmedUsd, participants, splitMode]);
  const splitTotal = displayParticipants.reduce((sum, participant) => sum + participant.amountUsd, 0);
  const splitDelta = Number((confirmedUsd - splitTotal).toFixed(2));
  // "Total USD" is the full amount across the whole schedule. Each member's
  // Share is their overall share of that total (Total ÷ members) — independent
  // of the cycle count. The contract's per-cycle fixedShare is derived in
  // buildRecurringPlan by dividing by cycles.
  const recurringShareUsd =
    recurringMembers.length > 0 ? Number(recurringTotalUsd || "0") / recurringMembers.length : 0;
  const availableRecurringCycleOptions = useMemo(
    () => recurringCycleOptions.filter((option) => option.id !== "test" || testCycleEnabled),
    [testCycleEnabled],
  );
  const displayRecurringMembers = useMemo(
    () =>
      recurringSplitMode === "equal"
        ? recurringMembers.map((member) => ({ ...member, share: recurringShareUsd.toFixed(2) }))
        : recurringMembers,
    [recurringMembers, recurringShareUsd, recurringSplitMode],
  );
  const billIsScanned = ocrState === "ready";
  const showBillEditor = billIsScanned || manualBillEntry;
  const billReadyForSplit = billIsScanned || (manualBillEntry && confirmedUsd > 0);
  const usdRate = fxQuote?.rate ?? 1;
  // Scout buys the FX quote after the scan so the bill can render immediately.
  // Until it lands, usdRate is 1 and the amounts are still in the origin
  // currency — the UI must say so instead of mislabelling them as USD.
  const fxPending = ocrState === "ready" && bill.currency !== "USD" && !fxQuote;
  const amountUnit = fxPending ? bill.currency : "USD";
  const originCurrency = fxQuote?.source ?? bill.currency;
  // A discount is shown as a note, not a field — the total already carries it.
  const discountShown = Number((billDiscount(bill) * usdRate).toFixed(2));
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const receiptPrintRef = useRef<HTMLDivElement | null>(null);
  const reviewBillRef = useRef<HTMLDivElement | null>(null);
  const reviewSplitRef = useRef<HTMLDivElement | null>(null);
  const settlementStampRef = useRef<HTMLDivElement | null>(null);
  const totalUsdScrollTimerRef = useRef<ReturnType<Window["setTimeout"]> | null>(null);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => setMe(d.user ?? null)).catch(() => {});
  }, []);

  // Restore the last "Create as" choice. localStorage may be unavailable
  // (private mode) — the "wallet" default then stands.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CREATOR_IDENTITY_KEY);
      if (saved === "social" || saved === "wallet") setCreatorIdentity(saved);
    } catch {
      // Keep the default.
    }
  }, []);

  function chooseCreatorIdentity(next: CreatorIdentity) {
    setCreatorIdentity(next);
    try {
      window.localStorage.setItem(CREATOR_IDENTITY_KEY, next);
    } catch {
      // Full/unavailable storage — the choice still applies for this session.
    }
  }

  useEffect(() => {
    if (!testCycleEnabled && recurringCycle === "test") {
      setRecurringCycle("weekly");
    }
  }, [recurringCycle, testCycleEnabled]);

  useEffect(() => {
    if (ocrState !== "ready" || !receiptPrintRef.current) {
      return;
    }

    const rows = receiptPrintRef.current.querySelectorAll("[data-receipt-row]");
    gsap.fromTo(
      rows,
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.28, stagger: 0.055, ease: "power2.out" },
    );
  }, [ocrState, bill.lineItems.length]);

  useEffect(() => {
    if (!showBillEditor || !reviewBillRef.current) {
      return;
    }

    window.requestAnimationFrame(() => {
      reviewBillRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [showBillEditor]);

  useEffect(() => {
    if (!manualBillEntry || confirmedUsd <= 0) {
      return;
    }

    if (totalUsdScrollTimerRef.current) {
      window.clearTimeout(totalUsdScrollTimerRef.current);
    }

    totalUsdScrollTimerRef.current = window.setTimeout(() => {
      reviewSplitRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      totalUsdScrollTimerRef.current = null;
    }, 850);

    return () => {
      if (totalUsdScrollTimerRef.current) {
        window.clearTimeout(totalUsdScrollTimerRef.current);
        totalUsdScrollTimerRef.current = null;
      }
    };
  }, [manualBillEntry, confirmedUsd]);

  useEffect(() => {
    if (billState !== "success" || !settlementStampRef.current) {
      return;
    }

    gsap.fromTo(
      settlementStampRef.current,
      { opacity: 0, scale: 1.22, rotate: -12 },
      { opacity: 1, scale: 1, rotate: -7, duration: 0.42, ease: "back.out(2)" },
    );
  }, [billState, submittedBillId]);

  async function parseBill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const image = formData.get("image");

    if (!(image instanceof File) || image.size === 0) {
      setError("Choose a bill photo first.");
      return;
    }

    setOcrState("reading");
    setError("");
    setFxQuote(null);
    // A new bill starts with a clean slate: the previous bill's "Bill #N is
    // live" success would otherwise still be sitting in the split panel.
    clearBillFlowState();

    // Scout (the nanopayment agent) drives the scan: it judges the photo, pays
    // Splitsy's x402 OCR endpoint in USDC fractions, and buys a second opinion
    // when its own parse comes back unsure. `declined` means it refused to spend
    // on an unreadable image — that is a real answer, not an error to retry.
    const response = await fetch("/api/scout/scan", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();

    if (!response.ok || payload.declined || !payload.bill) {
      setOcrState("error");
      setError(payload.declined ?? payload.error ?? "Receipt scan failed.");
      setScoutReport(null);
      return;
    }

    const parsed = normalizeParsedBill(payload.bill);
    setBill(parsed);
    setScoutReport(payload.agent ? payload : null);
    setManualBillEntry(false);
    setOcrState("ready");

    // Capture the exact image we scanned — compressed, then fingerprinted — so
    // this receipt (not a later substitute) is what gets committed on-chain and
    // shown to payers. Best-effort: a compression hiccup just means no receipt
    // commitment, never a failed scan.
    try {
      const bytes = await compressReceipt(image);
      setReceiptCommit({ bytes, hash: hashReceiptBytes(bytes) });
    } catch {
      setReceiptCommit(null);
    }

    if (parsed.currency === "USD") {
      setFxQuote({
        amountUsd: parsed.total,
        rate: 1,
        source: "USD",
        asOf: new Date().toISOString(),
      });
      return;
    }

    // Scout already bought the FX quote as part of the scan when the bill is in a
    // foreign currency — reuse it rather than paying for the same rate twice.
    if (payload.fx) {
      setFxQuote(payload.fx);
      return;
    }

    await quoteFx(parsed.total, parsed.currency);
  }

  async function quoteFx(amount: number, currency: string) {
    setError("");
    const response = await fetch("/api/scout/fx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, fromCurrency: currency }),
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "FX conversion failed.");
      return;
    }

    setFxQuote(payload);

    // Scout buys the quote separately from the scan so the bill can render
    // first — fold that payment back into the on-screen receipt.
    if (payload.paid) {
      setScoutReport((current) =>
        current
          ? {
              ...current,
              payments: [
                ...current.payments,
                { endpoint: "/api/fx", amountUsd: payload.paid.amountUsd, tx: payload.paid.tx },
              ],
              totalSpentUsd: current.totalSpentUsd + payload.paid.amountUsd,
              budgetRemainingUsd: Math.max(0, current.budgetRemainingUsd - payload.paid.amountUsd),
            }
          : current,
      );
    }
  }

  // Message/state left over from the last created bill. Cleared whenever a new
  // bill is started, so nothing from the previous one (or from a settlement)
  // lingers in the "Review your split" panel.
  function clearBillFlowState() {
    setBillMessage("");
    setBillState("idle");
    setSubmittedBillId(null);
    setLiveBillId("");
    setLinkCopied(false);
  }

  function updateBillField(field: keyof ParsedBill, value: string) {
    setBill((current) =>
      normalizeParsedBill({
        ...current,
        [field]: field === "merchant" || field === "currency" ? value : Number(value),
      }),
    );
    setFxQuote(null);
  }

  function updateBillUsdField(field: keyof ParsedBill, value: string) {
    const nextUsd = Number(value);
    const nextSourceValue = usdRate > 0 ? nextUsd / usdRate : nextUsd;
    const edited = normalizeParsedBill({
      ...bill,
      [field]: Number.isFinite(nextSourceValue) ? nextSourceValue : 0,
    });
    // Editing a component re-derives the total; editing the total is the user
    // overriding it outright.
    const next = field === "total" ? edited : retotalBill(bill, edited);
    setBill(next);
    // The split spends fxQuote.amountUsd, so every path that moves the total —
    // including a component edit — has to move the converted amount with it.
    if (fxQuote) {
      setFxQuote({ ...fxQuote, amountUsd: Number((next.total * usdRate).toFixed(2)) });
    }
  }

  function updateParticipant(id: string, field: keyof SplitParticipant, value: string) {
    setParticipants((current) =>
      current.map((participant) =>
        participant.id === id
          ? {
              ...participant,
              [field]: field === "amountUsd" ? Number(value) : value,
            }
          : participant,
      ),
    );
  }

  function updateParticipantShare(id: string, value: string) {
    // Nobody owes a negative share. Clamping only the stored number would leave
    // the field reading "-5" while the row charged $0.
    const nextAmount = Number(value);
    setParticipantShareInputs((current) => ({ ...current, [id]: nextAmount < 0 ? "0" : value }));

    setParticipants((current) =>
      current.map((participant) =>
        participant.id === id
          ? {
              ...participant,
              amountUsd: Number.isFinite(nextAmount) && nextAmount >= 0 ? nextAmount : 0,
            }
          : participant,
      ),
    );
  }

  function addParticipant() {
    setParticipants((current) => [
      ...current,
      {
        id: `payer-${Date.now()}`,
        label: `Payer ${current.length + 1}`,
        walletAddress: "",
        amountUsd: 0,
        status: "unpaid",
      },
    ]);
  }

  function removeParticipant(id: string) {
    setParticipants((current) => current.filter((participant) => participant.id !== id));
    setParticipantShareInputs((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function connectWallets() {
    const activeConnector = connector ?? connectors[0];

    if (!activeConnector) {
      setBillState("error");
      setBillMessage("No EVM browser wallet found. Install a wallet supported by wagmi, then try again.");
      setRecurringState("error");
      setRecurringMessage("No EVM browser wallet found. Install a wallet supported by wagmi, then try again.");
      return null;
    }

    setBillState("connecting");
    setBillMessage("");
    setRecurringState("connecting");
    setRecurringMessage("");

    try {
      if (!address) {
        await connectAsync({ connector: activeConnector, chainId: arcTestnet.id });
      }
      const nextWalletClient = await arcWalletClient();
      const [bill, recurring] = await Promise.all([
        createBillSplitWallet(nextWalletClient),
        createRecurringWallet(nextWalletClient),
      ]);
      setBillWallet(bill);
      setRecurringWallet(recurring);
      setBillState("idle");
      setRecurringState("idle");
      // Connecting is always a precursor to an action (split, pay, claim) that
      // sets its own status message, so don't leave a stray "Connected …" note
      // behind — it surfaces in the post-claim success area and the "Review your
      // split" panel where it's just noise.
      setBillMessage("");
      setRecurringMessage("");
      await Promise.all([
        refreshBillRegistry(bill.account),
        refreshRecurringTabsForWallet(recurring.account),
      ]);
      setBridgeSession(
        await createBrowserWalletSessionFromConnector({
          connector: activeConnector,
          connectedAddress: bill.account,
        }),
      );
      return { bill, recurring };
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
      return null;
    }
  }

  async function connectBillWallet() {
    const connected = await connectWallets();
    return connected?.bill ?? null;
  }

  function resetAccountState() {
    setBridgeSession(null);
    setBillWallet(null);
    setRecurringWallet(null);
    setDebts([]);
    setSplitterBills([]);
    setPartialPayments({});
    setClaimAmounts({});
    setDebtMessages({});
    setWalletTabs([]);
    setTabState(null);
    setTabEvents([]);
    setActiveTabAddress(null);
    setTabAddressInput("");
    setAuthorizationAmount("");
  }

  function disconnectWallets() {
    void disconnectAsync();
    resetAccountState();
    setBillMessage("Wallet disconnected.");
    setBillState("idle");
    setRecurringMessage("Wallet disconnected.");
    setRecurringState("idle");
  }

  // Reads bills/debts for EVERY live identity wallet (browser wallet and/or the
  // signed-in user's Circle DCW) and merges them, tagging each row with the
  // wallet it belongs to. `account` force-includes an address whose state
  // update hasn't committed yet (e.g. right after connecting); it is also the
  // primary address whose balance feeds the legacy single-balance display.
  async function refreshBillRegistry(account: `0x${string}` | undefined = registryReadAddress ?? undefined) {
    const social = socialWalletAddress;
    const seen = new Set<string>();
    const targets: { account: `0x${string}`; via: "wallet" | "social" }[] = [];
    for (const candidate of [account, billWallet?.account, social]) {
      if (!candidate) continue;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ account: candidate, via: social && key === social.toLowerCase() ? "social" : "wallet" });
    }
    if (targets.length === 0) {
      return;
    }

    try {
      const perAccount = await Promise.all(
        targets.map(async ({ account: target, via }) => {
          const [targetDebts, targetSplitterBills, balance] = await Promise.all([
            readDebtsForWallet(target),
            readBillsForSplitter(target),
            readArcUsdcBalance(target),
          ]);
          return { account: target, via, debts: targetDebts, splitterBills: targetSplitterBills, balance };
        }),
      );
      const nextDebts: OwnedBillSplitDebt[] = perAccount.flatMap(({ account: owner, via, debts: rows }) =>
        rows.map((debt) => ({ ...debt, account: owner, via })),
      );
      const nextSplitterBills: OwnedBillSplitDebt[] = perAccount.flatMap(({ account: owner, via, splitterBills: rows }) =>
        rows.map((debt) => ({ ...debt, account: owner, via })),
      );
      // Keep fully-paid debts in state so the debtor retains a shrunk, stamped record of what they paid.
      setDebts(nextDebts);
      setSplitterBills(nextSplitterBills);
      setArcUsdcBalance(perAccount[0].balance);
      setPartialPayments((current) => ({
        ...Object.fromEntries(
          nextDebts.map((debt) => [debt.billId.toString(), billUnitsToUsdc(debt.remaining)]),
        ),
        ...current,
      }));
      setClaimAmounts((current) => ({
        ...Object.fromEntries(
          nextSplitterBills.map((debt) => [debt.billId.toString(), billUnitsToUsdc(debt.claimable)]),
        ),
        ...current,
      }));
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
    }
  }

  // After a bridge mints on Arc, the RPC node can lag a block or two behind the
  // claim before it reports the new balance. Poll briefly until it moves past
  // `previousBalance` (or we run out of attempts) so the UI updates on its own.
  async function refreshArcUsdcBalance(account: `0x${string}`, previousBalance: bigint | null = arcUsdcBalance) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const next = await readArcUsdcBalance(account);
        setArcUsdcBalance(next);
        if (previousBalance === null || next !== previousBalance) return;
      } catch {
        // Swallow transient RPC errors and try again on the next tick.
      }

      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
  }

  // Clear the whole split form back to its initial state after a successful
  // submit, so the same bill can't be written to Arc twice by re-clicking.
  function resetSplitForm() {
    setBill({ ...emptyParsedBill, merchant: "Upload a bill" });
    setFxQuote(null);
    setOcrState("idle");
    setManualBillEntry(false);
    setImagePreview("");
    setReceiptCommit(null);
    setError("");
    setSplitMode("equal");
    setDueDateInput("");
    setEscrowUntilFull(false);
    setPublicPayLink(false);
    setParticipantShareInputs({});
    setSubmittedBillId(null);
    setParticipants([
      { id: "payer-1", label: "Payer 1", walletAddress: "", amountUsd: 0, status: "unpaid" },
      { id: "payer-2", label: "Payer 2", walletAddress: "", amountUsd: 0, status: "unpaid" },
    ]);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }

  // On-chain path that ALSO accepts @handle participants. Social rows are resolved
  // to Arc addresses server-side (pre-minting a DCW when needed); then the chosen
  // creator identity signs createBill: the connected browser wallet, or — for a
  // social creator (no browser wallet, or "Create as" set to their social
  // identity) — the server signs it from their Circle DCW.
  async function submitBillOnchainMixed() {
    if (splitMode === "manual" && splitTotal - confirmedUsd > 0.009) {
      setBillState("error");
      setBillMessage("Manual shares cannot be larger than the bill Total USD amount.");
      return;
    }
    // The previous bill's link and number are deliberately NOT cleared by
    // resetSplitForm() (that runs on success and is what reveals the
    // confirmation). Clear them as a new submit starts instead, so a failed
    // create can't leave a stale link on screen.
    setShareLinkUrl("");
    setLiveBillId("");
    setLinkCopied(false);
    const rows = displayParticipants.filter((p) => p.walletAddress.trim());
    if (rows.length === 0) {
      setBillState("error");
      setBillMessage("Add at least one participant with a positive share.");
      return;
    }
    // A tagged payer owing $0 used to be dropped silently — they'd never see the
    // bill and the creator would never know why. Say it instead.
    const zeroRow = rows.find((p) => !(p.amountUsd > 0));
    if (zeroRow) {
      setBillState("error");
      setBillMessage(`"${zeroRow.label || zeroRow.walletAddress.trim()}" has no share — give them an amount above $0 or remove the row.`);
      return;
    }

    // A splitter can't owe themselves. Reject any payer row that is the CHOSEN
    // creator identity ("Create as"): its wallet address, or — when creating as
    // the social identity — the user's own handle/email on the matching
    // provider. The OTHER identity stays a legitimate payer: a dual-identity
    // user can split a bill between their two wallets, e.g. create from the
    // browser wallet and owe a share from their Splitsy (Circle) wallet.
    const creatorAddresses = new Set(
      (createAsSocial ? [me?.walletAddress] : [billWallet?.account, address])
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    );
    const selfAddressRow = rows.find(
      (p) => looksLikeAddress(p.walletAddress) && creatorAddresses.has(p.walletAddress.trim().toLowerCase()),
    );
    if (selfAddressRow) {
      setBillState("error");
      setBillMessage("You can't split a bill with yourself — remove your own wallet address from the payers.");
      return;
    }
    // Tagging your own signed-in handle resolves to your DCW, so it is only a
    // self-row when the DCW is the chosen creator; created from the browser
    // wallet, your social identity is just another payer.
    const meHandle = me?.handle?.trim().replace(/^@/, "").toLowerCase() ?? null;
    const selfSocialRow =
      createAsSocial && me?.provider && meHandle
        ? rows.find(
            (p) =>
              !looksLikeAddress(p.walletAddress) &&
              rowProvider(p) === me.provider &&
              p.walletAddress.trim().replace(/^@/, "").toLowerCase() === meHandle,
          )
        : undefined;
    if (selfSocialRow) {
      setBillState("error");
      setBillMessage(`You can't split a bill with yourself — "${selfSocialRow.walletAddress.trim()}" is your own signed-in account.`);
      return;
    }

    // Build ordered slots; social rows are those whose input isn't a 0x address.
    const isAddr = looksLikeAddress;
    // A row explicitly set to "wallet" must hold a full address — don't silently
    // treat a stray value as an X handle (it could resolve to a real account).
    const badWalletRow = rows.find((p) => p.provider === "wallet" && !isAddr(p.walletAddress));
    if (badWalletRow) {
      setBillState("error");
      setBillMessage(`"${badWalletRow.label || badWalletRow.walletAddress}" needs a full 0x wallet address.`);
      return;
    }
    const socialRows = rows
      .filter((p) => !isAddr(p.walletAddress))
      .map((p) => ({ provider: rowProvider(p), handle: p.walletAddress.trim() }));

    try {
      setBillState("working");

      // Resolve social handles → addresses (pre-mints as needed).
      let resolvedByHandle = new Map<string, string>();
      if (socialRows.length > 0) {
        setBillMessage("Resolving tagged people…");
        const res = await fetch("/api/onchain-bills/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participants: socialRows }),
        });
        const data = await res.json();
        if (!res.ok) {
          setBillState("error");
          setBillMessage(data.error === "insufficient_funds" || res.status === 503
            ? "Wallet service isn't configured, so tagged people can't be added on-chain yet."
            : (data.error ?? "Could not resolve tagged people."));
          return;
        }
        resolvedByHandle = new Map(
          (data.resolved as { provider: string; handle: string; address: string }[])
            .map((r) => [`${r.provider}:${r.handle}`, r.address]),
        );
      }

      // Ordered addresses / owed / labels — labels MUST match the server path
      // (app/api/onchain-bills/create): "@<handle>" for social rows, trimmed
      // label or "Payer N" (1-based among kept rows) for address rows.
      const addresses: string[] = [];
      const owedAmounts: bigint[] = [];
      const labels: string[] = [];
      // Index-aligned with labels; the dashboard's identity buckets read these.
      // Not hashed — display metadata only (see participantProvidersFromSlots).
      const providers: string[] = [];
      for (const [i, p] of rows.entries()) {
        providers.push(isAddr(p.walletAddress) ? "wallet" : rowProvider(p));
        if (isAddr(p.walletAddress)) {
          addresses.push(normalizeAddress(p.walletAddress));
          labels.push(p.label.trim() || `Payer ${i + 1}`);
        } else {
          const norm = p.walletAddress.trim().replace(/^@/, "").toLowerCase();
          const addr = resolvedByHandle.get(`${rowProvider(p)}:${norm}`);
          if (!addr) throw new Error(`Could not resolve @${norm}`);
          addresses.push(addr);
          labels.push(`@${norm}`);
        }
        owedAmounts.push(usdcToBillUnits(p.amountUsd.toFixed(2)));
      }

      // Post-resolution self-check: a tagged handle that resolves to the CHOSEN
      // creator identity's wallet is still a self-row. Handles resolving to the
      // user's other identity are fine — that's the split-with-your-other-wallet
      // case the "Create as" picker enables.
      if (addresses.some((a) => creatorAddresses.has(a.toLowerCase()))) {
        setBillState("error");
        setBillMessage("You can't split a bill with yourself — one of the tagged people resolves to your own wallet.");
        return;
      }

      const receiptHash = receiptCommit?.hash ?? "";
      // yyyy-mm-dd → Unix seconds at local midnight, or undefined for no due
      // date. Both creation paths commit this identically so the payer's re-hash
      // matches. Invalid/empty input leaves it undefined (scoring unchanged).
      const dueDate = dueDateToUnix(dueDateInput);
      // Minted in the browser, not the server: the browser-wallet path publishes
      // its preimage fire-and-forget, so a server-minted token would mean either
      // awaiting that POST or a second round trip before the link could be
      // shown. Publishing a preimage already requires details that hash to the
      // on-chain commitment, so in practice only the creator can set one.
      const shareToken = publicPayLink ? newShareToken() : undefined;

      // Social creator → server signs from their Circle DCW. Either it's the
      // only identity they have, or they explicitly picked it over their
      // connected browser wallet in the "Create as" control.
      if (createAsSocial && me?.walletAddress) {
        setBillMessage("Writing the split to Arc from your wallet…");
        const res = await fetch("/api/onchain-bills/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            merchant: bill.merchant,
            currency: bill.currency,
            total: confirmedUsd,
            participants: rows.map((p) => ({
              provider: isAddr(p.walletAddress) ? undefined : rowProvider(p),
              handle: isAddr(p.walletAddress) ? undefined : p.walletAddress.trim(),
              address: isAddr(p.walletAddress) ? normalizeAddress(p.walletAddress) : undefined,
              label: p.label,
              amountUsd: p.amountUsd,
            })),
            receiptHash,
            receiptImageBase64: receiptCommit ? bytesToBase64(receiptCommit.bytes) : undefined,
            dueDate,
            shareToken,
            escrowUntilFull: Boolean(dueDate) && escrowUntilFull,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setBillState("error");
          setBillMessage(data.error === "insufficient_funds"
            ? "Your wallet needs more test USDC to cover the gas for creating this bill."
            : (data.error ?? "Could not create the bill."));
          return;
        }
        setBillState("success");
        // Prose only. The bill number is the confirmation poster's headline, so
        // repeating "Bill #N is live on Arc" here would set it twice.
        setLiveBillId(String(data.billId));
        setBillMessage("Written from your Splitsy wallet. Everyone you tagged sees their share the moment they sign in — no wallet setup, no address to send them.");
        setShareLinkUrl(shareToken ? `${window.location.origin}/pay/${shareToken}` : "");
        resetSplitForm();
        void refreshBillRegistry();
        return;
      }

      // Otherwise: non-custodial creator signs createBill in their own wallet.
      const wallet = billWallet ?? (await connectBillWallet());
      if (!wallet) return;
      if (!isBillRegistryConfigured()) {
        setBillState("error");
        setBillMessage("Bill registry is not configured yet.");
        return;
      }
      setBillMessage("Switching to Arc Testnet…");
      await ensureBillSplitWalletOnArc(wallet);
      setBillMessage("Writing the split to Arc.");
      const result = await createBillSplit({
        ...wallet,
        metadataHash: billMetadataHash({
          merchant: bill.merchant, currency: bill.currency, total: confirmedUsd,
          participantLabels: labels, receiptHash, dueDate,
        }),
        participants: addresses.map((a) => normalizeAddress(a)),
        owedAmounts,
        // Stored on chain since v2, so "collect at the deadline" is a contract
        // precondition rather than server policy. Escrow is impossible without
        // it — the registry rejects that pair outright.
        dueDate: dueDate ? BigInt(dueDate) : 0n,
        escrowUntilFull: Boolean(dueDate) && escrowUntilFull,
      });
      setSubmittedBillId(result.billId);
      setShareLinkUrl(shareToken ? `${window.location.origin}/pay/${shareToken}` : "");
      setBillState("success");
      setLiveBillId(result.billId.toString());
      setBillMessage("Signed from your own wallet. Each payer settles their own share straight into the bill, and you claim what arrives.");
      const publishedReceipt = receiptCommit;
      resetSplitForm();
      // resetSplitForm() unmounts the review panel and surfaces the "Bill #N is
      // live" confirmation at the top of the bills view — scroll up so the user
      // lands on it instead of the now-empty middle of the page.
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      void fetch("/api/onchain-bills/preimage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registryAddress: BILL_SPLIT_REGISTRY_ADDRESS,
          billId: result.billId.toString(),
          merchant: bill.merchant, currency: bill.currency, total: confirmedUsd,
          participantLabels: labels, participantProviders: providers, receiptHash, dueDate,
          shareToken,
          receiptImageBase64: publishedReceipt ? bytesToBase64(publishedReceipt.bytes) : undefined,
        }),
        // Fire-and-forget, but never silent: a swallowed failure here is how the
        // whole bill silently lost its details (and its identity attribution).
      }).then(async (r) => {
        if (!r.ok) console.error("Publishing the bill preimage failed:", r.status, await r.text());
      }).catch(() => {});
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
    }
  }

  function beginPayFlow(subjectKey: string, billId: string, amountLabel: string) {
    setProgressFlow({
      kind: "pay",
      open: true,
      subjectKey,
      amountLabel,
      contextLabel: `bill #${billId}`,
      status: "running",
      errorMessage: "",
      steps: [
        { key: "switch", label: "Connect to Arc Testnet", hint: "Approve the network switch in your wallet", state: "active" },
        { key: "approve", label: "Approve USDC", hint: "Let the bill registry move your USDC", state: "pending" },
        { key: "pay", label: "Send payment", hint: "Settle the debt on Arc with a memo", state: "pending" },
      ],
    });
  }

  // Server-side (Circle DCW) pay: one POST does approve + payDebt from the
  // user's Circle wallet, so the modal shows both steps but can only observe
  // the round-trip — completeFlow marks them done when the route returns.
  function beginSocialPayFlow(subjectKey: string, contextLabel: string, amountLabel: string) {
    setProgressFlow({
      kind: "pay",
      open: true,
      subjectKey,
      amountLabel,
      contextLabel,
      status: "running",
      errorMessage: "",
      runningLabel: "Processing from your Circle wallet — this can take a moment",
      steps: [
        { key: "approve", label: "Approve USDC", hint: "Your Circle wallet lets the bill registry move USDC", state: "active" },
        { key: "pay", label: "Send payment", hint: "Settle the debt on Arc", state: "pending" },
      ],
    });
  }

  function beginClaimFlow(subjectKey: string, billId: string, amountLabel: string) {
    setProgressFlow({
      kind: "claim",
      open: true,
      subjectKey,
      amountLabel,
      contextLabel: `bill #${billId}`,
      status: "running",
      errorMessage: "",
      runningLabel: "Processing from your Circle wallet — this can take a moment",
      steps: [
        { key: "claim", label: "Claim funds", hint: "Pull paid USDC from the registry to your wallet", state: "active" },
      ],
    });
  }

  function beginBridgeFlow(subjectKey: string | null, amountLabel: string, source: string) {
    setProgressFlow({
      kind: "bridge",
      open: true,
      subjectKey,
      amountLabel,
      contextLabel: `from ${source}`,
      status: "running",
      errorMessage: "",
      steps: [
        { key: "approve", label: "Approve USDC", hint: `Allow CCTP to move USDC on ${source}`, state: "active" },
        { key: "bridge", label: "Bridge via CCTP", hint: "Burn on the source chain, then await Circle's attestation", state: "pending" },
        { key: "claim", label: "Claim on Arc", hint: "Mint the bridged USDC on Arc Testnet", state: "pending" },
      ],
    });
  }

  function setFlowStep(key: string, state: FlowStepState, patch?: Partial<FlowStep>) {
    setProgressFlow((current) =>
      current
        ? { ...current, steps: current.steps.map((step) => (step.key === key ? { ...step, state, ...patch } : step)) }
        : current,
    );
  }

  function advanceFlow(doneKey: string, nextKey?: string) {
    setProgressFlow((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step) =>
              step.key === doneKey
                ? { ...step, state: "done" }
                : step.key === nextKey && step.state !== "done"
                  ? { ...step, state: "active" }
                  : step,
            ),
          }
        : current,
    );
  }

  function completeFlow() {
    setProgressFlow((current) =>
      current
        ? { ...current, status: "success", steps: current.steps.map((step) => ({ ...step, state: "done" })) }
        : current,
    );
    // The Settle deck celebrates once, when it empties — a burst under every
    // card in a deck of bills is noise, not a reward. Every other surface shows
    // ProgressModal and keeps its confetti here.
    if (activeTab !== "settle") fireSuccessConfetti();
  }

  // First error wins. A bridge fails twice on the way out — once as the step that
  // broke, then again as the result state — and the second report is always the
  // vaguer of the two.
  function failFlow(message: string) {
    setProgressFlow((current) =>
      current
        ? {
            ...current,
            status: "error",
            errorMessage: current.errorMessage || message,
            steps: current.steps.map((step) => (step.state === "active" ? { ...step, state: "error" } : step)),
          }
        : current,
    );
  }

  function closeFlow() {
    setProgressFlow((current) => (current ? { ...current, open: false } : current));
  }

  // Off-chain debt tagged to a handle: the server transfers the full amount from
  // the user's Circle wallet. The PIN gate is the same one every server-signed
  // path uses.
  async function paySocialDebt(debt: SocialDebt) {
    const key = `social:${debt.id}`;
    const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
    if (!pin.unlocked) {
      setDebtMessages((current) => ({
        ...current,
        [key]: {
          tone: "neutral",
          message: "Unlock your wallet (the wallet button in the bottom-right corner), then tap Pay again.",
        },
      }));
      return;
    }
    beginSocialPayFlow(key, debt.merchant, debt.amountUsd.toFixed(2));
    try {
      setBillState("working");
      setDebtMessages((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      const res = await fetch(`/api/debts/${debt.id}/pay`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          data.error === "insufficient_funds"
            ? "Your wallet needs more test USDC to cover this."
            : (data.error ?? "Payment failed.");
        setBillState("error");
        failFlow(message);
        setDebtMessages((current) => ({ ...current, [key]: { tone: "error", message } }));
        return;
      }
      setBillState("success");
      completeFlow();
      await reloadSocialDebts();
    } catch (caught) {
      setBillState("error");
      failFlow(errorMessage(caught));
      setDebtMessages((current) => ({ ...current, [key]: { tone: "error", message: errorMessage(caught) } }));
    }
  }

  async function payDebtOnArc(debt: OwnedBillSplitDebt) {
    // Keyed by bill AND account: a dual-identity user can owe the same bill from
    // their browser wallet and their Circle DCW, and one key would let the two
    // rows share an amount input and overwrite each other's messages.
    const debtKey = settleItemId(debt.billId, debt.account);

    // Debt owed by the user's Circle (DCW) wallet — pay from the server, gated
    // by the same PIN unlock the off-chain pay flow uses. The route reads the
    // owed amount from chain and always settles the full remaining debt, so no
    // amount is sent (partial payments aren't supported for Circle wallets).
    if (debt.via === "social" && me?.walletAddress) {
      const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
      if (!pin.unlocked) {
        setDebtMessages((current) => ({
          ...current,
          [debtKey]: { tone: "neutral", message: "Unlock your wallet (the wallet button in the bottom-right corner), then tap Pay again." },
        }));
        return;
      }
      const amountLabel = billUnitsToUsdc(debt.remaining);
      beginSocialPayFlow(debtKey, `bill #${debt.billId}`, amountLabel);
      try {
        setBillState("working");
        setDebtMessages((current) => {
          const next = { ...current };
          delete next[debtKey];
          return next;
        });
        const res = await fetch(`/api/onchain-bills/${debt.billId}/pay`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message = data.error === "insufficient_funds"
            ? "Your wallet needs more test USDC."
            : (data.error ?? "Payment failed.");
          setBillState("error");
          failFlow(message);
          setDebtMessages((current) => ({
            ...current,
            [debtKey]: { tone: "error", message },
          }));
          return;
        }
        completeFlow();
        setBillState("success");
        setDebtMessages((current) => ({
          ...current,
          [debtKey]: { tone: "success", message: `Paid bill #${debt.billId} from your wallet.` },
        }));
        await refreshBillRegistry();
      } catch (caught) {
        setBillState("error");
        failFlow(errorMessage(caught));
        setDebtMessages((current) => ({
          ...current,
          [debtKey]: { tone: "error", message: errorMessage(caught) },
        }));
      }
      return;
    }

    const wallet = billWallet ?? (await connectBillWallet());

    if (!wallet) {
      return;
    }

    const amount = usdcToBillUnits(partialPayments[debtKey] ?? billUnitsToUsdc(debt.remaining));

    if (amount <= 0n || amount > debt.remaining) {
      setBillState("error");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "error", message: "Enter an amount up to the remaining debt." },
      }));
      return;
    }

    const amountLabel = billUnitsToUsdc(amount);
    beginPayFlow(debtKey, debt.billId.toString(), amountLabel);

    try {
      setBillState("working");
      setDebtMessages((current) => {
        const next = { ...current };
        delete next[debtKey];
        return next;
      });
      await ensureBillSplitWalletOnArc(wallet);
      advanceFlow("switch", "approve");

      await approveBillRegistry({ ...wallet, amount });
      advanceFlow("approve", "pay");

      await payBillDebtWithMemo({ ...wallet, billId: debt.billId, amount });
      completeFlow();

      setBillState("success");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "success", message: `Paid ${amountLabel} USDC toward bill #${debt.billId}.` },
      }));
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      failFlow(errorMessage(caught));
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "error", message: errorMessage(caught) },
      }));
    }
  }

  // Take your money back out of a failed all-or-nothing bill. One transaction on
  // both paths — no approval, and no amount, because the registry always returns
  // the caller's whole contribution. Deliberately not folded into `settle`: this
  // is rare, and a refund leg that reverted would take an entire batch with it.
  async function refundOnArc(debt: OwnedBillSplitDebt) {
    // See payDebtOnArc: one key per bill would collide across a user's two wallets.
    const debtKey = settleItemId(debt.billId, debt.account);
    const amountLabel = billUnitsToUsdc(debt.paid);

    const fail = (message: string) => {
      setBillState("error");
      setDebtMessages((current) => ({ ...current, [debtKey]: { tone: "error", message } }));
    };

    const succeed = () => {
      setBillState("success");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "success", message: `Refunded ${amountLabel} USDC from bill #${debt.billId}.` },
      }));
    };

    // Circle (DCW) wallet: the server signs, behind the same PIN unlock the pay
    // flow uses.
    if (debt.via === "social" && me?.walletAddress) {
      const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
      if (!pin.unlocked) {
        setDebtMessages((current) => ({
          ...current,
          [debtKey]: {
            tone: "neutral",
            message: "Unlock your wallet (the wallet button in the bottom-right corner), then tap Get my money back again.",
          },
        }));
        return;
      }
      try {
        setBillState("working");
        const res = await fetch(`/api/onchain-bills/${debt.billId}/refund`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          fail(data.error ?? "Refund failed.");
          return;
        }
        succeed();
        await refreshBillRegistry();
      } catch (caught) {
        fail(errorMessage(caught));
      }
      return;
    }

    const wallet = billWallet ?? (await connectBillWallet());
    if (!wallet) return;

    try {
      setBillState("working");
      await ensureBillSplitWalletOnArc(wallet);
      await refundBillPayment({ ...wallet, billId: debt.billId });
      succeed();
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      fail(errorMessage(caught));
    }
  }

  // "Settle net" from the connected browser wallet: ONE approval for the summed
  // outstanding debt, then one payDebt per bill (escrow binds each debt to its
  // billId — no on-chain netting exists), then claim every funded bill I created.
  // Sequential, not atomic: executeBatch is an SCA feature and this is an EOA —
  // the Circle-wallet path (/api/treasury/settle) is the one-transaction one.
  // Legs are re-read from chain, never taken from the dashboard payload; the
  // selection only narrows WHICH of them run.
  async function settleNetWithWallet(selection?: TreasurySettleSelection) {
    const wallet = billWallet ?? (await connectBillWallet());
    if (!wallet) return;

    const [myDebts, myBills] = await Promise.all([
      readDebtsForWallet(wallet.account),
      readBillsForSplitter(wallet.account),
    ]);
    const chosen = selection?.counterparties
      ? new Set(selection.counterparties.map((a) => a.toLowerCase()))
      : null; // null = every counterparty
    const payLegs = myDebts.filter((d) => shouldPayLeg(d, wallet.account, chosen));
    const claimLegs = selection?.collect === false ? [] : myBills.filter((b) => b.claimable > 0n);
    if (payLegs.length === 0 && claimLegs.length === 0) {
      // Returned, not pushed into billMessage: that bucket belongs to the bills
      // tab, and a settlement note surfacing over "Review your split" reads as
      // if it were about the bill being created. The dashboard shows this.
      return selection ? "Nothing you selected is still outstanding." : "Nothing to settle — every bill is already square.";
    }

    const total = payLegs.reduce((sum, d) => sum + d.remaining, 0n);
    setProgressFlow({
      kind: "pay",
      open: true,
      // Not one debt — no deck section owns it.
      subjectKey: null,
      amountLabel: billUnitsToUsdc(total),
      contextLabel: `${payLegs.length + claimLegs.length} positions`,
      status: "running",
      errorMessage: "",
      // Steps mirror the transactions that will actually run — which since
      // registry v2 is at most two: one approval, then one settle carrying every
      // claim and pay leg. A collect-only settle skips the approval entirely.
      steps: [
        { key: "switch", label: "Connect to Arc Testnet", hint: "Approve the network switch in your wallet", state: "active" as const },
        ...(payLegs.length
          ? ([{ key: "approve", label: "Approve USDC once", hint: "One approval covers every payment below", state: "pending" }] satisfies FlowStep[])
          : []),
        {
          key: "settle",
          label: `Settle ${claimLegs.length + payLegs.length} position${claimLegs.length + payLegs.length === 1 ? "" : "s"}`,
          hint: "One transaction: collect what you are owed, pay what you owe",
          state: "pending",
        },
      ],
    });

    const claimTotal = claimLegs.reduce((sum, b) => sum + b.claimable, 0n);

    try {
      setBillState("working");
      await ensureBillSplitWalletOnArc(wallet);
      advanceFlow("switch", payLegs.length ? "approve" : "settle");

      // A browser EOA has no wallet-level batching, so before registry v2 this
      // was one claim per funded bill plus an approve and a payDebt per debt —
      // N+M+1 wallet prompts. settle() collapses all of it into one call, and
      // the contract runs the claims before the pays so their proceeds fund the
      // payments inside the same transaction.
      if (payLegs.length) {
        await approveBillRegistry({ ...wallet, amount: total });
        advanceFlow("approve", "settle");
      }

      await settleBills({
        ...wallet,
        claimBillIds: claimLegs.map((b) => b.billId),
        payBillIds: payLegs.map((d) => d.billId),
        payAmounts: payLegs.map((d) => d.remaining),
      });
      completeFlow();

      setBillState("success");
      // Say what moved, in both directions — "N positions settled" reads as if
      // the money others owe you arrived too, and it did not.
      const paidPart = payLegs.length
        ? `Paid ${billUnitsToUsdc(total)} USDC across ${payLegs.length} bill${payLegs.length === 1 ? "" : "s"}`
        : "";
      const claimedPart = claimLegs.length
        ? `collected ${billUnitsToUsdc(claimTotal)} USDC from ${claimLegs.length} bill${claimLegs.length === 1 ? "" : "s"}`
        : "";
      const sentence = [paidPart, claimedPart].filter(Boolean).join(" and ");
      await refreshBillRegistry(wallet.account);
      return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} on Arc.`;
    } catch (caught) {
      setBillState("error");
      failFlow(errorMessage(caught));
      throw caught; // the panel surfaces it too
    }
  }

  async function bridgeForDebt(debt: OwnedBillSplitDebt, debtSourceChain: BridgeSourceChain) {
    const session = bridgeSession ?? (await connectForBridge());
    // See payDebtOnArc: this reads the same partialPayments entry the Pay button
    // does, so it must resolve to the same key.
    const debtKey = settleItemId(debt.billId, debt.account);

    if (!session || !billWallet) {
      setBillState("error");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "error", message: "Connect your wallet first so bridged USDC can arrive at your Arc address." },
      }));
      return;
    }

    const amount = usdcToBillUnits(partialPayments[debtKey] ?? billUnitsToUsdc(debt.remaining));

    if (amount <= 0n || amount > debt.remaining) {
      setBillState("error");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "error", message: "Enter an amount up to the remaining debt." },
      }));
      return;
    }

    const source = sourceLabel(debtSourceChain);
    const amountLabel = billUnitsToUsdc(amount);
    const balanceBeforeBridge = arcUsdcBalance;

    beginBridgeFlow(debtKey, amountLabel, source);

    try {
      setBillState("working");
      setDebtMessages((current) => {
        const next = { ...current };
        delete next[debtKey];
        return next;
      });
      const result = await bridgeUsdcToArc({
        session,
        sourceChain: debtSourceChain,
        recipientAddress: billWallet.account,
        amount: amountLabel,
        onStep: (event) => handleBridgeStep(event, source),
      });

      if (result.state === "error") {
        const message = bridgeFailureMessage(result);
        failFlow(message);
        setBillState("error");
        setDebtMessages((current) => ({ ...current, [debtKey]: { tone: "error", message } }));
        return;
      }

      completeFlow();
      setBillState("success");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: {
          tone: "success",
          message:
            "USDC has been bridged to your Arc wallet. Use Pay on Arc to settle the debt with a memo.",
        },
      }));
      // The mint just landed on Arc; poll until the node reports the new balance.
      void refreshArcUsdcBalance(billWallet.account, balanceBeforeBridge);
    } catch (caught) {
      setBillState("error");
      failFlow(errorMessage(caught));
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "error", message: errorMessage(caught) },
      }));
    }
  }

  function handleBridgeStep(event: BridgeStepEvent, source: string) {
    const settled = event.state === "success" || event.state === "noop";

    if (event.state === "error") {
      failFlow(event.errorMessage || `The ${event.method} transaction failed.`);
      return;
    }

    switch (event.method) {
      case "approve":
        if (settled) {
          advanceFlow("approve", "bridge");
        } else {
          setFlowStep("approve", "active");
        }
        break;
      case "burn":
        advanceFlow("approve", "bridge");
        setFlowStep("bridge", "active", {
          hint: settled ? "Burned — waiting for Circle's attestation…" : `Burning USDC on ${source} via CCTP…`,
          explorerUrl: event.explorerUrl,
        });
        break;
      case "fetchAttestation":
      case "reAttest":
        if (settled) {
          advanceFlow("bridge", "claim");
        } else {
          setFlowStep("bridge", "active", { hint: "Waiting for Circle's attestation…" });
        }
        break;
      case "mint":
        advanceFlow("bridge", "claim");
        if (settled) {
          setFlowStep("claim", "done", { explorerUrl: event.explorerUrl });
        } else {
          setFlowStep("claim", "active", { hint: "Minting USDC on Arc Testnet…" });
        }
        break;
    }
  }

  // Recurring counterpart to bridgeForDebt: a payer whose Arc USDC is below the
  // due cycle amount can top up by bridging from a CCTP source chain. It reuses
  // the same progress popup and step handler as the Bills bridge, but mints to
  // the recurring wallet and refreshes the tab so the "Low balance" state clears
  // and the cron settler can pull the approved share next run.
  async function bridgeForRecurring(amountLabel: string, sourceChain: BridgeSourceChain) {
    const session = bridgeSession ?? (await connectForBridge());

    if (!session || !recurringWallet) {
      setRecurringState("error");
      setRecurringMessage("Connect your wallet first so bridged USDC can arrive at your Arc address.");
      return;
    }

    const source = sourceLabel(sourceChain);
    const balanceBeforeBridge = arcUsdcBalance;

    // A recurring top-up, not a debt — nothing in the deck owns it.
    beginBridgeFlow(null, amountLabel, source);

    try {
      setRecurringState("working");
      const result = await bridgeUsdcToArc({
        session,
        sourceChain,
        recipientAddress: recurringWallet.account,
        amount: amountLabel,
        onStep: (event) => handleBridgeStep(event, source),
      });

      if (result.state === "error") {
        const message = bridgeFailureMessage(result);
        failFlow(message);
        setRecurringState("error");
        setRecurringMessage(message);
        return;
      }

      completeFlow();
      setRecurringState("success");
      setRecurringMessage("USDC bridged to your Arc wallet. Approve the tab so the due cycle can be collected.");
      // The mint just landed on Arc; poll until the node reports the new balance,
      // then re-read the tab so the debtor's wallet balance and status update.
      void refreshArcUsdcBalance(recurringWallet.account, balanceBeforeBridge);
      if (activeTabAddress) {
        void refreshRecurringTab(activeTabAddress, true);
      }
    } catch (caught) {
      setRecurringState("error");
      failFlow(errorMessage(caught));
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function claimSplitterFunds(debt: OwnedBillSplitDebt) {
    // See payDebtOnArc: a dual-identity creator can hold the same bill on both
    // wallets, and claimAmounts must not be shared between them.
    const debtKey = settleItemId(debt.billId, debt.account);

    // Bill split by the user's Circle (DCW) wallet — only that wallet can claim,
    // so the server claims it, gated by the same PIN unlock. The route reads the
    // claimable amount from chain and always claims all of it, so no amount is
    // sent (partial claims aren't supported for Circle wallets).
    if (debt.via === "social" && me?.walletAddress) {
      const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
      if (!pin.unlocked) {
        setDebtMessages((current) => ({
          ...current,
          [debtKey]: {
            tone: "neutral",
            message: "Unlock your wallet (the wallet button in the bottom-right corner), then tap Claim again.",
          },
        }));
        return;
      }
      beginClaimFlow(debtKey, debt.billId.toString(), billUnitsToUsdc(debt.claimable));
      try {
        setBillState("working");
        setDebtMessages((current) => ({ ...current, [debtKey]: { tone: "neutral", message: "Claiming paid funds." } }));
        const res = await fetch(`/api/onchain-bills/${debt.billId}/claim`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBillState("error");
          failFlow(data.error ?? "Claim failed.");
          setDebtMessages((current) => ({
            ...current,
            [debtKey]: { tone: "error", message: data.error ?? "Claim failed." },
          }));
          return;
        }
        completeFlow();
        setBillState("success");
        setDebtMessages((current) => ({
          ...current,
          [debtKey]: { tone: "success", message: `Claimed funds from bill #${debt.billId} to your wallet.` },
        }));
        await refreshBillRegistry();
      } catch (caught) {
        setBillState("error");
        failFlow(errorMessage(caught));
        setDebtMessages((current) => ({ ...current, [debtKey]: { tone: "error", message: errorMessage(caught) } }));
      }
      return;
    }

    const wallet = billWallet ?? (await connectBillWallet());

    if (!wallet) {
      return;
    }

    const amount = usdcToBillUnits(claimAmounts[debtKey] ?? billUnitsToUsdc(debt.claimable));

    if (amount <= 0n || amount > debt.claimable) {
      setBillState("error");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "error", message: "Enter an amount up to the claimable balance." },
      }));
      return;
    }

    try {
      setBillState("working");
      setDebtMessages((current) => ({ ...current, [debtKey]: { tone: "neutral", message: "Claiming paid funds." } }));
      await claimBillFunds({ ...wallet, billId: debt.billId, amount });
      setBillState("success");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "success", message: `Claimed ${billUnitsToUsdc(amount)} USDC from bill #${debt.billId.toString()}.` },
      }));
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      setDebtMessages((current) => ({ ...current, [debtKey]: { tone: "error", message: errorMessage(caught) } }));
    }
  }

  function showBillPreview(file: File | null) {
    if (!file) {
      setImagePreview("");
      setPreviewName("");
      return;
    }

    setImagePreview(URL.createObjectURL(file));
    // Bytes as well as the name: the plate's caption is the one place the size of
    // what you are about to spend a scan on is visible.
    setPreviewName(`${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`);
  }

  function updatePreview(event: ChangeEvent<HTMLInputElement>) {
    showBillPreview(event.target.files?.[0] ?? null);
  }

  // Testing convenience: load the bundled /bill.jpg sample into the upload box
  // exactly as if the user picked it, so "Scan receipt" works unchanged.
  async function loadSampleBill() {
    try {
      const res = await fetch("/bill.jpg");

      if (!res.ok) {
        throw new Error("Sample bill missing.");
      }

      const blob = await res.blob();
      const file = new File([blob], "bill.jpg", { type: blob.type || "image/jpeg" });
      const input = imageInputRef.current;

      if (input) {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
      }

      setError("");
      showBillPreview(file);
    } catch {
      setError("Couldn't load the sample bill image.");
    }
  }

  function handleBillDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingBill(true);
  }

  function handleBillDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingBill(false);
  }

  function handleBillDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingBill(false);

    const file = event.dataTransfer.files?.[0];

    if (!file || !file.type.startsWith("image/")) {
      setError("Drop an image of the bill.");
      return;
    }

    const input = imageInputRef.current;

    if (input) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
    }

    setError("");
    showBillPreview(file);
  }

  async function connectForBridge() {
    if (bridgeSession) {
      return bridgeSession;
    }

    if (!connector || !address) {
      setBillState("error");
      setBillMessage("Connect your wallet first.");
      return null;
    }

    try {
      const session = await createBrowserWalletSessionFromConnector({
        connector,
        connectedAddress: address,
      });
      setBridgeSession(session);
      return session;
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
      return null;
    }
  }

  async function connectRecurring() {
    const connected = await connectWallets();
    return connected?.recurring ?? null;
  }

  // Shared validation for both create paths. Members can be 0x addresses OR
  // social handles/emails, exactly like a one-off mixed bill. Returns the
  // schedule + the per-member rows (raw address value, detected provider, and
  // per-cycle share in USD), or throws with a user-facing message.
  function buildRecurringPlan() {
    const totalUsd = Number(recurringTotalUsd);
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      throw new Error("Enter a recurring total greater than 0 USDC.");
    }
    if (recurringMembers.length === 0) {
      throw new Error("Add at least one member.");
    }
    const cycleCountNum = Math.floor(Number(recurringCycleCount));
    if (!Number.isFinite(cycleCountNum) || cycleCountNum < 1) {
      throw new Error("Enter at least 1 cycle.");
    }
    const cycleCount = BigInt(cycleCountNum);
    const sourceMembers = recurringSplitMode === "equal" ? displayRecurringMembers : recurringMembers;
    // Member shares are each member's overall share across the whole schedule,
    // so they must sum to the Total USD. The contract's fixedShare is per-cycle,
    // so divide by the cycle count below.
    const shareTotal = sourceMembers.reduce((sum, member) => sum + Number(member.share || "0"), 0);
    if (sourceMembers.some((member) => Number(member.share || "0") <= 0)) {
      throw new Error("Every recurring member needs a positive share.");
    }
    if (Math.abs(shareTotal - totalUsd) > 0.009) {
      throw new Error(`Member shares must add up to the Total USD of $${totalUsd.toFixed(2)}.`);
    }
    // A row explicitly set to "wallet" must hold a full address.
    const badWalletRow = sourceMembers.find((member) => member.provider === "wallet" && !looksLikeAddress(member.address));
    if (badWalletRow) {
      throw new Error(`"${badWalletRow.address || "A member"}" needs a full 0x wallet address.`);
    }
    if (sourceMembers.some((member) => !member.address.trim())) {
      throw new Error("Every member needs a wallet address or a tagged handle.");
    }

    let intervalSeconds: bigint;
    if (recurringCycle === "custom") {
      const customDays = Number(customCycleDays);
      if (!Number.isInteger(customDays) || customDays < 1) {
        throw new Error("Custom days must be a whole number of at least 1 day.");
      }
      intervalSeconds = BigInt(customDays) * 24n * 60n * 60n;
    } else {
      intervalSeconds =
        availableRecurringCycleOptions.find((option) => option.id === recurringCycle)?.seconds ?? 7n * 24n * 60n * 60n;
    }

    const rows = sourceMembers.map((member) => ({
      address: member.address.trim(),
      // The Share field is the member's overall share; the contract pulls
      // fixedShare every cycle, so per-cycle it's share ÷ cycles.
      shareUsd: Number(member.share || "0") / cycleCountNum,
      provider: detectRowProvider(member.address, member.provider),
      isAddress: looksLikeAddress(member.address),
    }));
    return { intervalSeconds, cycleCount, rows };
  }

  async function createOnchainTab() {
    try {
      setRecurringState("working");
      setRecurringCreateMessageTone("neutral");
      const { intervalSeconds, cycleCount, rows } = buildRecurringPlan();

      // The creator (recipient) can't also be a member. When creating as the
      // social identity the recipient is the DCW; otherwise it's the browser
      // wallet — checked below once we know which wallet signs.
      const socialRows = rows
        .filter((row) => !row.isAddress)
        .map((row) => ({ provider: row.provider, handle: row.address }));

      // Resolve social handles → addresses (pre-mints as needed). Reuses the
      // one-off bills resolver — it's provider-agnostic.
      let resolvedByHandle = new Map<string, string>();
      if (socialRows.length > 0) {
        setRecurringCreateMessage("Resolving tagged people…");
        const res = await fetch("/api/onchain-bills/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participants: socialRows }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setRecurringState("error");
          setRecurringCreateMessageTone("error");
          setRecurringCreateMessage(
            res.status === 503
              ? "Wallet service isn't configured, so tagged people can't be added on-chain yet."
              : (data.error ?? "Could not resolve tagged people."),
          );
          return;
        }
        resolvedByHandle = new Map(
          (data.resolved as { provider: string; handle: string; address: string }[]).map((r) => [
            `${r.provider}:${r.handle}`,
            r.address,
          ]),
        );
      }

      // Ordered addresses / shares. Social rows use their resolved address.
      const members: `0x${string}`[] = [];
      const shares: bigint[] = [];
      for (const row of rows) {
        if (row.isAddress) {
          members.push(normalizeAddress(row.address));
        } else {
          const norm = row.address.replace(/^@/, "").toLowerCase();
          const addr = resolvedByHandle.get(`${row.provider}:${norm}`);
          if (!addr) throw new Error(`Could not resolve @${norm}`);
          members.push(normalizeAddress(addr));
        }
        shares.push(usdcToUnits(row.shareUsd.toFixed(6)));
      }
      if (new Set(members.map((member) => member.toLowerCase())).size !== members.length) {
        throw new Error("Each recurring member resolves to a unique wallet — remove the duplicate.");
      }

      // Social creator → the server signs createTab from the user's Circle DCW,
      // which becomes the tab's recipient. No browser wallet required.
      if (createAsSocial && me?.walletAddress) {
        const recipientLower = me.walletAddress.toLowerCase();
        if (members.some((member) => member.toLowerCase() === recipientLower)) {
          throw new Error("You can't add your own wallet as a member of your recurring tab.");
        }
        setRecurringCreateMessage("Creating recurring tab from your Splitsy wallet…");
        const res = await fetch("/api/recurring/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intervalSeconds: Number(intervalSeconds),
            maxSettlements: Number(cycleCount),
            members: rows.map((row) => ({
              provider: row.isAddress ? undefined : row.provider,
              handle: row.isAddress ? undefined : row.address.trim(),
              address: row.isAddress ? normalizeAddress(row.address) : undefined,
              shareUsd: row.shareUsd,
            })),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setRecurringState("error");
          setRecurringCreateMessageTone("error");
          setRecurringCreateMessage(
            data.error === "insufficient_funds"
              ? "Your wallet needs more test USDC to cover the gas for creating this tab."
              : (data.error ?? "Could not create the recurring tab."),
          );
          return;
        }
        setTabAddressInput(data.tabAddress ?? "");
        if (data.tabAddress) setActiveTabAddress(data.tabAddress);
        setRecurringState("success");
        setRecurringCreateMessageTone("success");
        setRecurringCreateMessage(
          data.tabId
            ? `Created tab #${data.tabId} from your Splitsy wallet. Tagged members will see it after signing in.`
            : "Recurring tab created from your Splitsy wallet.",
        );
        if (data.tabAddress) await refreshRecurringTab(data.tabAddress);
        await refreshRecurringTabsForWallet();
        return;
      }

      // Otherwise: the connected browser wallet signs createTab and is recipient.
      const wallet = recurringWallet ?? (await connectRecurring());
      if (!wallet) {
        setRecurringState("idle");
        return;
      }
      if (members.some((member) => member.toLowerCase() === wallet.account.toLowerCase())) {
        throw new Error("You can't add your own wallet as a member of your recurring tab.");
      }
      setRecurringCreateMessage("Switching to Arc Testnet…");
      await ensureRecurringWalletOnArc(wallet);
      setRecurringCreateMessage("Creating recurring tab on Arc Testnet.");
      const result = await createRecurringTab({
        ...wallet,
        recipient: wallet.account,
        intervalSeconds,
        maxSettlements: cycleCount,
        members,
        fixedShares: shares,
      });

      setTabAddressInput(result.tabAddress);
      setActiveTabAddress(result.tabAddress);
      setRecurringState("success");
      setRecurringCreateMessageTone("success");
      setRecurringCreateMessage(`Created tab #${result.tabId.toString()} at ${shortAddress(result.tabAddress)}.`);
      await refreshRecurringTab(result.tabAddress);
      await refreshRecurringTabsForWallet(wallet.account);
    } catch (caught) {
      setRecurringState("error");
      setRecurringCreateMessageTone("error");
      setRecurringCreateMessage(errorMessage(caught));
    }
  }

  // A quiet refresh keeps whatever action message is on screen (e.g. "Approved…")
  // instead of clobbering it with "Loading tab state…" / "Loaded 0x…".
  async function refreshRecurringTab(address = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput), quiet = false) {
    if (!address) {
      setRecurringState("error");
      setRecurringMessage("Enter a tab contract address.");
      return;
    }

    try {
      if (!quiet) {
        setRecurringState("working");
        setRecurringMessage("Loading tab state from Arc.");
      }
      const state = await readRecurringTab(address);
      const events = await readRecurringEvents(address).catch(() => []);
      setActiveTabAddress(address);
      setTabAddressInput(address);
      setTabState(state);
      setTabEvents(events);
      if (!quiet) {
        setRecurringState("idle");
        setRecurringMessage(`Loaded ${shortAddress(address)}.`);
      }
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function refreshRecurringTabsForWallet(account = recurringActingAccount ?? undefined, quiet = false) {
    // Read tabs for BOTH identity wallets (connected browser wallet + social
    // DCW) so a dual-identity user sees all their recurring tabs at once —
    // including being settler on one tab and payer on another.
    const accounts = [
      ...new Set(
        [account, recurringWallet?.account, socialWalletAddress].filter((value): value is `0x${string}` => Boolean(value)),
      ),
    ];
    if (accounts.length === 0) {
      return;
    }

    try {
      if (!quiet) {
        setRecurringState("working");
        setRecurringMessage("Refreshing recurring tabs.");
      }
      const tabs = await readRecurringTabsForWallet(accounts);
      setWalletTabs(tabs);
      const selectedAddress = activeTabAddress ?? tabs[0]?.address ?? null;
      if (selectedAddress) {
        setActiveTabAddress(selectedAddress);
        setTabAddressInput(selectedAddress);
        const selectedTab = tabs.find((tab) => tab.address.toLowerCase() === selectedAddress.toLowerCase()) ?? (await readRecurringTab(selectedAddress));
        const events = await readRecurringEvents(selectedAddress).catch(() => []);
        setTabState(selectedTab);
        setTabEvents(events);
      }
      if (!quiet) {
        setRecurringState("idle");
        setRecurringMessage(tabs.length > 0 ? "Recurring tabs refreshed." : "No recurring tabs found for this wallet.");
      }
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function selectRecurringTab(address: `0x${string}`) {
    await refreshRecurringTab(address);
  }

  // Ensures the Circle wallet is unlocked before a server-signed recurring
  // action. Returns false (and shows a prompt) when the PIN window has lapsed —
  // same gate as payDebtOnArc.
  async function ensureWalletUnlocked(): Promise<boolean> {
    const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
    if (!pin.unlocked) {
      setRecurringState("error");
      setRecurringMessage("Unlock your wallet (the wallet button in the bottom-right corner), then try again.");
      return false;
    }
    return true;
  }

  // POST to a recurring server route from the user's DCW, then refresh. Shared by
  // the social (DCW) authorize/revoke/claim paths.
  async function runRecurringServerAction(
    path: string,
    body: Record<string, unknown>,
    successMessage: string,
  ): Promise<boolean> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setRecurringState("error");
      setRecurringMessage(
        data.error === "insufficient_funds"
          ? "Your wallet needs more test USDC to cover the gas."
          : data.error === "locked"
            ? "Unlock your wallet, then try again."
            : (data.error ?? "The action failed."),
      );
      return false;
    }
    setRecurringState("success");
    setRecurringMessage(successMessage);
    return true;
  }

  // Whether an action on the selected tab must run through the server-signed
  // Circle wallet: true when the social DCW — not the connected browser wallet —
  // is the acting party (member for approve/revoke, recipient for claim) on that
  // tab. A dual-identity user can be payer via social on one tab and settler via
  // wallet on another, so this is decided per tab, not per session.
  function recurringViaServerForTab(role: "member" | "recipient"): boolean {
    if (!tabState) return recurringViaServer;
    const matches = (address: string | null | undefined) => {
      if (!address) return false;
      const lower = address.toLowerCase();
      return role === "recipient"
        ? tabState.recipient.toLowerCase() === lower
        : tabState.members.some((member) => member.address.toLowerCase() === lower);
    };
    if (matches(recurringWallet?.account)) return false;
    return matches(socialWalletAddress);
  }

  async function authorizeActiveTab() {
    const tabAddress = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput);
    if (!tabAddress) {
      setRecurringState("error");
      setRecurringMessage("Select one of your recurring tabs first.");
      return;
    }

    // Social (DCW) member → approve from the server, capped to their remaining
    // debt. The custom approval field only applies to browser-wallet members.
    if (recurringViaServerForTab("member")) {
      try {
        if (!(await ensureWalletUnlocked())) return;
        setRecurringState("working");
        setRecurringMessage("Approving the tab to collect your recurring debt…");
        const ok = await runRecurringServerAction(
          `/api/recurring/${tabAddress}/authorize`,
          {},
          "Approved. Funds stay in your wallet unless this tab has outstanding debt to collect.",
        );
        if (ok) await refreshRecurringTab(tabAddress, true);
      } catch (caught) {
        setRecurringState("error");
        setRecurringMessage(errorMessage(caught));
      }
      return;
    }

    const wallet = recurringWallet ?? (await connectRecurring());
    if (!wallet) {
      setRecurringState("error");
      setRecurringMessage("Connect a wallet and select one of its recurring tabs first.");
      return;
    }

    try {
      const debtor = tabState?.members.find((member) => member.address.toLowerCase() === wallet.account.toLowerCase());
      const remainingCycles = tabState ? tabState.remainingCycles : 1n;
      const defaultApproval = debtor ? unitsToUsdc(debtor.dueNow > 0n ? debtor.dueNow : debtor.fixedShare * remainingCycles) : "0";
      const approvalValue = authorizationAmount.trim() || defaultApproval;
      const amount = usdcToUnits(approvalValue);
      setRecurringState("working");
      setRecurringMessage("Switching to Arc Testnet…");
      await ensureRecurringWalletOnArc(wallet);
      setRecurringMessage("Approving the tab to collect outstanding recurring debt from your wallet.");
      await authorizeRecurringPayment({ ...wallet, tabAddress, amount });
      setRecurringState("success");
      setRecurringMessage(`Authorized ${approvalValue} USDC. Funds stay in your wallet unless this tab has outstanding debt to collect.`);
      await refreshRecurringTab(tabAddress, true);
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function revokeActiveTab() {
    const tabAddress = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput);
    if (!tabAddress) {
      setRecurringState("error");
      setRecurringMessage("Select one of your recurring tabs first.");
      return;
    }

    if (recurringViaServerForTab("member")) {
      try {
        if (!(await ensureWalletUnlocked())) return;
        setRecurringState("working");
        setRecurringMessage("Revoking recurring collection approval…");
        const ok = await runRecurringServerAction(
          `/api/recurring/${tabAddress}/authorize`,
          { revoke: true },
          "Recurring collection approval revoked.",
        );
        if (ok) await refreshRecurringTab(tabAddress, true);
      } catch (caught) {
        setRecurringState("error");
        setRecurringMessage(errorMessage(caught));
      }
      return;
    }

    const wallet = recurringWallet ?? (await connectRecurring());
    if (!wallet) {
      setRecurringState("error");
      setRecurringMessage("Connect a wallet and select one of its recurring tabs first.");
      return;
    }

    try {
      setRecurringState("working");
      setRecurringMessage("Switching to Arc Testnet…");
      await ensureRecurringWalletOnArc(wallet);
      setRecurringMessage("Revoking recurring collection approval.");
      await approveUsdc({ ...wallet, spender: tabAddress, amount: 0n });
      setRecurringState("success");
      setRecurringMessage("Recurring collection approval revoked.");
      await refreshRecurringTab(tabAddress, true);
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function claimActiveRecurringFunds() {
    const tabAddress = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput);
    if (!tabAddress) {
      setRecurringState("error");
      setRecurringMessage("Select one of your recurring tabs first.");
      return;
    }

    // Social (DCW) recipient → claim from the server.
    if (recurringViaServerForTab("recipient")) {
      try {
        if (!(await ensureWalletUnlocked())) return;
        setRecurringState("working");
        setRecurringMessage("Claiming collected recurring funds…");
        const ok = await runRecurringServerAction(
          `/api/recurring/${tabAddress}/claim`,
          {},
          "Collected recurring funds claimed to your Splitsy wallet.",
        );
        if (ok) {
          await refreshRecurringTab(tabAddress, true);
          await refreshRecurringTabsForWallet(undefined, true);
        }
      } catch (caught) {
        setRecurringState("error");
        setRecurringMessage(errorMessage(caught));
      }
      return;
    }

    const wallet = recurringWallet ?? (await connectRecurring());
    if (!wallet) {
      setRecurringState("error");
      setRecurringMessage("Connect the splitter wallet and select one of its recurring tabs first.");
      return;
    }

    try {
      setRecurringState("working");
      setRecurringMessage("Switching to Arc Testnet…");
      await ensureRecurringWalletOnArc(wallet);
      setRecurringMessage("Claiming collected recurring funds.");
      await claimRecurringFunds({ ...wallet, tabAddress });
      setRecurringState("success");
      setRecurringMessage("Collected recurring funds claimed.");
      await refreshRecurringTab(tabAddress, true);
      await refreshRecurringTabsForWallet(wallet.account, true);
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  function updateRecurringMember(
    id: string,
    field: keyof RecurringMemberInput,
    value: string | (IdentityProvider | "wallet"),
  ) {
    setRecurringMembers((current) =>
      current.map((member) => (member.id === id ? { ...member, [field]: value } : member)),
    );
  }

  function addRecurringMember() {
    setRecurringMembers((current) => [
      ...current,
      { id: `rec-member-${Date.now()}`, address: "", share: "0.00", provider: "wallet" },
    ]);
  }

  function removeRecurringMember(id: string) {
    setRecurringMembers((current) => current.filter((member) => member.id !== id));
  }

  function switchAppTab(tab: AppTab) {
    // A flow's modal belongs to the surface that started it. The Settle deck
    // suppresses the modal in favour of in-section steps, so a flow that ended
    // there is never dismissed — and would otherwise greet you on the next tab
    // as a popup about something you finished with minutes ago.
    closeFlow();

    const transitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => void;
    };

    if (transitionDocument.startViewTransition) {
      transitionDocument.startViewTransition(() => setActiveTab(tab));
      return;
    }

    setActiveTab(tab);
  }

  // Keep the app-specific wallet setup in sync with the RainbowKit / wagmi
  // connection. Connecting via the RainbowKit modal builds the bill/recurring
  // wallets; disconnecting from it tears the app state back down. Switching the
  // active account in the wallet keeps `address` truthy but changes its value,
  // so we also rebuild whenever the connected address no longer matches the
  // account the app wallets were built for. The imperative
  // connectWallets()/connectBillWallet() path remains as a fallback for the
  // inline "connect-then-act" handlers.
  useEffect(() => {
    if (!address) {
      if (billWallet || recurringWallet || bridgeSession) {
        disconnectWallets();
      }
      return;
    }

    if (billState === "connecting") {
      return;
    }

    const builtAccount = billWallet?.account;
    const addressChanged = builtAccount && getAddress(builtAccount) !== getAddress(address);

    if (!builtAccount || addressChanged) {
      if (addressChanged) {
        // Drop the previous account's wallets, debts, tabs, and messages before
        // rebuilding so nothing from the old address leaks into the new session.
        resetAccountState();
      }
      void connectWallets();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // Settle and IOU are both full-bleed posters: they render as siblings of the
  // capped section every other tab lives in, and neither wants the header's
  // title row or the site footer competing with the poster for the first screen.
  const posterTab = activeTab === "settle" || activeTab === "iou";

  // IOU's narrow header — logo + tabs, no title row — is the app default. Bills
  // is the only tab that keeps the tall variant: it's where the pitch and the
  // network stamp still earn their row, since it's the tab you land on to create.
  const billsTab = activeTab === "bills" || activeTab === "recurring";

  // On the Settle tab this rides inside the deck's own scroller (see SettleDeck's
  // `header` prop) so it scrolls away with the first card rather than standing
  // over every section. Everywhere else it is the page's first block as usual.
  const appHeader = (
    <header className="app-masthead z-30">
      <div className="mx-auto max-w-[88rem] px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 shrink">
            <Link aria-label="Splitsy home" className="brand-lockup" href="/">
              <span className="logo-crop logo-crop-app">
                <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
              </span>
            </Link>
            {/* Every row of header is a row the content doesn't get, and the
                section rail already stamps the network. */}
            {billsTab ? (
              <div className="app-strap">
                <h1 className="settle-label app-strapline">Split bills, settle cleanly</h1>
                <span className="settle-label app-network">Arc Testnet</span>
              </div>
            ) : null}
          </div>
          <div className="app-rails">
            <div className="bill-views app-nav">
              <TabButton active={billsTab} onClick={() => switchAppTab("bills")}>
                Bills
              </TabButton>
              <TabButton active={activeTab === "settle"} onClick={() => switchAppTab("settle")}>
                Settle
                {settleCount > 0 ? (
                  <>
                    <span aria-hidden className="app-count">
                      {settleCount}
                    </span>
                    {/* The figure alone reads out as a bare number, which next to
                        "Settle" could as easily be a price. So the numeral is the
                        printed form and this is the spoken one. */}
                    <span className="sr-only"> — {settleCount} waiting on you</span>
                  </>
                ) : null}
              </TabButton>
              <TabButton active={activeTab === "iou"} onClick={() => switchAppTab("iou")}>
                IOU
              </TabButton>
              <TabButton active={activeTab === "dashboard"} onClick={() => switchAppTab("dashboard")}>
                Dashboard
              </TabButton>
              <TabButton active={activeTab === "agents"} onClick={() => switchAppTab("agents")}>
                Agents
              </TabButton>
            </div>
            <div className="app-tools">
              {/* Not a tab: it leaves the app. Same mark as a filter on the
                  dashboard's rail, which is the register for everything here that
                  doesn't change which tab you are reading. */}
              <Link className="iou-provider bill-toggle" href="/docs">
                Docs
              </Link>
              <SignInMenu />
              <WalletMark />
              <button
                aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                className="iou-provider app-icon"
                onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
                type="button"
              >
                {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );

  return (
    <main className="app-shell min-h-screen text-[var(--text)]" data-app-tab={activeTab}>
      {activeTab === "settle" ? null : appHeader}

      {/* Full-bleed by design — the poster can't live inside the padded, capped
          wrapper every other tab uses, so it renders as its sibling. */}
      {activeTab === "settle" ? (
        <SettleDeck
          billState={billState}
          bridgeForDebt={bridgeForDebt}
          header={appHeader}
          claimAmounts={claimAmounts}
          claimSplitterFunds={claimSplitterFunds}
          debtMessages={debtMessages}
          nowSeconds={nowSeconds}
          partialPayments={partialPayments}
          payDebtOnArc={payDebtOnArc}
          paySocialDebt={paySocialDebt}
          progressFlow={progressFlow}
          refundOnArc={refundOnArc}
          setClaimAmounts={setClaimAmounts}
          setPartialPayments={setPartialPayments}
          signedIn={Boolean(me?.walletAddress || registryReadAddress)}
          socialDebts={socialDebts}
          splitterBills={splitterBills}
          walletDebts={activeWalletDebts}
        />
      ) : null}

      {activeTab === "iou" ? <IouClient onReceipts={() => switchAppTab("bills")} /> : null}

      <section className={`mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8${posterTab ? " hidden" : ""}`}>
        <AnimatePresence mode="wait">
        {billsTab ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="space-y-5"
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            key="bills-section"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {/* One-off vs standing recurring split. Not a segmented control: this
                rail sits directly above a page that draws no boxes, and a pill
                here was the last piece of card chrome left on the tab. Two words
                on a baseline, the one you are reading at ink with its rule drawn —
                the same mark every other option on this page makes. */}
            <div className="bill-poster-marks">
              <button
                aria-current={activeTab === "bills" ? "true" : undefined}
                className="iou-provider bill-toggle"
                onClick={() => switchAppTab("bills")}
                type="button"
              >
                One-off
              </button>
              <button
                aria-current={activeTab === "recurring" ? "true" : undefined}
                className="iou-provider bill-toggle"
                onClick={() => switchAppTab("recurring")}
                type="button"
              >
                Recurring
              </button>
            </div>
            <AnimatePresence mode="wait">
            {activeTab === "bills" ? (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="space-y-5"
              exit={{ opacity: 0, y: 8 }}
              initial={{ opacity: 0, y: 8 }}
              key="one-off"
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
            <PosterHero
              eyebrow="Receipt to settlement"
              legend={[
                {
                  step: "01 · Capture",
                  label: "Scan the receipt, or type it",
                  state: showBillEditor ? "done" : "active",
                },
                {
                  step: "02 · Verify",
                  label: "Check what the scan read",
                  state: billReadyForSplit ? "done" : showBillEditor ? "active" : undefined,
                },
                {
                  step: "03 · Split",
                  label: "Shares by handle or wallet",
                  state: submittedBillId ? "done" : billReadyForSplit ? "active" : undefined,
                },
                {
                  step: "04 · Commit",
                  label: "One escrow row on Arc",
                  state: submittedBillId ? "done" : undefined,
                },
              ]}
              lede="Photograph a bill in any language and Splitsy reads the totals, tax and tip. You assign the shares, and one transaction writes the whole split into escrow on Arc — where each payer settles their own share and you claim what comes in."
              title="Split a bill, keep the receipt"
            />

            {/* After a successful submit the split form resets (unmounting the
                review panel), so the commit reports itself here instead — as the
                bills tab's fifth poster rather than as a tinted box with a tick
                in it. It sits directly under the hero, above the inbox/claim
                panels, because creating a bill smooth-scrolls back to the top;
                anywhere lower and the confirmation scrolls out of view the
                moment it appears.

                The number is the headline because the number is the thing the
                creator now has to keep. The prose under it says which wallet
                signed and what happens next; the link, when there is one, is a
                labelled figure on its own rule like every other value in this
                tab. */}
            {billState === "success" && liveBillId && !billReadyForSplit ? (
              <section className="bill-poster bill-live">
                <div className="bill-poster-head">
                  <span className="settle-label" data-tone="ok">
                    Committed
                  </span>
                  <div className="bill-poster-marks">
                    <span className="bill-poster-fact">Arc Testnet</span>
                    {/* The registry it now lives in, as evidence rather than as
                        decoration — same mono link the recurring posters use. */}
                    <a
                      className="iou-row-tx"
                      href={`https://testnet.arcscan.app/address/${BILL_SPLIT_REGISTRY_ADDRESS}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {shortAddress(BILL_SPLIT_REGISTRY_ADDRESS)}
                      <ExternalLink size={11} />
                    </a>
                  </div>
                </div>

                <div className="bill-poster-body">
                  <div className="bill-live-lede">
                    <h3 className="bill-display bill-live-title">
                      Bill <b>#{liveBillId}</b> is live
                    </h3>
                    {/* Not the review panel's ref-driven stamp: that one is a
                        gsap pop keyed to a panel this state has already
                        unmounted. Same mark, drawn by CSS on mount. */}
                    <span className="settlement-stamp bill-live-stamp">On Arc</span>
                  </div>
                  <p className="bill-poster-note">{billMessage}</p>

                  {shareLinkUrl ? (
                    <div className="bill-cell bill-live-link">
                      <span className="settle-label">Anyone with this link can pay</span>
                      <div className="bill-live-link-row">
                        <a className="bill-live-url" href={shareLinkUrl} rel="noreferrer" target="_blank">
                          {shareLinkUrl}
                        </a>
                        <button
                          className="iou-provider bill-live-copy"
                          onClick={() => {
                            void navigator.clipboard.writeText(shareLinkUrl);
                            setLinkCopied(true);
                            window.setTimeout(() => setLinkCopied(false), 1800);
                          }}
                          type="button"
                        >
                          {linkCopied ? (
                            <>
                              <Check size={12} /> copied
                            </>
                          ) : (
                            <>
                              <Link2 size={12} /> copy
                            </>
                          )}
                        </button>
                      </div>
                      <div className="bill-cell-rule" />
                      <p className="bill-options-hint">
                        Save it now — it isn&apos;t shown again anywhere. Whoever holds it can cover any payer&apos;s
                        share without signing in.
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            <div className="space-y-5">
              {/* Step 01 as a poster, in the same grammar as 02 and 03 below it:
                  the plate is the field, the hairline under it is the whole
                  affordance, and the commit is a word rather than a filled bar.
                  See "the capture plate" in globals.css. */}
              <section className="bill-poster">
                <div className="bill-poster-head">
                  <span className="settle-label">01 · Capture</span>
                  <div className="bill-poster-marks">
                    {/* The live state is a fact on the rail, the way 02 reports
                        Scout buying an FX rate — not a pill on a header bar. */}
                    {ocrState === "reading" ? (
                      <span className="bill-poster-fact">Scout is reading the receipt</span>
                    ) : null}
                  </div>
                </div>
                <p className="bill-poster-note">
                  Any language, any currency. Scout reads the totals, tax, tip and line items off the photo, and pays
                  for the parse out of its own wallet — you fix whatever it misread in 02, before anything reaches Arc.
                </p>

                <div className="bill-poster-body">
                  <form className="bill-capture" data-armed={isDraggingBill} onSubmit={parseBill}>
                    {/* The whole plate is the label, so a click anywhere on it
                        opens the picker and a file can be dropped anywhere in it.
                        Nothing draws a box: the plate is an area of the page that
                        arms itself under a drag and rules off at the foot. */}
                    <label
                      className="bill-plate"
                      data-loaded={imagePreview !== ""}
                      data-scanning={ocrState === "reading"}
                      onDragLeave={handleBillDragLeave}
                      onDragOver={handleBillDragOver}
                      onDrop={handleBillDrop}
                    >
                      {imagePreview ? (
                        // eslint-disable-next-line @next/next/no-img-element -- object URL, not a bundled asset
                        <img alt="The bill to be scanned" className="bill-plate-image" src={imagePreview} />
                      ) : (
                        <span className="bill-plate-prompt">
                          <span className="bill-plate-call">Drop the receipt</span>
                          <span className="settle-label">or click to browse · jpg, png or heic</span>
                        </span>
                      )}
                      <input
                        accept="image/*"
                        className="sr-only"
                        name="image"
                        onChange={updatePreview}
                        ref={imageInputRef}
                        type="file"
                      />
                    </label>
                    <div className="bill-cell-rule" />

                    {/* The plate's caption: which photo is loaded, and the way to
                        get one if you haven't got a receipt to hand. A real
                        <button> at last — out here it is outside the upload
                        <label>, so the label can no longer adopt it as its own
                        control and steal every click on the plate. */}
                    <div className="bill-plate-caption">
                      <span className="settle-label">{previewName || "no photo yet"}</span>
                      <button className="iou-provider" onClick={() => void loadSampleBill()} type="button">
                        use the sample bill
                      </button>
                    </div>

                    {error ? (
                      <p className="bill-poster-msg" data-tone="error" role="status">
                        {error}
                      </p>
                    ) : null}

                    <div className="bill-poster-foot">
                      <button className="settle-action" disabled={ocrState === "reading"} type="submit">
                        {ocrState === "reading" ? "reading…" : "scan receipt"} ›
                      </button>
                      {/* The alternative to the whole step, sitting opposite the
                          action it replaces rather than underlined beneath it. */}
                      <button
                        className="iou-provider"
                        onClick={() => {
                          setManualBillEntry(true);
                          setReceiptCommit(null);
                          setError("");
                          clearBillFlowState();
                        }}
                        type="button"
                      >
                        or enter it by hand
                      </button>
                    </div>
                  </form>
                </div>
              </section>

              <AnimatePresence>
                {showBillEditor ? (
                  <motion.div
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 12, scale: 0.985 }}
                    initial={{ opacity: 0, y: 16, scale: 0.985 }}
                    ref={reviewBillRef}
                    transition={{ duration: 0.26, ease: "easeOut" }}
                  >
                    {/* Set as a poster, not a card — see "the bill poster" in
                        globals.css. The merchant is the masthead, the total is
                        the hero figure, and every one of them is the field that
                        edits it. */}
                    <section className="bill-poster">
                      <div className="bill-poster-head">
                        <span className="settle-label">02 · Verify</span>
                        <div className="bill-poster-marks">
                          {/* A USD bill needs no conversion notice — there is
                              nothing to convert and no rate worth showing. */}
                          {billIsScanned && originCurrency !== "USD" ? (
                            <span className="bill-poster-fact">
                              {fxPending ? (
                                `${originCurrency} → USD · Scout is buying the rate`
                              ) : (
                                <>
                                  {originCurrency} → USD ·{" "}
                                  <b>
                                    1 {originCurrency} = {usdRate.toFixed(6)}
                                  </b>
                                  {fxQuote?.asOf ? ` · ${new Date(fxQuote.asOf).toLocaleDateString()}` : ""}
                                </>
                              )}
                            </span>
                          ) : null}
                          {/* A discount is a fact about the total, not a field —
                              the total already carries it. */}
                          {discountShown > 0 ? (
                            <span className="bill-poster-fact">
                              discount <b>−{discountShown.toFixed(2)}</b> off subtotal + tax + tip
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <p className="bill-poster-note">
                        Every figure below is editable — fix anything the scan misread now. From step 03 on, these are
                        the numbers written to Arc and hashed into the bill.
                      </p>

                      <div className="bill-poster-body" ref={receiptPrintRef}>
                        {billIsScanned && scoutReport ? <ScoutReceipt report={scoutReport} /> : null}

                        <div className="bill-poster-lede">
                          <h4 className="bill-display">
                            <input
                              aria-label="Merchant"
                              autoComplete="off"
                              className="iou-field bill-title-field"
                              onChange={(event) => updateBillField("merchant", event.target.value)}
                              placeholder="Merchant"
                              value={bill.merchant}
                            />
                          </h4>
                          {/* While the rate is in flight usdRate is 1, so this
                              is still the origin currency — the label says which
                              rather than asserting a wrong USD figure. */}
                          <div className="bill-cell" data-total>
                            <span className="settle-label">Total {amountUnit}</span>
                            <div className="bill-figure">
                              <span className="bill-currency">$</span>
                              <PosterValue
                                ariaLabel={`Total ${amountUnit}`}
                                decimal
                                onChange={(value) =>
                                  billIsScanned ? updateBillUsdField("total", value) : updateBillField("total", value)
                                }
                                placeholder="0.00"
                                value={billIsScanned ? toUsdInput(bill.total, usdRate) : String(bill.total)}
                              />
                            </div>
                            <div className="bill-cell-rule" />
                          </div>
                        </div>

                        {billIsScanned ? (
                          <div className="bill-poster-rail">
                            <PosterCell
                              decimal
                              label={`Subtotal ${amountUnit}`}
                              onChange={(value) => updateBillUsdField("subtotal", value)}
                              value={toUsdInput(bill.subtotal, usdRate)}
                            />
                            <PosterCell
                              decimal
                              label={`Tax ${amountUnit}`}
                              onChange={(value) => updateBillUsdField("tax", value)}
                              value={toUsdInput(bill.tax, usdRate)}
                            />
                            <PosterCell
                              decimal
                              label={`Tip ${amountUnit}`}
                              onChange={(value) => updateBillUsdField("tip", value)}
                              value={toUsdInput(bill.tip, usdRate)}
                            />
                            <PosterCell
                              label="Origin currency"
                              onChange={(value) => updateBillField("currency", value)}
                              placeholder="USD"
                              value={bill.currency}
                            />
                          </div>
                        ) : null}

                        {billIsScanned && bill.lineItems.length > 0 ? (
                          <details className="bill-items">
                            <summary>
                              <span className="settle-label">
                                {bill.lineItems.length} extracted item{bill.lineItems.length === 1 ? "" : "s"}
                              </span>
                              <span className="bill-items-total">
                                ${bill.lineItems.reduce((sum, item) => sum + item.amount * usdRate, 0).toFixed(2)}
                                <ChevronDown className="bill-items-chevron" size={16} />
                              </span>
                            </summary>
                            {bill.lineItems.map((item, index) => (
                              <div className="bill-item" data-receipt-row key={`${item.description}-${index}`}>
                                <i>{String(index + 1).padStart(2, "0")}</i>
                                <span>{item.description}</span>
                                <b>${(item.amount * usdRate).toFixed(2)}</b>
                              </div>
                            ))}
                          </details>
                        ) : null}
                      </div>
                    </section>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <AnimatePresence>
                {billReadyForSplit ? (
                  <motion.div
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 12, scale: 0.985 }}
                    initial={{ opacity: 0, y: 18, scale: 0.985 }}
                    ref={reviewSplitRef}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                  >
                    <section className="bill-poster">
                      <div className="bill-poster-head">
                        <span className="settle-label">03 · Split &amp; commit</span>
                        <div className="bill-poster-marks">
                          {/* Two answers, so it cycles rather than opening a
                              picker — the same call .iou-provider makes. */}
                          <button
                            className="iou-provider"
                            onClick={() => setSplitMode(splitMode === "equal" ? "manual" : "equal")}
                            type="button"
                          >
                            {splitMode === "equal" ? "split equally" : "split manually"}
                          </button>
                          {Math.abs(splitDelta) > 0.009 ? (
                            <span className="settle-label" data-tone="warn">
                              ${Math.abs(splitDelta).toFixed(2)} off
                            </span>
                          ) : (
                            <span className="settle-label" data-tone="ok">
                              balanced
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="bill-poster-note">
                        Tag each payer by wallet address, X, Discord or email — anyone tagged gets a Splitsy wallet and
                        can pay without one of their own. One transaction writes the split to Arc, and it can&apos;t be
                        edited afterwards.
                      </p>

                      <div className="bill-poster-body">
                        {displayParticipants.map((participant) => {
                        // A value that names its own namespace needs no picker:
                        // a 0x address and an email address both say what they
                        // are. Only a bare handle is ambiguous, and there the
                        // word cycles X → Discord → email.
                        const target = participant.walletAddress.trim();
                        const namespace = looksLikeAddress(target) ? "wallet" : rowProvider(participant);
                        const ambiguous = target !== "" && !looksLikeAddress(target) && !looksLikeEmail(target);
                        const share =
                          splitMode === "manual"
                            ? (participantShareInputs[participant.id] ??
                              (participant.amountUsd > 0 ? String(participant.amountUsd) : ""))
                            : participant.amountUsd.toFixed(2);
                        return (
                          <div className="bill-payer" key={participant.id}>
                            <div className="bill-payer-line">
                              {/* The target is the line, because the target is
                                  what identifies this payer on Arc — the display
                                  name is the creator's own shorthand and rides
                                  the rail below. A pasted address is 42
                                  characters, which at this size is three lines of
                                  poster, so it shows compacted through the same
                                  mechanism the IOU composer uses: the mirror
                                  measures the short form, the input's own glyphs
                                  go transparent, .iou-compact draws the short
                                  text. The value itself is never touched. */}
                              <span className="bill-payer-target">
                                <PayerMark provider={namespace} target={target} />
                                <PosterValue
                                  ariaLabel="Wallet address, handle or email"
                                  compact={looksLikeAddress(target) ? shortAddress(target) : null}
                                  onChange={(value) => updateParticipant(participant.id, "walletAddress", value)}
                                  placeholder="@handle or 0x…"
                                  value={participant.walletAddress}
                                />
                              </span>
                              <span className="bill-payer-share" data-empty={share === "" || Number(share) === 0}>
                                <span className="bill-currency">$</span>
                                <PosterValue
                                  ariaLabel={`${participant.label || "Payer"} share in USD`}
                                  decimal
                                  disabled={splitMode === "equal"}
                                  onChange={(value) => updateParticipantShare(participant.id, value)}
                                  placeholder="0.00"
                                  value={share}
                                />
                              </span>
                            </div>

                            <div className="bill-payer-meta">
                              <span className="bill-payer-name">
                                <PosterValue
                                  ariaLabel="Payer name"
                                  onChange={(value) => updateParticipant(participant.id, "label", value)}
                                  placeholder="name"
                                  value={participant.label}
                                />
                              </span>
                              {target === "" ? null : ambiguous ? (
                                <button
                                  className="iou-provider"
                                  onClick={() =>
                                    updateParticipant(participant.id, "provider", nextProvider(namespace))
                                  }
                                  type="button"
                                >
                                  on {namespace}
                                </button>
                              ) : (
                                <span className="settle-label">on {namespace}</span>
                              )}
                              <span className="bill-payer-rep">
                                <ReputationBadge provider={rowProvider(participant)} value={participant.walletAddress} />
                              </span>
                              <button
                                className="iou-provider bill-payer-remove"
                                onClick={() => removeParticipant(participant.id)}
                                type="button"
                              >
                                remove
                              </button>
                            </div>
                          </div>
                        );
                      })}

                      <div className="bill-add">
                        <button className="iou-provider" onClick={addParticipant} type="button">
                          + add payer
                        </button>
                      </div>

                      <div className="bill-options">
                        {/* Optional pay-by date. Committed into the on-chain
                            metadata hash so payment reputation can grade
                            timeliness against a deadline the creator can't move
                            after the fact. */}
                        <span className="bill-pair">
                          <label className="settle-label" htmlFor="bill-due-date">
                            pay by
                          </label>
                          <input
                            className="bill-date"
                            data-set={dueDateInput !== ""}
                            id="bill-due-date"
                            min={new Date().toISOString().slice(0, 10)}
                            onChange={(event) => {
                              setDueDateInput(event.target.value);
                              // Escrow without a deadline is an unbounded lock,
                              // so the contract refuses it — drop the toggle
                              // with the date rather than submit a pair that
                              // reverts.
                              if (!event.target.value) setEscrowUntilFull(false);
                            }}
                            type="date"
                            value={dueDateInput}
                          />
                        </span>

                        <button
                          aria-pressed={escrowUntilFull}
                          className="iou-provider bill-toggle"
                          disabled={!dueDateInput}
                          onClick={() => setEscrowUntilFull(!escrowUntilFull)}
                          type="button"
                        >
                          all or nothing
                        </button>

                        <button
                          aria-pressed={publicPayLink}
                          className="iou-provider bill-toggle"
                          onClick={() => setPublicPayLink(!publicPayLink)}
                          type="button"
                        >
                          anyone can pay
                        </button>

                        {/* Dual identity (signed in social + connected wallet):
                            the creator picks which wallet writes the bill to Arc
                            and collects the payments. With one identity there is
                            no ambiguity and no picker. */}
                        {canChooseCreator && socialWalletAddress && connectedWalletAccount ? (
                          <button
                            className="iou-provider"
                            onClick={() => chooseCreatorIdentity(creatorIdentity === "social" ? "wallet" : "social")}
                            type="button"
                          >
                            as{" "}
                            {creatorIdentity === "social" ? socialCreatorLabel : shortAddress(connectedWalletAccount)}
                          </button>
                        ) : null}
                      </div>

                      {/* One line each, and only when there is something to say:
                          why a control is unavailable, or what an armed one
                          actually does. Off and available, it explains nothing —
                          which is most of the time. */}
                      {dueDateInput ? null : (
                        <p className="bill-options-hint">
                          A pay-by date unlocks all-or-nothing escrow, and payers who settle before it build stronger
                          on-chain reputation.
                        </p>
                      )}
                      {escrowUntilFull ? (
                        <p className="bill-options-hint">
                          All or nothing — nobody&apos;s money is released until every payer has settled. Still short on
                          the due date and the bill has failed: you collect nothing and each payer takes their own money
                          back.
                        </p>
                      ) : null}
                      {publicPayLink ? (
                        <p className="bill-options-hint">
                          Anyone can pay — you get a link that opens this bill on its own page, where whoever holds it
                          can cover any payer&apos;s share. Minted when the bill is written, and not removable after.
                        </p>
                      ) : null}

                      {billMessage ? (
                        <p
                          className="bill-poster-msg"
                          data-tone={billState === "error" ? "error" : billState === "success" ? "success" : undefined}
                          role="status"
                        >
                          {billMessage}
                        </p>
                      ) : null}

                      <div className="bill-poster-foot">
                        <button
                          className="settle-action"
                          disabled={billState === "working" || billState === "connecting"}
                          onClick={submitBillOnchainMixed}
                          type="button"
                        >
                          {billState === "working" ? "writing…" : "write on arc"} ›
                        </button>
                        <div className="bill-poster-total" data-tone={Math.abs(splitDelta) > 0.009 ? "warn" : undefined}>
                          <span className="settle-label">Split total</span>
                          <span>
                            ${splitTotal.toFixed(2)} <em>of ${confirmedUsd.toFixed(2)}</em>
                          </span>
                        </div>
                      </div>

                      {submittedBillId ? (
                        <div className="bill-poster-foot">
                          <span className="bill-poster-fact">
                            Bill <b>#{submittedBillId.toString()}</b> is live. Payers see it when they connect the
                            matching wallet.
                          </span>
                          <div className="settlement-stamp" ref={settlementStampRef}>
                            Settled
                          </div>
                        </div>
                      ) : null}
                      </div>
                    </section>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
            </motion.div>
            ) : (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="space-y-5"
              exit={{ opacity: 0, y: 8 }}
              initial={{ opacity: 0, y: 8 }}
              key="recurring"
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
            <PosterHero
            eyebrow="Standing splits"
            legend={[
              { step: "01 · Set up", label: "Members, share, cycles", state: walletTabs.length > 0 ? "done" : "active" },
              { step: "02 · Your tabs", label: "Everything you're on", state: tabState ? "done" : walletTabs.length > 0 ? "active" : undefined },
              { step: "03 · Where it stands", label: "Approved, funded, due", state: tabState ? "active" : undefined },
              { step: "04 · Act on it", label: "Approve, collect, withdraw" },
              { step: "05 · On chain", label: "Every cycle, on Arc" },
            ]}
            lede="Rent, a shared subscription, a standing round — anything that recurs. A tab is a contract on Arc that knows who owes what and how often. Members approve their own share once; each cycle collects only what has fallen due, and never a cent more."
            title="Bills that come back"
          />
          <RecurringWorkspace
            addRecurringMember={addRecurringMember}
            authorizationAmount={authorizationAmount}
            authorizeActiveTab={authorizeActiveTab}
            availableRecurringCycleOptions={availableRecurringCycleOptions}
            bridgeForRecurring={bridgeForRecurring}
            claimActiveRecurringFunds={claimActiveRecurringFunds}
            createOnchainTab={createOnchainTab}
            customCycleDays={customCycleDays}
            displayRecurringMembers={displayRecurringMembers}
            recurringCreateMessage={recurringCreateMessage}
            recurringCreateMessageTone={recurringCreateMessageTone}
            recurringCycleCount={recurringCycleCount}
            recurringCycle={recurringCycle}
            recurringMessage={recurringMessage}
            recurringShareUsd={recurringShareUsd}
            recurringSplitMode={recurringSplitMode}
            recurringState={recurringState}
            recurringTotalUsd={recurringTotalUsd}
            recurringWallet={recurringWallet}
            actingAccount={recurringActingAccount}
            createAsSocial={createAsSocial}
            canChooseCreator={canChooseCreator}
            socialCreatorLabel={socialCreatorLabel}
            creatorIdentity={creatorIdentity}
            chooseCreatorIdentity={chooseCreatorIdentity}
            connectedWalletAccount={connectedWalletAccount}
            socialWalletAddress={socialWalletAddress}
            removeRecurringMember={removeRecurringMember}
            revokeActiveTab={revokeActiveTab}
            refreshRecurringTabsForWallet={() => refreshRecurringTabsForWallet()}
            selectRecurringTab={selectRecurringTab}
            setCustomCycleDays={setCustomCycleDays}
            setAuthorizationAmount={setAuthorizationAmount}
            setRecurringCycleCount={setRecurringCycleCount}
            setRecurringCycle={setRecurringCycle}
            setRecurringSplitMode={setRecurringSplitMode}
            setRecurringTotalUsd={setRecurringTotalUsd}
            tabEvents={tabEvents}
            tabState={tabState}
            updateRecurringMember={updateRecurringMember}
            walletTabs={walletTabs}
          />
            </motion.div>
            )}
            </AnimatePresence>
          </motion.div>
        ) : activeTab === "agents" ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="space-y-5"
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            key="agents"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {/* The masthead states what the tab is and which side of a bill each
                agent works; live state stays down on the section that controls
                it, where acting on it is one click away. The contents rail is
                the exception — it is the poster system's progress readout, so it
                reports what the sections below have reported up.

                Both the rail and the sections read AGENT_STEPS, so an entry here
                and the heading it scrolls to cannot name a section differently —
                which they did: this rail used to call 04 "Scout" while the section
                itself called it "Third-party agent". */}
            <PosterHero
              eyebrow="Autonomous settlement"
              legend={legendOf(AGENT_STEPS, [
                agentState.armed ? "active" : undefined,
                agentState.granted > 0 ? "done" : undefined,
                agentState.decisions > 0 ? "done" : undefined,
              ])}
              lede="Two agents work opposite sides of a bill: one pays your share the moment you are billed, one collects what you are owed once a bill falls due. Both run on standing permissions you write here — capped, per bill, revocable, and logged decision by decision."
              title="Agents that settle while you sleep"
            />
            <SettlementAgentsPanel onState={setAgentState} />
            <AgentEconomyPanel />
          </motion.div>
        ) : activeTab === "iou" ? null : (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="space-y-5"
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            key="dashboard"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <DashboardPanel
              socialWallet={socialWalletAddress}
              browserWallet={connectedWalletAccount}
              socialProvider={me?.provider ?? null}
              socialHandle={me?.handle ?? null}
              onSettleNet={connectedWalletAccount ? settleNetWithWallet : undefined}
            />

            {/* The paper trail, under the four readings: both stacks stay
                mounted regardless of what they hold — XHistoryPanel reports its
                count up, and that count decides whether the shared empty state
                below is the truth. Set as posters like the readings above, so the
                tab ends in the same voice it opened in. */}
            <div className={socialHistoryCount > 0 ? undefined : "hidden"}>
              <section className="bill-poster">
                <SectionHead
                  marks={
                    <span className="bill-poster-fact">
                      <b>{socialHistoryCount}</b> record{socialHistoryCount === 1 ? "" : "s"}
                    </span>
                  }
                  note="Bills tagged to your X, Discord or email rather than to an address — settled from the Splitsy wallet that handle owns. Open a record to see the transaction behind it."
                  step={RECORD_STEPS.handle}
                />
                <div className="bill-poster-body">
                  <XHistoryPanel onCount={setSocialHistoryCount} />
                </div>
              </section>
            </div>

            {walletHistoryEmpty ? null : (
              <section className="bill-poster">
                <SectionHead
                  note="Rows written to the bill registry on Arc — what you paid, what is still owed to you, and what you have collected. Every figure here was read back off the chain, and every record opens onto the proof."
                  step={RECORD_STEPS.wallet}
                />
                <div className="bill-poster-body">
                  <HistoryWorkspace debts={debts} splitterBills={splitterBills} />
                </div>
              </section>
            )}

            {socialHistoryCount === 0 && walletHistoryEmpty ? (
              <section className="bill-poster">
                <SectionHead
                  note="Nothing has settled yet. Bills you split, settle, or claim — on chain or tagged by handle — land here as records you can reopen and verify against Arc."
                  step={RECORD_STEPS.empty}
                />
              </section>
            ) : null}
          </motion.div>
        )}
        </AnimatePresence>
      </section>

      {/* A deck flow renders its steps inside the section that owns it, so the
          modal would cover the very thing it duplicates. Flows with no owning
          section (the multi-position settle) still use the modal on every tab. */}
      {progressFlow && !(activeTab === "settle" && progressFlow.subjectKey) ? (
        <ProgressModal flow={progressFlow} onClose={closeFlow} />
      ) : null}
      <XAuthControl />
    </main>
  );
}

function HistoryWorkspace({
  debts,
  splitterBills,
}: {
  debts: OwnedBillSplitDebt[];
  splitterBills: OwnedBillSplitDebt[];
}) {
  const paidDebts = debts.filter((debt) => debt.remaining <= 0n);
  // Creditor POV: bills this wallet split that debtors haven't fully paid yet.
  const pendingBills = splitterBills.filter((debt) => debt.totalPaid < debt.totalOwed);
  const claimedBills = splitterBills.filter((debt) => debt.claimable <= 0n && debt.claimed > 0n);

  // Headerless wallet history sections; the shared subheads + empty state live
  // at the foot of the dashboard tab so social and wallet records sit under one
  // document. Each group opens on its own subhead and the records carry their own
  // rules, so nothing here needs a wrapper with spacing.
  return (
    <>
            {pendingBills.length > 0 ? (
              <>
                <div className="bill-subhead">
                  <span className="settle-label">
                    Pending · awaiting payment from debtors · {pendingBills.length}
                  </span>
                </div>
                <div>
                  {pendingBills.map((debt) => {
                    const remaining = debt.totalOwed - debt.totalPaid;

                    return (
                      <HistoryRecordCard
                        debt={debt}
                        key={`${debt.billId.toString()}:${debt.account}`}
                        badge={
                          <span className="settle-label" data-tone="warn">
                            pending
                          </span>
                        }
                        summary={
                          <>
                            <span>
                              paid <span className="amount-text">${billUnitsToUsdc(debt.totalPaid)}</span> of{" "}
                              <span className="amount-text">${billUnitsToUsdc(debt.totalOwed)}</span>
                            </span>
                            <span>
                              <span className="amount-text">${billUnitsToUsdc(remaining)}</span> outstanding
                            </span>
                          </>
                        }
                      />
                    );
                  })}
                </div>
              </>
            ) : null}

            {paidDebts.length > 0 ? (
              <>
                <div className="bill-subhead">
                  <span className="settle-label">Paid · your settled records · {paidDebts.length}</span>
                </div>
                <div>
                  {paidDebts.map((debt) => (
                    <HistoryRecordCard
                      debt={debt}
                      key={`${debt.billId.toString()}:${debt.account}`}
                      badge={<PaidBillStamp compact />}
                      summary={
                        <span>
                          paid <span className="amount-text">${billUnitsToUsdc(debt.paid)}</span> of{" "}
                          <span className="amount-text">${billUnitsToUsdc(debt.owed)}</span>
                        </span>
                      }
                    />
                  ))}
                </div>
              </>
            ) : null}

            {claimedBills.length > 0 ? (
              <>
                <div className="bill-subhead">
                  <span className="settle-label">Claimed · your collected records · {claimedBills.length}</span>
                </div>
                <div>
                  {claimedBills.map((debt) => (
                    <HistoryRecordCard
                      debt={debt}
                      key={`${debt.billId.toString()}:${debt.account}`}
                      badge={<PaidBillStamp compact alt="Claimed" src="/claimed.png" width={652} height={512} />}
                      summary={
                        <span>
                          claimed <span className="amount-text">${billUnitsToUsdc(debt.claimed)}</span> of{" "}
                          <span className="amount-text">${billUnitsToUsdc(debt.totalPaid)}</span> paid
                        </span>
                      }
                    />
                  ))}
                </div>
              </>
            ) : null}
    </>
  );
}

function formatTimestamp(ts: bigint | null) {
  return ts === null ? "—" : new Date(Number(ts) * 1000).toLocaleString();
}

function HistoryRecordCard({
  debt,
  summary,
  badge,
}: {
  debt: BillSplitDebt;
  summary: ReactNode;
  badge: ReactNode;
}) {
  return (
    <HistoryCard
      title={`Bill #${debt.billId.toString()}`}
      summary={summary}
      badge={badge}
      detail={<BillActivityDetail debt={debt} />}
    />
  );
}

// On-chain activity for a wallet history record. Rendered as HistoryCard's
// `detail`, so it only mounts when the card is expanded — the fetch runs on
// mount, replacing the old open-toggle-triggered load.
function BillActivityDetail({ debt }: { debt: BillSplitDebt }) {
  const [activity, setActivity] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    data?: BillActivity;
  }>({ status: "loading" });

  useEffect(() => {
    let active = true;
    readBillActivity(debt.billId)
      .then((data) => {
        if (active) setActivity({ status: "ready", data });
      })
      .catch(() => {
        if (active) setActivity({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [debt.billId]);

  // Distinct debtor wallets: prefer the actual payers from chain activity, and
  // fall back to the bill's registered participant list before any payment.
  const data = activity.data;
  const debtorWallets = (() => {
    const payers = data ? data.payments.map((payment) => payment.payer) : [];
    const source = payers.length > 0 ? payers : [...debt.participantList];
    return [...new Set(source.map((address) => getAddress(address)))];
  })();

  return (
    <>
          <BillVerification billId={debt.billId} metadataHash={debt.metadataHash} />
          {activity.status === "loading" ? (
            <p className="bill-poster-msg" role="status">
              Reading this bill&apos;s activity from Arc…
            </p>
          ) : activity.status === "error" ? (
            <p className="bill-poster-msg" data-tone="error" role="status">
              Couldn&apos;t read the on-chain activity — try again shortly.
            </p>
          ) : data ? (
            <div className="space-y-4 text-sm">
              <div className="history-detail-grid">
                <div>
                  <p className="history-detail-label">Created</p>
                  {data.createdAt !== null ? (
                    <p className="mt-1">{formatTimestamp(data.createdAt)}</p>
                  ) : null}
                  {data.createdTxHash ? (
                    <a
                      className="history-tx-link mt-1 inline-block"
                      href={`https://testnet.arcscan.app/tx/${data.createdTxHash}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {shortAddress(data.createdTxHash)}
                    </a>
                  ) : data.createdAt === null ? (
                    <p className="mt-1 text-[var(--pay-poster-dim)]">—</p>
                  ) : null}
                </div>
                <div>
                  <p className="history-detail-label">Splitter</p>
                  <a
                    className="history-tx-link mt-1 inline-block"
                    href={`https://testnet.arcscan.app/address/${getAddress(debt.splitter)}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {shortAddress(getAddress(debt.splitter))}
                  </a>
                </div>
              </div>

              <div>
                <p className="history-detail-label">Debtor wallet{debtorWallets.length === 1 ? "" : "s"}</p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {debtorWallets.length > 0 ? (
                    debtorWallets.map((address) => (
                      <a
                        className="history-tx-link"
                        href={`https://testnet.arcscan.app/address/${address}`}
                        key={address}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {shortAddress(address)}
                      </a>
                    ))
                  ) : (
                    <span className="text-[var(--pay-poster-dim)]">—</span>
                  )}
                </div>
              </div>

              <div>
                <p className="history-detail-label">Payments</p>
                {data.payments.length > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {data.payments.map((payment) => (
                      <li className="history-event-row" key={payment.txHash}>
                        <span>
                          <span className="font-mono text-xs">{shortAddress(payment.payer)}</span> paid{" "}
                          <span className="amount-text">${billUnitsToUsdc(payment.amount)}</span>
                          <span className="text-[var(--pay-poster-dim)]"> · {formatTimestamp(payment.timestamp)}</span>
                        </span>
                        <a className="history-tx-link" href={`https://testnet.arcscan.app/tx/${payment.txHash}`} rel="noreferrer" target="_blank">
                          tx
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[var(--pay-poster-dim)]">No payments recorded in the recent block window.</p>
                )}
              </div>

              {data.claims.length > 0 ? (
                <div>
                  <p className="history-detail-label">Claims</p>
                  <ul className="mt-1 space-y-1">
                    {data.claims.map((claim) => (
                      <li className="history-event-row" key={claim.txHash}>
                        <span>
                          <span className="amount-text">${billUnitsToUsdc(claim.amount)}</span> claimed
                          <span className="text-[var(--pay-poster-dim)]"> · {formatTimestamp(claim.timestamp)}</span>
                        </span>
                        <a className="history-tx-link" href={`https://testnet.arcscan.app/tx/${claim.txHash}`} rel="noreferrer" target="_blank">
                          tx
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="bill-poster-msg" role="status">
              No on-chain activity in the recent block window.
            </p>
          )}
    </>
  );
}

function RecurringWorkspace({
  addRecurringMember,
  authorizationAmount,
  authorizeActiveTab,
  availableRecurringCycleOptions,
  bridgeForRecurring,
  claimActiveRecurringFunds,
  createOnchainTab,
  customCycleDays,
  displayRecurringMembers,
  recurringCreateMessage,
  recurringCreateMessageTone,
  recurringCycleCount,
  recurringCycle,
  recurringMessage,
  recurringShareUsd,
  recurringSplitMode,
  recurringState,
  recurringTotalUsd,
  recurringWallet,
  actingAccount,
  createAsSocial,
  canChooseCreator,
  socialCreatorLabel,
  creatorIdentity,
  chooseCreatorIdentity,
  connectedWalletAccount,
  socialWalletAddress,
  removeRecurringMember,
  revokeActiveTab,
  refreshRecurringTabsForWallet,
  selectRecurringTab,
  setCustomCycleDays,
  setAuthorizationAmount,
  setRecurringCycleCount,
  setRecurringCycle,
  setRecurringSplitMode,
  setRecurringTotalUsd,
  tabEvents,
  tabState,
  updateRecurringMember,
  walletTabs,
}: {
  addRecurringMember: () => void;
  authorizationAmount: string;
  authorizeActiveTab: () => void;
  availableRecurringCycleOptions: Array<{ id: RecurringCycle; label: string; seconds: bigint }>;
  bridgeForRecurring: (amountLabel: string, sourceChain: BridgeSourceChain) => void;
  claimActiveRecurringFunds: () => void;
  createOnchainTab: () => void;
  customCycleDays: string;
  displayRecurringMembers: RecurringMemberInput[];
  recurringCreateMessage: string;
  recurringCreateMessageTone: "error" | "neutral" | "success";
  recurringCycleCount: string;
  recurringCycle: RecurringCycle;
  recurringMessage: string;
  recurringShareUsd: number;
  recurringSplitMode: "equal" | "manual";
  recurringState: RecurringRunState;
  recurringTotalUsd: string;
  recurringWallet: RecurringWallet | null;
  actingAccount: `0x${string}` | null;
  createAsSocial: boolean;
  canChooseCreator: boolean;
  socialCreatorLabel: string;
  creatorIdentity: CreatorIdentity;
  chooseCreatorIdentity: (next: CreatorIdentity) => void;
  connectedWalletAccount: `0x${string}` | null;
  socialWalletAddress: `0x${string}` | null;
  removeRecurringMember: (id: string) => void;
  revokeActiveTab: () => void;
  refreshRecurringTabsForWallet: () => void;
  selectRecurringTab: (address: `0x${string}`) => void;
  setCustomCycleDays: (value: string) => void;
  setAuthorizationAmount: (value: string) => void;
  setRecurringCycleCount: (value: string) => void;
  setRecurringCycle: (value: RecurringCycle) => void;
  setRecurringSplitMode: (value: "equal" | "manual") => void;
  setRecurringTotalUsd: (value: string) => void;
  tabEvents: RecurringEvent[];
  tabState: RecurringTabState | null;
  updateRecurringMember: (
    id: string,
    field: keyof RecurringMemberInput,
    value: string | (IdentityProvider | "wallet"),
  ) => void;
  walletTabs: RecurringTabState[];
}) {
  // The wallet this workspace reads/acts for — browser wallet or social DCW.
  const actingLower = actingAccount?.toLowerCase() ?? null;
  // Every address that is "you" — a dual-identity user is recognized whether a
  // tab references their browser wallet or their Splitsy (DCW) wallet.
  const viewerAddresses = new Set(
    [actingLower, socialWalletAddress?.toLowerCase()].filter((value): value is string => Boolean(value)),
  );
  const isViewer = (address: string) => viewerAddresses.has(address.toLowerCase());
  // A dual-identity user can be the recipient via one identity AND a payer via
  // the other on the SAME tab. That tab is shown as two list rows; viewRole
  // picks which side this detail view represents (defaults to recipient).
  const [viewRole, setViewRole] = useState<"recipient" | "payer" | null>(null);
  // Collapse a long recurring-tabs list (>3) behind a summary; a tap pins it
  // (persisted across reloads). The toggle also renders whenever the list is
  // collapsed, so a pin carried over from a longer list can be undone.
  const [tabsExpanded, setTabsExpanded] = usePersistedExpand("splitsy-expand-tabs");
  // Rows shown = one per tab, or two for a tab where the viewer is both
  // recipient and payer — matches the flatMap that renders the list.
  const tabRowCount = walletTabs.reduce((sum, tab) => {
    const isRecip = isViewer(tab.recipient);
    const isPayer = tab.members.some((member) => isViewer(member.address));
    return sum + (isRecip && isPayer ? 2 : 1);
  }, 0);
  const tabsShown = tabsExpanded ?? tabRowCount <= 3;
  const viewerIsRecipient = Boolean(tabState && isViewer(tabState.recipient));
  const viewerIsMember = Boolean(tabState && tabState.members.some((member) => isViewer(member.address)));
  const isDualRole = viewerIsRecipient && viewerIsMember;
  const viewingRole: "recipient" | "payer" = isDualRole
    ? (viewRole ?? "recipient")
    : viewerIsRecipient
      ? "recipient"
      : "payer";
  const isRecipient = viewingRole === "recipient";
  const visibleMembers =
    viewerAddresses.size === 0 || !tabState || isRecipient
      ? tabState?.members ?? []
      : tabState.members.filter((member) => isViewer(member.address));
  const viewerMember = tabState?.members.find((member) => isViewer(member.address));
  // Approve/revoke on this tab signs with the browser wallet only when that
  // wallet is the member; a social (DCW) membership is approved server-side.
  const walletIsTabMember = Boolean(
    recurringWallet &&
      tabState?.members.some((member) => member.address.toLowerCase() === recurringWallet.account.toLowerCase()),
  );
  const debtorShare = viewerMember?.fixedShare;
  const approvalPlaceholder = debtorShare
    ? unitsToUsdc(viewerMember?.dueNow ?? debtorShare * (tabState ? tabState.remainingCycles : 1n))
    : authorizationAmount;
  const dueAmount = tabState?.members.reduce((sum, member) => sum + member.dueNow, 0n) ?? 0n;
  const activeTabComplete = Boolean(tabState && tabState.settlementCount >= tabState.maxSettlements);
  const recurringTabPaidForWallet = (tab: RecurringTabState) => {
    const debtor = tab.members.find((member) => isViewer(member.address));
    if (debtor) {
      return debtor.totalSettled >= debtor.fixedShare * tab.maxSettlements;
    }

    return tab.members.every((member) => member.totalSettled >= member.fixedShare * tab.maxSettlements);
  };

  const [selectedBridgeChain, setSelectedBridgeChain] = useState<BridgeSourceChain | null>(null);
  const [showBridge, setShowBridge] = useState(false);

  // A payer only sees on-chain activity about themselves; the recipient sees
  // everything. Either way, one settlement tx emits several events — collapse
  // to one row per tx so the same hash never shows twice.
  const visibleEvents = (() => {
    const scoped =
      isRecipient || viewerAddresses.size === 0
        ? tabEvents
        : tabEvents.filter((event) => event.member && isViewer(event.member));
    const byTx = new Map<string, RecurringEvent>();
    for (const event of scoped) {
      if (!byTx.has(event.txHash)) byTx.set(event.txHash, event);
    }
    return [...byTx.values()];
  })();

  // Each member's Share is their overall share, so the whole schedule collects
  // share x members. Surface the per-cycle charge (Total ÷ cycles) so the Total
  // USD field reads as the full amount across every cycle.
  const parsedCycleCount = Math.floor(Number(recurringCycleCount));
  const cyclesValid = Number.isFinite(parsedCycleCount) && parsedCycleCount >= 1;
  const createCycleCount = cyclesValid ? parsedCycleCount : 1;
  const customDaysNum = Number(customCycleDays);
  const customDaysValid = recurringCycle !== "custom" || (Number.isInteger(customDaysNum) && customDaysNum >= 1);
  const scheduleValid = cyclesValid && customDaysValid;
  const perCycleTotalUsd = (recurringShareUsd * displayRecurringMembers.length) / createCycleCount;
  const perMemberPerCycleUsd = recurringShareUsd / createCycleCount;

  // Manual mode lets the shares drift off the Total, and buildRecurringPlan
  // refuses a tab where they have. So 01 carries the same arithmetic the one-off
  // split does — the sum against the total, and how far off it is — rather than
  // finding out on submit.
  const totalUsd = Number(recurringTotalUsd) || 0;
  const shareTotalUsd = displayRecurringMembers.reduce((sum, member) => sum + Number(member.share || "0"), 0);
  const shareDelta = shareTotalUsd - totalUsd;
  const balanced = Math.abs(shareDelta) <= 0.009;
  const creatorPicker = Boolean(canChooseCreator && socialWalletAddress && connectedWalletAccount);

  // What the whole schedule is worth against what it has actually pulled in. The
  // figure that answers "is there anything left on this tab", which is what
  // justifies the Claim beside it.
  const tabCollected = tabState?.members.reduce((sum, member) => sum + member.totalSettled, 0n) ?? 0n;
  const tabCommitted = tabState
    ? tabState.members.reduce((sum, member) => sum + member.fixedShare, 0n) * tabState.maxSettlements
    : 0n;

  return (
    <>
      {/* ── 01 ────────────────────────────────────────────────────────────────
          The create form, set as a poster in the same grammar as the one-off's
          02 and 03: the interval is this section's masthead (a recurring tab IS
          its interval, the way a bill is its merchant), the total is the hero
          figure beside it, the supporting figures sit on the rail underneath,
          and each member is one line of poster type with their share typed into
          it. See "the bill poster" in globals.css. */}
      <section className="bill-poster">
        <div className="bill-poster-head">
          <span className="settle-label">01 · Set up</span>
          <div className="bill-poster-marks">
            {/* Two answers, so it cycles rather than opening a picker — the same
                call the one-off's split mode makes. */}
            <button
              className="iou-provider"
              onClick={() => setRecurringSplitMode(recurringSplitMode === "equal" ? "manual" : "equal")}
              type="button"
            >
              {recurringSplitMode === "equal" ? "split equally" : "split manually"}
            </button>
            {!scheduleValid ? (
              <span className="settle-label" data-tone="warn">
                fix the schedule
              </span>
            ) : balanced ? (
              <span className="settle-label" data-tone="ok">
                balanced
              </span>
            ) : (
              <span className="settle-label" data-tone="warn">
                ${Math.abs(shareDelta).toFixed(2)} off
              </span>
            )}
          </div>
        </div>
        <p className="bill-poster-note">
          A tab is its own contract on Arc, holding the members, the share and the number of cycles. Nobody is charged
          until a cycle falls due and every member has approved their own share — and no cycle can collect more than
          the share written here.
        </p>

        <div className="bill-poster-body">
          <div className="bill-poster-lede">
            {/* The interval, in the slot the one-off gives the merchant: it is
                what this tab is, and the only value on either subtab that is a
                closed set of four. Picking "days" puts the count in front of it,
                so all four states read as one sentence — every week, every
                month, every 14 days. */}
            <div className="bill-cell">
              <span className="settle-label">Every</span>
              <div className="bill-figure">
                {recurringCycle === "custom" ? (
                  <PosterValue
                    ariaLabel="Cycle length in days"
                    decimal
                    onChange={setCustomCycleDays}
                    placeholder="30"
                    value={customCycleDays}
                  />
                ) : null}
                <select
                  aria-label="How often the tab collects"
                  className="bill-select"
                  onChange={(event) => setRecurringCycle(event.target.value as RecurringCycle)}
                  value={recurringCycle}
                >
                  {availableRecurringCycleOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="bill-cell-rule" />
            </div>

            <div className="bill-cell" data-total>
              <span className="settle-label">Total USD</span>
              <div className="bill-figure">
                <span className="bill-currency">$</span>
                <PosterValue
                  ariaLabel="Recurring total in USD, across every cycle"
                  decimal
                  onChange={setRecurringTotalUsd}
                  placeholder="0.00"
                  value={recurringTotalUsd}
                />
              </div>
              <div className="bill-cell-rule" />
            </div>
          </div>

          {/* Cycles is the one editable figure on the rail; the other two are
              read-outs of it, which is the point — the Total is the whole
              schedule, so what a cycle actually charges has to be visible next
              to it rather than worked out. */}
          <div className="bill-poster-rail">
            <PosterCell
              decimal
              label="Cycles"
              onChange={setRecurringCycleCount}
              placeholder="3"
              value={recurringCycleCount}
            />
            <PosterFact label="Per cycle" value={`$${perCycleTotalUsd.toFixed(2)}`} />
            {displayRecurringMembers.length > 1 ? (
              <PosterFact label="Each member, per cycle" value={`$${perMemberPerCycleUsd.toFixed(2)}`} />
            ) : null}
          </div>

          {/* One member, one line — the same row the one-off's payers get, minus
              the display name the recurring form has never held. The target is
              what the line is set in because the target is what identifies this
              member on Arc; everything that merely qualifies it rides the
              footnote rail underneath. */}
          <div className="bill-payers">
            {displayRecurringMembers.map((member) => {
              const target = member.address.trim();
              const namespace = looksLikeAddress(target) ? "wallet" : detectRowProvider(target, member.provider);
              const ambiguous = target !== "" && !looksLikeAddress(target) && !looksLikeEmail(target);
              return (
                <div className="bill-payer" key={member.id}>
                  <div className="bill-payer-line">
                    <span className="bill-payer-target">
                      <PayerMark provider={namespace} target={target} />
                      <PosterValue
                        ariaLabel="Wallet address, handle or email"
                        compact={looksLikeAddress(target) ? shortAddress(target) : null}
                        onChange={(value) => updateRecurringMember(member.id, "address", value)}
                        placeholder="@handle or 0x…"
                        value={member.address}
                      />
                    </span>
                    <span className="bill-payer-share" data-empty={member.share === "" || Number(member.share) === 0}>
                      <span className="bill-currency">$</span>
                      <PosterValue
                        ariaLabel="Member share in USD, across every cycle"
                        decimal
                        disabled={recurringSplitMode === "equal"}
                        onChange={(value) => updateRecurringMember(member.id, "share", value)}
                        placeholder="0.00"
                        value={member.share}
                      />
                    </span>
                  </div>

                  <div className="bill-payer-meta">
                    {target === "" ? null : ambiguous ? (
                      <button
                        className="iou-provider"
                        onClick={() => updateRecurringMember(member.id, "provider", nextProvider(namespace))}
                        type="button"
                      >
                        on {namespace}
                      </button>
                    ) : (
                      <span className="settle-label">on {namespace}</span>
                    )}
                    <span className="bill-payer-rep">
                      <ReputationBadge provider={detectRowProvider(target, member.provider)} value={member.address} />
                    </span>
                    <button
                      className="iou-provider bill-payer-remove"
                      onClick={() => removeRecurringMember(member.id)}
                      type="button"
                    >
                      remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="bill-add">
            <button className="iou-provider" onClick={addRecurringMember} type="button">
              + add member
            </button>
          </div>

          {/* Dual identity: which of the creator's two wallets signs the tab and
              receives every settlement. One identity means no ambiguity and no
              control — just the line below saying which wallet collects. */}
          {creatorPicker ? (
            <div className="bill-options">
              <button
                className="iou-provider"
                onClick={() => chooseCreatorIdentity(creatorIdentity === "social" ? "wallet" : "social")}
                type="button"
              >
                as {creatorIdentity === "social" ? socialCreatorLabel : shortAddress(connectedWalletAccount as string)}
              </button>
            </div>
          ) : null}

          <p className="bill-options-hint">
            {creatorPicker
              ? creatorIdentity === "social"
                ? `Your Splitsy wallet ${shortAddress(socialWalletAddress as string)} creates the tab and receives every settlement — nothing to sign.`
                : `Your connected wallet ${shortAddress(connectedWalletAccount as string)} signs the tab and receives every settlement.`
              : createAsSocial
                ? "Your Splitsy wallet creates the tab and receives every settlement. Members can be wallet addresses or tagged handles."
                : "The connected creator wallet creates the tab and receives every settlement. Members can be wallet addresses or tagged handles."}
          </p>

          {!cyclesValid ? (
            <p className="bill-poster-msg" data-tone="error" role="status">
              Cycles must be at least 1.
            </p>
          ) : !customDaysValid ? (
            <p className="bill-poster-msg" data-tone="error" role="status">
              Custom days must be a whole number of at least 1 day.
            </p>
          ) : recurringCreateMessage ? (
            <p
              className="bill-poster-msg"
              data-tone={recurringCreateMessageTone === "neutral" ? undefined : recurringCreateMessageTone}
              role="status"
            >
              {recurringCreateMessage}
            </p>
          ) : null}

          <div className="bill-poster-foot">
            <button
              className="settle-action"
              disabled={recurringState === "working" || !scheduleValid}
              onClick={createOnchainTab}
              type="button"
            >
              {recurringState === "working" ? "opening…" : "open the tab"} ›
            </button>
            <div className="bill-poster-total" data-tone={balanced ? undefined : "warn"}>
              <span className="settle-label">Shares</span>
              <span>
                ${shareTotalUsd.toFixed(2)} <em>of ${totalUsd.toFixed(2)}</em>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── 02 ────────────────────────────────────────────────────────────────
          The tabs either wallet touches, as ledger lines — the .iou-row the IOU
          page keeps its history in, since that is what this is. The row being
          read below goes to ink with its rule at full strength, which is the
          same "you are here" the masthead's contents rail draws. */}
      <section className="bill-poster">
        <div className="bill-poster-head">
          <span className="settle-label">02 · Your tabs</span>
          <div className="bill-poster-marks">
            {tabRowCount > 0 ? (
              <span className="bill-poster-fact">
                <b>{tabRowCount}</b> tab{tabRowCount === 1 ? "" : "s"}
              </span>
            ) : null}
            {/* Hidden rather than disabled: .iou-provider has no disabled look
                to speak of, and the body already says why there is nothing to
                refresh. */}
            {actingAccount ? (
              <button className="iou-provider" onClick={refreshRecurringTabsForWallet} type="button">
                refresh
              </button>
            ) : null}
            {tabRowCount > 3 || !tabsShown ? (
              <button className="iou-provider" onClick={() => setTabsExpanded(!tabsShown)} type="button">
                {tabsShown ? "collapse" : "expand"}
              </button>
            ) : null}
          </div>
        </div>
        <p className="bill-poster-note">
          Every tab either of your wallets touches — the ones you collect on and the ones you pay into. Pick one and 03
          to 05 below report on it.
        </p>

        <div className="bill-poster-body">
          {/* .iou-ledger for the top rule and nothing else — a row draws only its
              own bottom border, so without it the list opens on nothing where
              .bill-payer would have opened on a hairline. Its head is skipped:
              the marks rail above already carries the count. */}
          <div className="iou-ledger">
            {!actingAccount ? (
              <p className="iou-empty">Connect a wallet or sign in, and your recurring tabs load here.</p>
            ) : tabRowCount === 0 ? (
              <p className="iou-empty">No recurring tabs on either wallet yet. Open one above.</p>
            ) : !tabsShown ? (
              <p className="iou-empty">{tabRowCount} recurring tabs. Expand to read and act on each.</p>
            ) : (
              walletTabs.flatMap((tab) => {
                // A tab where the viewer is both recipient and a payer becomes
                // two rows so each role gets its own actions instead of one row
                // that mixes Approve and Claim.
                const roles: Array<"recipient" | "payer"> = [];
                if (isViewer(tab.recipient)) roles.push("recipient");
                if (tab.members.some((member) => isViewer(member.address))) roles.push("payer");
                if (roles.length === 0) roles.push("recipient");
                return roles.map((role) => {
                  const status =
                    role === "payer"
                      ? recurringTabPaidForWallet(tab)
                        ? "paid off"
                        : tab.dueCycles > 0n
                          ? `${tab.dueCycles.toString()} due now`
                          : `next ${formatUnix(tab.nextSettlementAt)}`
                      : `$${unitsToUsdc(tab.claimable)} claimable`;
                  return (
                    <div className="iou-row" key={`${tab.address}-${role}`}>
                      <button
                        // The selected row, said to a screen reader — the ink and
                        // the lit rule say it to everyone else.
                        aria-current={tabState?.address === tab.address && viewingRole === role ? "true" : undefined}
                        className="iou-row-recall"
                        onClick={() => {
                          setViewRole(role);
                          selectRecurringTab(tab.address);
                        }}
                        type="button"
                      >
                        {shortAddress(tab.address)}
                        <span className="iou-row-note"> · {role === "payer" ? "you pay in" : "you collect"}</span>
                      </button>
                      <span className="iou-row-amount">{status}</span>
                    </div>
                  );
                });
              })
            )}
          </div>

          {recurringMessage ? (
            <p
              className="bill-poster-msg"
              data-tone={recurringState === "error" ? "error" : recurringState === "success" ? "success" : undefined}
              role="status"
            >
              {recurringMessage}
            </p>
          ) : null}
        </div>
      </section>

      {/* 03 to 05 are about one selected tab, so they arrive with it — and the
          key is the tab AND the role, so flipping between the two rows of a
          dual-role tab replays the entrance rather than swapping the figures
          under the reader. */}
      <AnimatePresence mode="wait">
        {tabState ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="space-y-5"
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 12 }}
            key={`${tabState.address}-${viewingRole}`}
            transition={{ duration: 0.26, ease: "easeOut" }}
          >
            {/* ── 03 ──────────────────────────────────────────────────────────
                Where the selected tab stands. Two figures in the lede, the rest
                of the schedule on the rail, and — on the collecting side — one
                poster line per member with their own figures as footnotes. */}
            <section className="bill-poster">
              <div className="bill-poster-head">
                <span className="settle-label">03 · Where it stands</span>
                <div className="bill-poster-marks">
                  <span className="bill-poster-fact">{isRecipient ? "you collect" : "you pay in"}</span>
                  {/* The contract, as evidence rather than as a route diagram:
                      mono, dim, and openable. */}
                  <a
                    className="iou-row-tx"
                    href={`https://testnet.arcscan.app/address/${tabState.address}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {shortAddress(tabState.address)}
                  </a>
                  {activeTabComplete ? (
                    <span className="settle-label" data-tone="ok">
                      all cycles run
                    </span>
                  ) : dueAmount > 0n ? (
                    <span className="settle-label" data-tone="warn">
                      ${unitsToUsdc(dueAmount)} due now
                    </span>
                  ) : (
                    <span className="settle-label">not due yet</span>
                  )}
                </div>
              </div>
              <p className="bill-poster-note">
                {isRecipient
                  ? "Where this tab stands cycle by cycle: what each member has approved, what their wallet can cover, and what is collectable right now."
                  : "Your side of this tab: the share per cycle, what you have approved, and whether your wallet can cover the next collection."}
              </p>

              <div className="bill-poster-body">
                {actingAccount && visibleMembers.length === 1 && !isRecipient && visibleMembers[0] ? (
                  (() => {
                    const debtor = visibleMembers[0];
                    const debtorTotal = debtor.fixedShare * tabState.maxSettlements;
                    const debtorPaidOff = debtor.totalSettled >= debtorTotal;
                    const needed = debtor.dueNow > 0n ? debtor.dueNow : activeTabComplete ? 0n : debtor.fixedShare;
                    const approvalShort = debtor.allowance < needed;
                    const balanceShort = debtor.walletBalance < needed;
                    const bridgeAmount = needed > 0n ? needed : debtor.fixedShare;
                    const status = debtorPaidOff
                      ? "paid off"
                      : debtor.dueNow > 0n && approvalShort
                        ? "needs approval"
                        : debtor.dueNow > 0n && balanceShort
                          ? "low balance"
                          : debtor.dueNow > 0n
                            ? activeTabComplete
                              ? "partially paid"
                              : "ready to settle"
                            : tabState.dueCycles === 0n
                              ? "not due yet"
                              : "ready to settle";
                    // Warn is for a state that wants something from you, not for
                    // every state that isn't finished: "not due yet" is the tab
                    // working correctly, and colouring it like a problem trains
                    // people to ignore the colour.
                    const attention = status === "needs approval" || status === "low balance" || status === "partially paid";
                    return (
                      <>
                        <div className="bill-poster-lede">
                          {/* The one figure a payer came for. Paid off, it is a
                              word rather than a zero — "$0.00 due" and "nothing
                              left to pay" are not the same sentence. */}
                          <div className="bill-cell">
                            <span className="settle-label">
                              {debtorPaidOff ? "Your side" : activeTabComplete ? "Outstanding" : "Due now"}
                            </span>
                            <div className="bill-figure">
                              {debtorPaidOff ? (
                                "paid off"
                              ) : (
                                <>
                                  <span className="bill-currency">$</span>
                                  {unitsToUsdc(debtor.dueNow)}
                                </>
                              )}
                            </div>
                            <div className="bill-cell-rule" />
                          </div>
                          <div className="bill-cell">
                            <span className="settle-label">Your share, per cycle</span>
                            <div className="bill-figure">
                              <span className="bill-currency">$</span>
                              {unitsToUsdc(debtor.fixedShare)}
                            </div>
                            <div className="bill-cell-rule" />
                          </div>
                        </div>

                        {/* The rail answers "can this cycle actually collect?" —
                            so the verdict is the first entry on it, in the same
                            slot a figure would take. A word where a number goes
                            is the point: it is the one readout that isn't
                            arithmetic, and the two figures it depends on sit
                            right beside it, toned when they are the reason. */}
                        <div className="bill-poster-rail">
                          <PosterFact label="Status" tone={attention ? "warn" : undefined} value={status} />
                          <PosterFact
                            label="Approved"
                            tone={approvalShort && debtor.dueNow > 0n ? "warn" : undefined}
                            value={`$${unitsToUsdc(debtor.allowance)}`}
                          />
                          <PosterFact
                            label="Wallet balance"
                            tone={balanceShort && debtor.dueNow > 0n ? "warn" : undefined}
                            value={`$${unitsToUsdc(debtor.walletBalance)}`}
                          />
                          <PosterFact label="Paid so far" value={`$${unitsToUsdc(debtor.totalSettled)}`} />
                          <PosterFact label="Your debt total" value={`$${unitsToUsdc(debtorTotal)}`} />
                          <PosterFact
                            label="Next collection"
                            value={activeTabComplete ? "complete" : formatUnix(tabState.nextSettlementAt)}
                          />
                        </div>

                        {/* Bridging needs a browser-wallet session AND the debtor
                            to be that wallet; Splitsy (DCW) members top up from
                            the wallet dock instead. */}
                        {!debtorPaidOff &&
                        recurringWallet &&
                        debtor.address.toLowerCase() === recurringWallet.account.toLowerCase() ? (
                          <div className="bill-options">
                            <button
                              aria-pressed={showBridge}
                              className="iou-provider bill-toggle"
                              onClick={() => setShowBridge((open) => !open)}
                              type="button"
                            >
                              bring usdc to arc
                            </button>
                            {showBridge
                              ? bridgeSourceChains.map((chain) => (
                                  <button
                                    aria-pressed={selectedBridgeChain === chain.id}
                                    className="iou-provider bill-toggle"
                                    disabled={recurringState === "working"}
                                    key={chain.id}
                                    onClick={() => {
                                      setSelectedBridgeChain(chain.id);
                                      bridgeForRecurring(unitsToUsdc(bridgeAmount), chain.id);
                                    }}
                                    type="button"
                                  >
                                    from {chain.label}
                                  </button>
                                ))
                              : null}
                          </div>
                        ) : null}

                        <p className="bill-options-hint">
                          {debtorPaidOff
                            ? "Every cycle on this tab has been collected from your wallet. Nothing further can be pulled."
                            : debtor.dueNow > 0n
                              ? activeTabComplete
                                ? "All cycle windows have passed, but the outstanding recurring debt can still be collected once it is approved."
                                : "Funds stay in your wallet unless this tab is approved for the due amount and the cycle time has arrived."
                              : "No recurring debt is currently due for this wallet."}
                        </p>
                        {showBridge ? (
                          <p className="bill-options-hint">
                            {balanceShort
                              ? `Your Arc balance is below the $${unitsToUsdc(bridgeAmount)} USDC this cycle needs. `
                              : ""}
                            CCTP V2 moves USDC from another chain to Arc in three transactions — approve, bridge, then
                            claim on Arc Testnet. After it lands, approve the tab in 04 so the due cycle can be
                            collected.
                          </p>
                        ) : null}

                        {debtorPaidOff ? (
                          <div className="bill-poster-foot">
                            <span className="bill-poster-fact">
                              Collected <b>${unitsToUsdc(debtor.totalSettled)}</b> across{" "}
                              <b>{tabState.maxSettlements.toString()}</b> cycles.
                            </span>
                            <div className="settlement-stamp">Paid off</div>
                          </div>
                        ) : null}
                      </>
                    );
                  })()
                ) : (
                  <>
                    <div className="bill-poster-lede">
                      <div className="bill-cell">
                        <span className="settle-label">Due now, across members</span>
                        <div className="bill-figure">
                          <span className="bill-currency">$</span>
                          {unitsToUsdc(dueAmount)}
                        </div>
                        <div className="bill-cell-rule" />
                      </div>
                      <div className="bill-cell">
                        <span className="settle-label">Claimable</span>
                        <div className="bill-figure">
                          <span className="bill-currency">$</span>
                          {unitsToUsdc(tabState.claimable)}
                        </div>
                        <div className="bill-cell-rule" />
                      </div>
                    </div>

                    <div className="bill-poster-rail">
                      <PosterFact
                        label="Cycles run"
                        value={`${tabState.settlementCount.toString()} of ${tabState.maxSettlements.toString()}`}
                      />
                      <PosterFact label="Cycle length" value={formatDuration(tabState.settlementInterval)} />
                      <PosterFact
                        label="Next collection"
                        value={activeTabComplete ? "complete" : formatUnix(tabState.nextSettlementAt)}
                      />
                      <PosterFact
                        label="Overdue cycles"
                        tone={tabState.dueCycles > 0n ? "warn" : undefined}
                        value={tabState.dueCycles.toString()}
                      />
                      <PosterFact label="Collects into" value={shortAddress(tabState.recipient)} />
                    </div>

                    {/* One member, one line — the create form's row read back off
                        the chain. The figures that qualify them are footnotes to
                        the line, in the same register the one-off puts a payer's
                        namespace and reputation. */}
                    <div className="bill-payers">
                      {tabState.members.map((member) => {
                      const memberDebtTotal = member.fixedShare * tabState.maxSettlements;
                      const memberPaidOff = member.totalSettled >= memberDebtTotal;
                      const memberStatus = memberPaidOff
                        ? "paid"
                        : activeTabComplete
                          ? member.totalSettled > 0n
                            ? "partial"
                            : "unpaid"
                          : tabState.dueCycles === 0n
                            ? "waiting"
                            : member.collectible
                              ? "ready"
                              : "short";
                      return (
                        <div className="bill-payer" key={member.address}>
                          <div className="bill-payer-line">
                            <span className="bill-payer-target">
                              <PayerMark provider="wallet" target={member.address} />
                              {shortAddress(member.address)}
                            </span>
                            <span className="bill-payer-share" data-empty={member.dueNow === 0n}>
                              <span className="bill-currency">$</span>
                              {unitsToUsdc(member.dueNow)}
                            </span>
                          </div>
                          <div className="bill-payer-meta">
                            {/* Same rule as the payer view's Status: ok for the
                                two finished states, warn only where the member is
                                the reason a cycle cannot collect, and the plain
                                dim for "waiting", which is nobody's problem. */}
                            <span
                              className="settle-label"
                              data-tone={
                                memberPaidOff || memberStatus === "ready"
                                  ? "ok"
                                  : memberStatus === "waiting"
                                    ? undefined
                                    : "warn"
                              }
                            >
                              {memberStatus}
                            </span>
                            <span className="bill-poster-fact">
                              share <b>${unitsToUsdc(member.fixedShare)}</b>
                            </span>
                            <span className="bill-poster-fact">
                              approved <b>${unitsToUsdc(member.allowance)}</b>
                            </span>
                            <span className="bill-poster-fact">
                              balance <b>${unitsToUsdc(member.walletBalance)}</b>
                            </span>
                            <span className="bill-poster-fact">
                              collected <b>${unitsToUsdc(member.totalSettled)}</b>
                            </span>
                            <span className="bill-poster-fact">
                              still owed <b>${unitsToUsdc(member.remainingTotal)}</b>
                            </span>
                          </div>
                        </div>
                      );
                      })}
                    </div>

                    <p className="bill-options-hint">
                      Collection needs three things at once: the payer&apos;s approval, enough USDC in their wallet, and
                      a cycle that has actually fallen due. Until then the money stays where it is.
                    </p>
                  </>
                )}
              </div>
            </section>

            {/* ── 04 ──────────────────────────────────────────────────────────
                The commit, in the same shape the one-off's 03 ends on: the word
                that acts, the alternative to it opposite, and the arithmetic
                that justifies pressing it. */}
            <section className="bill-poster">
              <div className="bill-poster-head">
                <span className="settle-label">04 · Act on it</span>
                <div className="bill-poster-marks">
                  <span className="bill-poster-fact">
                    on <b>{shortAddress(tabState.address)}</b>
                  </span>
                </div>
              </div>
              <p className="bill-poster-note">
                {isRecipient
                  ? "Collecting only ever pulls a share that is already due and already approved. Nothing here can take more than that."
                  : "Approving lets this tab collect your share when a cycle falls due — and only then. The money stays in your wallet until that moment, and you can withdraw the approval whenever you like."}
              </p>

              <div className="bill-poster-body">
                {isRecipient ? (
                  <div className="bill-poster-foot">
                    <button
                      className="settle-action"
                      disabled={tabState.claimable <= 0n || recurringState === "working"}
                      onClick={claimActiveRecurringFunds}
                      type="button"
                    >
                      {recurringState === "working" ? "claiming…" : `claim $${unitsToUsdc(tabState.claimable)}`} ›
                    </button>
                    <div className="bill-poster-total">
                      <span className="settle-label">Collected on this tab</span>
                      <span>
                        ${unitsToUsdc(tabCollected)} <em>of ${unitsToUsdc(tabCommitted)}</em>
                      </span>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* The limit you set, against the figure it has to cover —
                        set as a lede pair rather than a one-cell rail, because
                        auto-fit would stretch a single cell to the full column
                        and draw a 1400px rule under "$50.00".

                        A Splitsy (DCW) member's approval is set server-side to
                        exactly their remaining debt, so there is no limit to pick
                        and no pair: just the sentence saying so, and the word
                        that does it. */}
                    {recurringWallet && (!viewerMember || walletIsTabMember) ? (
                      <div className="bill-poster-lede">
                        <div className="bill-cell">
                          <span className="settle-label">Approval limit USD</span>
                          <div className="bill-figure">
                            <span className="bill-currency">$</span>
                            <PosterValue
                              ariaLabel="Approval limit in USD"
                              decimal
                              onChange={setAuthorizationAmount}
                              placeholder={approvalPlaceholder || "0.00"}
                              value={authorizationAmount}
                            />
                          </div>
                          <div className="bill-cell-rule" />
                        </div>
                        <div className="bill-cell">
                          <span className="settle-label">Still collectable from you</span>
                          <div className="bill-figure">
                            <span className="bill-currency">$</span>
                            {viewerMember ? unitsToUsdc(viewerMember.remainingTotal) : approvalPlaceholder || "0.00"}
                          </div>
                          <div className="bill-cell-rule" />
                        </div>
                      </div>
                    ) : null}

                    <p className="bill-options-hint">
                      {recurringWallet && (!viewerMember || walletIsTabMember)
                        ? `Left empty this approves ${approvalPlaceholder || "your outstanding share"} USDC — what this tab can still collect from you. Funds stay in your wallet unless a cycle has fallen due.`
                        : "Approving from your Splitsy wallet authorizes exactly your remaining recurring debt on this tab, and nothing beyond it."}
                    </p>

                    {/* Withdrawing an approval is not a second commit — it is the
                        alternative to this one, so it sits opposite it on the same
                        line, the way the one-off's "or enter it by hand" sits
                        opposite Scan. */}
                    <div className="bill-poster-foot">
                      <button
                        className="settle-action"
                        disabled={recurringState === "working"}
                        onClick={authorizeActiveTab}
                        type="button"
                      >
                        {recurringState === "working" ? "approving…" : "approve"} ›
                      </button>
                      <button className="iou-provider" onClick={revokeActiveTab} type="button">
                        or withdraw the approval
                      </button>
                    </div>

                    {viewerMember ? (
                      <p className="bill-options-hint">
                        You have paid ${unitsToUsdc(viewerMember.totalSettled)} of $
                        {unitsToUsdc(viewerMember.fixedShare * tabState.maxSettlements)} on this tab.
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </section>

            {/* ── 05 ──────────────────────────────────────────────────────────
                What Arc recorded, as the same ledger lines 02 lists tabs in —
                each one a transaction you can open and check. */}
            {visibleEvents.length > 0 ? (
              <section className="bill-poster">
                <div className="bill-poster-head">
                  <span className="settle-label">05 · On chain</span>
                  <div className="bill-poster-marks">
                    <span className="bill-poster-fact">
                      <b>{visibleEvents.length}</b> event{visibleEvents.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                <p className="bill-poster-note">
                  {isRecipient
                    ? "Everything this tab has done on Arc, newest first. Each line is a transaction you can open and check yourself."
                    : "Your own activity on this tab, newest first. Each line is a transaction you can open and check yourself."}
                </p>

                <div className="bill-poster-body">
                  <div className="iou-ledger">
                    {visibleEvents.slice(0, 5).map((event, index) => (
                      <div
                        className="iou-row"
                        key={`${event.txHash}-${event.name}-${event.blockNumber.toString()}-${index}`}
                      >
                        <span className="min-w-0">
                          {event.name}
                          <span className="iou-row-note"> · block {event.blockNumber.toString()}</span>
                        </span>
                        <a
                          className="iou-row-tx"
                          href={`https://testnet.arcscan.app/tx/${event.txHash}`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {shortAddress(event.txHash)}
                        </a>
                      </div>
                    ))}
                  </div>
                  {visibleEvents.length > 5 ? (
                    // No silent truncation: five rows is a deliberate cap, so the
                    // page says how many it is not showing.
                    <p className="bill-options-hint">
                      Showing the 5 most recent of {visibleEvents.length} transactions on this tab.
                    </p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

// The progress dialog, in the poster's voice.
//
// It was the app's last spec-sheet surface and the most-seen one: every pay,
// claim and bridge opens it. A bordered white card, a filled circle with a glyph
// in it for the flow, a second filled circle per step joined by a 2px connector,
// weight-740 step labels, and a filled black pill to close. None of that survived
// anywhere else in the product, and this is the one panel a user cannot dismiss
// while it works.
//
// It now says the same things the way the rest of the app does: a caps rail fact,
// one display line, a standfirst, the steps as numbered entries each on their own
// rule, and the commit word to close. Nothing draws a box; state is the rule under
// a step and the words in its hint.
//
// The step glyphs went with the boxes — a step's ordinal is what a reader needs
// ("which of three am I on"), it comes free from the array, and it is how 01–04
// are already numbered on every poster in the bills tab. That is what retired
// FlowStep.icon.
function ProgressModal({ flow, onClose }: { flow: ProgressFlow; onClose: () => void }) {
  const running = flow.status === "running";
  const succeeded = flow.status === "success";
  const isBridge = flow.kind === "bridge";
  const isClaim = flow.kind === "claim";
  // A bridge that got past its burn+attestation step and then failed has not
  // lost the money, but it has not left it where the payer can reach it either:
  // it is burned on the source chain and claimable only against the attestation.
  // "No funds were lost" is true of a reverted payment and misleading here.
  const burned = isBridge && flow.steps.find((step) => step.key === "bridge")?.state === "done";

  const title = isBridge
    ? succeeded
      ? "Bridged to Arc"
      : flow.status === "error"
        ? "Bridge failed"
        : "Bridging to Arc"
    : isClaim
      ? succeeded
        ? "Funds claimed"
        : flow.status === "error"
          ? "Claim failed"
          : "Claiming funds"
      : succeeded
        ? "Payment settled"
        : flow.status === "error"
          ? "Payment failed"
          : "Settling on Arc";

  const verb = isBridge ? "Moving" : isClaim ? "Claiming" : "Paying";
  const destination = isBridge ? "to Arc" : isClaim ? "from" : "toward";
  const subtitle =
    flow.status === "error"
      ? flow.errorMessage || "Something went wrong."
      : succeeded
        ? isBridge
          ? `$${flow.amountLabel} USDC has arrived on your Arc wallet ${flow.contextLabel}.`
          : isClaim
            ? `Claimed $${flow.amountLabel} USDC from ${flow.contextLabel}.`
            : `Paid $${flow.amountLabel} USDC ${flow.contextLabel}.`
        : `${verb} $${flow.amountLabel} USDC ${destination} ${flow.contextLabel}.`;

  return (
    <Dialog.Root
      open={flow.open}
      onOpenChange={(open) => {
        if (!open && !running) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="flow-backdrop" />
        <Dialog.Content
          aria-describedby="flow-sub"
          className="flow-panel"
          data-status={flow.status}
          onEscapeKeyDown={(event) => running && event.preventDefault()}
          onInteractOutside={(event) => running && event.preventDefault()}
        >
          <div className="flow-head">
            <div className="bill-poster-head">
              {/* The rail fact: which bill this is about. Deliberately NOT the
                  amount as well — the standfirst two lines down is already a
                  sentence with the figure in it, and saying "$42.60 USDC" twice
                  in four lines reads as a rendering bug.

                  Nothing sits opposite it. The dismiss is the word in the foot,
                  and a second one up here said "close" 500px from a button that
                  says "done" for the identical action. Escape still closes it —
                  Radix handles that, and the guard below is what seals the dialog
                  while a transaction is actually in flight. */}
              <span className="settle-label">{flow.contextLabel}</span>
            </div>
            <Dialog.Title className="flow-title" data-status={flow.status}>
              {title}
            </Dialog.Title>
            <Dialog.Description className="bill-poster-note" id="flow-sub">
              {subtitle}
            </Dialog.Description>
          </div>

          <ol className="flow-steps">
            {flow.steps.map((step, index) => (
              <li className="flow-step" data-state={step.state} key={step.key}>
                <div className="flow-step-line">
                  <span className="settle-label">
                    {String(index + 1).padStart(2, "0")} · {step.label}
                  </span>
                  {/* The step's own evidence, on the step — where it belongs.
                      These used to be collected into a separate link block under
                      the whole list, which left the reader matching hashes to
                      rows by name. */}
                  {step.explorerUrl ? (
                    <a className="iou-row-tx" href={step.explorerUrl} rel="noreferrer" target="_blank">
                      transaction
                      <ExternalLink size={11} />
                    </a>
                  ) : step.state === "active" ? (
                    <Loader2 aria-hidden className="flow-step-spin animate-spin" size={13} />
                  ) : null}
                </div>
                <p className="flow-step-hint">
                  {step.state === "done" ? "confirmed" : step.state === "error" ? "failed" : step.hint}
                </p>
                <div className="flow-step-rule" />
              </li>
            ))}
          </ol>

          <div className="bill-poster-foot flow-foot">
            <p
              className="bill-poster-msg"
              data-tone={succeeded ? "success" : flow.status === "error" ? "error" : undefined}
              role="status"
            >
              {running
                ? (flow.runningLabel ?? (isBridge ? "Keep this open until the bridge finishes" : "Confirm each step in your wallet"))
                : succeeded
                  ? "All transactions confirmed"
                  : burned
                    ? "Burned on the source chain — the USDC is still waiting to be claimed on Arc"
                    : "No funds were lost"}
            </p>
            {!running ? (
              <button className="settle-action" onClick={onClose} type="button">
                {succeeded ? "done" : "close"} ›
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function fireSuccessConfetti() {
  if (typeof window === "undefined") {
    return;
  }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  void confetti({
    particleCount: 120,
    spread: 70,
    startVelocity: 38,
    origin: { y: 0.42 },
    colors: ["#2775ca", "#3ee6d6", "#17a56b"],
    scalar: 0.9,
  });
}

// Watches Gateway transfer ids until their batch settles, yielding a
// {transferId -> txHash} map. Batches land in minutes, so this polls slowly and
// stops as soon as every payment on screen has a hash.
function useBatchSettlement(payments: ScoutReport["payments"]) {
  const [settled, setSettled] = useState<Record<string, string>>({});

  const pendingKey = payments
    .map((p) => p.tx)
    .filter((tx): tx is string => Boolean(tx) && !tx!.startsWith("0x"))
    .join(",");

  useEffect(() => {
    const ids = pendingKey ? pendingKey.split(",") : [];
    if (ids.length === 0) return;

    let live = true;
    let pending = new Set(ids);

    const check = async () => {
      const found: Record<string, string> = {};
      await Promise.all(
        [...pending].map(async (id) => {
          try {
            const res = await fetch(`/api/scout/transfer?id=${encodeURIComponent(id)}`);
            const data = (await res.json()) as { txHash?: string | null };
            if (data.txHash) found[id] = data.txHash;
          } catch {
            // Transient — the next tick retries.
          }
        }),
      );
      if (!live) return;

      const hashes = Object.keys(found);
      if (hashes.length > 0) {
        pending = new Set([...pending].filter((id) => !found[id]));
        setSettled((current) => ({ ...current, ...found }));
      }
      if (pending.size === 0) clearInterval(timer); // everything landed — stop polling
    };

    // Declared before the first run so `check` can clear it once everything lands.
    const timer = setInterval(check, 20_000);
    check();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pendingKey]);

  return settled;
}

// What the "!" explains. Kept next to the receipt because this is the only place
// a user meets the agent economy, and "an agent paid for your scan" needs saying.
const X402_EXPLAINER = [
  "Scout is an autonomous agent with its own wallet and on-chain identity (ERC-8004 #).",
  "Splitsy's scanning and currency endpoints are paywalled with x402, the HTTP standard for machine payments. Scout signs a gasless USDC authorization for each call it makes, and Circle Gateway batches those payments into one on-chain settlement on Arc.",
  "Every payment below is checkable: 'receipt' opens Circle's own record of it, and 'settled tx' opens the batch transaction on Arc once that batch lands.",
  "It decides for itself: it refuses photos too poor to read, buys a second stricter opinion when its own parse looks unsure, and stops at a daily budget. If paying ever fails, it falls back to a free scan so your bill still goes through.",
];

function X402Info() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-label="How agent payments work"
          className="inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px] font-bold leading-none"
          // Inside a <summary>, a click would toggle the disclosure — this is a
          // hover affordance, not a second toggle.
          onClick={(event) => event.preventDefault()}
          type="button"
        >
          !
        </TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-2 text-left font-normal leading-relaxed" side="top">
          {X402_EXPLAINER.map((paragraph) => (
            <p key={paragraph.slice(0, 24)}>{paragraph}</p>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// The agent's receipt: what Scout paid, to which endpoint, and what it had left.
// Collapsed to a single line by default — the nanopayments should be visible but
// not shout over the bill the user actually came to check.
function ScoutReceipt({ report }: { report: ScoutReport }) {
  const { agent, payments, degraded } = report;
  const settledTx = useBatchSettlement(payments);
  return (
    <details className="bill-items bill-scout scout-receipt">
      <summary>
        <span className="settle-label">
          <Bot className="inline-block align-[-0.15em]" size={13} /> scanned by scout
        </span>
        <span className="bill-items-total">
          {degraded ? "unpaid fallback" : `${report.totalSpentUsd.toFixed(3)} USDC`}
          <X402Info />
          <ChevronDown className="scout-receipt-chevron" size={16} />
        </span>
      </summary>

      <div className="bill-scout-body">
        <p>
          Agent{" "}
          <a href={`https://testnet.arcscan.app/address/${agent.address}`} rel="noreferrer" target="_blank">
            {agent.address.slice(0, 6)}…{agent.address.slice(-4)}
          </a>
          {agent.tokenId ? ` · ERC-8004 #${agent.tokenId}` : ""}
        </p>

        {payments.length > 0 ? (
          <ul>
            {payments.map((payment, index) => (
              <li key={`${payment.endpoint}-${index}`}>
                Paid <b>{payment.amountUsd.toFixed(3)} USDC</b> → {payment.endpoint}
                {payment.confidence != null ? ` (confidence ${(payment.confidence * 100).toFixed(0)}%)` : ""}
                {/* Two different receipts, and both are worth having:
                      · Circle's record of THIS payment — who paid whom, how much,
                        and its status. Available the instant it settles.
                      · the batch TRANSACTION on Arc, which carries this payment
                        among others and only exists once the batch lands
                        (minutes later — useBatchSettlement waits for it).
                    Neither substitutes for the other: the transaction proves money
                    moved on chain but names no single payment, and the receipt
                    names the payment but is Circle's word for it. */}
                {payment.tx && !payment.tx.startsWith("0x") ? (
                  <>
                    {" · "}
                    <a
                      href={gatewayReceiptUrl(payment.tx)}
                      rel="noreferrer"
                      target="_blank"
                      title="Circle's own record of this x402 payment"
                    >
                      receipt {payment.tx.slice(0, 8)}…
                    </a>
                  </>
                ) : null}
                {(() => {
                  const hash = payment.tx?.startsWith("0x") ? payment.tx : settledTx[payment.tx ?? ""];
                  if (hash) {
                    return (
                      <>
                        {" · "}
                        <a href={`https://testnet.arcscan.app/tx/${hash}`} rel="noreferrer" target="_blank">
                          settled tx
                        </a>
                      </>
                    );
                  }
                  // Not "no transaction" — not yet. Saying which it is stops the
                  // receipt reading as a payment that failed to land.
                  return payment.tx ? <span> · batching</span> : null;
                })()}
              </li>
            ))}
          </ul>
        ) : null}

        <p>
          Spent <b>{report.totalSpentUsd.toFixed(3)} USDC</b> · budget left{" "}
          <b>{report.budgetRemainingUsd.toFixed(3)} USDC</b>
          {degraded ? " · fell back to an unpaid scan" : ""}
        </p>
      </div>
    </details>
  );
}

// An editable value with no chrome, the mark at the head of a payer line, and the
// two rail entries — all four of the poster's parts now live in app/SpecCard.tsx
// alongside the heroes, because Agents imports them too and that file cannot
// import this one.

// The mark at the head of a payer line: their face when we can get it, otherwise
// the mark of the namespace they are tagged in. One slot, four answers — and the
// face arriving is the confirmation that the handle became a real account.
//
// Only X shows a face. Discord has no public username→avatar CDN, and for an
// email or a wallet a stranger's face is a liability rather than a confirmation:
// the Gravatar behind an address you mistyped belongs to whoever owns that
// address, so a wrong target would still look right. Their glyph says which
// namespace this is; the text beside it says who, and is the thing to check.
function PayerMark({ provider, target }: { provider: AccountProvider; target: string }) {
  const handle = target.trim().replace(/^@+/, "");
  // unavatar is asked once the handle settles, not once per keystroke.
  const [settled, setSettled] = useState(handle);
  // The src that actually loaded — comparing it to the current src drops the old
  // face the moment the handle changes, without a setState-in-effect reset.
  const [loadedSrc, setLoadedSrc] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setSettled(handle), 400);
    return () => clearTimeout(timer);
  }, [handle]);

  if (handle === "") return null;

  // fallback=false, so a handle that isn't an account 404s and keeps the X mark.
  // unavatar's default is a GENERATED face, which would make every misspelling
  // look like it had resolved to somebody.
  const src =
    provider === "x" && validHandle("x", settled)
      ? `https://unavatar.io/x/${settled.toLowerCase()}?fallback=false`
      : "";
  // A face is a claim about the handle in the field, so an edited handle drops it
  // at once and the platform mark comes back until the new one resolves — the
  // alternative is showing one person while the line names another.
  const face = src !== "" && loadedSrc === src && settled === handle;

  return (
    // Decorative: the rail under this line already names the namespace in words,
    // so the glyph repeats it rather than adding anything a reader would miss.
    <span aria-hidden className="bill-payer-mark" data-face={face} data-provider={provider}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote unavatar URL, not a bundled asset
        <img alt="" onError={() => setLoadedSrc("")} onLoad={() => setLoadedSrc(src)} src={src} />
      ) : null}
      {provider === "discord" ? (
        <DiscordIcon />
      ) : provider === "email" ? (
        <Mail strokeWidth={1.5} />
      ) : provider === "wallet" ? (
        <Wallet strokeWidth={1.5} />
      ) : (
        <XIcon />
      )}
    </span>
  );
}

// One labelled figure on the poster's rail: caps label, the value, and the rule
// that lights when the value has focus. See app/SpecCard.tsx for PosterCell and
// PosterFact.
//
// The old <Message> tone box stood here — a tinted, bordered card with an icon in
// it, and the last piece of that system left in the app. Every status this file
// reports now takes .bill-poster-msg, the same one-line caps register /pay and
// the agents panel use, so a result reads the same wherever it lands.

// One tab on the header rail. The same control the dashboard's view pair and the
// Bills tab's One-off/Recurring rail are built from — .iou-provider for the
// borderless caps word, .bill-toggle for the rule that draws itself under the one
// you are reading — so the app has one way of saying "this is where you are"
// instead of a pill up here and a rule everywhere else.
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-current={active ? "true" : undefined}
      className="iou-provider bill-toggle"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

// The wallet, on the rail — moved to app/WalletMark.tsx so /pay's header can
// render the same mark without importing this module.

function sourceLabel(id: BridgeSourceChain) {
  return bridgeSourceChains.find((chain) => chain.id === id)?.label ?? id;
}

function toUsdInput(value: number, rate: number) {
  return (value * rate).toFixed(2);
}

// A single ellipsis character, not three periods: this string is set beside
// lib/iou's shortAddress on the same surfaces (the poster's payer rows, the IOU
// ledger), and two different elisions of the same address read as a bug. Every
// caller renders it — nothing hashes or compares it.
function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Walk an error and its `cause` chain looking for the signatures wallets use
// when a user declines a request: EIP-1193 code 4001, ethers' ACTION_REJECTED,
// or viem's "User rejected the request." Returning a short, friendly message
// keeps a cancelled transaction from dumping a wall of provider text on the page.
function isUserRejection(caught: unknown, depth = 0): boolean {
  if (!caught || typeof caught !== "object" || depth > 5) {
    return false;
  }

  const err = caught as { code?: number | string; name?: string; shortMessage?: string; message?: string; cause?: unknown };

  if (err.code === 4001 || err.code === "ACTION_REJECTED") {
    return true;
  }

  const text = `${err.name ?? ""} ${err.shortMessage ?? ""} ${err.message ?? ""}`.toLowerCase();
  if (/user rejected|user denied|rejected the request|request rejected|denied transaction signature|action_rejected/.test(text)) {
    return true;
  }

  return err.cause && err.cause !== caught ? isUserRejection(err.cause, depth + 1) : false;
}

// Provider/viem errors can be hundreds of characters with request dumps and
// stack details. Prefer viem's concise `shortMessage`, otherwise take the first
// line, and always cap the length so a failure never blows out the layout.
function conciseError(caught: unknown, fallback: string) {
  const shortMessage = (caught as { shortMessage?: string })?.shortMessage;
  const base = (typeof shortMessage === "string" && shortMessage.trim()) || fallback;
  const firstLine = base.split("\n")[0].trim();
  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}…` : firstLine;
}

// A failed bridge step is reported in the result, not thrown and not emitted over
// the event bus, so this is the only place its reason is legible. Name the step:
// a failure at Mint means the USDC is already burned on the source chain and is
// sitting in CCTP waiting to be claimed, which is not the same situation as a
// failed approval, however similar the two look from the modal.
function bridgeFailureMessage(result: BridgeSummary) {
  return result.error
    ? `${result.error.step} failed — ${result.error.message}`
    : "The bridge did not complete. No funds were claimed on Arc.";
}

function errorMessage(caught: unknown) {
  if (isUserRejection(caught)) {
    return "Transaction cancelled.";
  }

  const message = caught instanceof Error ? caught.message : typeof caught === "string" ? caught : "Unexpected wallet or payment error.";

  if (message.includes("TabComplete")) {
    return "This tab's deployed contract considers the schedule complete. Redeploy the recurring factory and create a new tab to collect late underpaid cycles after the final cycle.";
  }

  if (message.includes("NoCollectibleMembers")) {
    return "No member has collectable recurring debt right now. Check approval, wallet balance, and outstanding amount.";
  }

  if (message.includes("AlreadySettledForPeriod")) {
    return "No recurring cycle or outstanding balance is currently ready to settle.";
  }

  return conciseError(caught, message);
}

function normalizeAddress(value: string) {
  return getAddress(value.trim()) as `0x${string}`;
}

function normalizeOptionalAddress(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return normalizeAddress(trimmed);
}

function formatUnix(value: bigint) {
  if (value === 0n) {
    return "Complete";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(value) * 1000));
}

function formatDuration(seconds: bigint) {
  const totalSeconds = Number(seconds);

  if (totalSeconds < 3600) {
    return `${Math.max(1, Math.round(totalSeconds / 60))} min`;
  }

  const days = Math.round(totalSeconds / 86_400);
  return days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${Math.round(totalSeconds / 3600)} hr`;
}
