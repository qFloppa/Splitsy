"use client";

import {
  AlertTriangle,
  ArrowLeftRight,
  BadgeDollarSign,
  BookOpen,
  CalendarClock,
  Camera,
  ChevronDown,
  CheckCircle2,
  ExternalLink,
  FileJson,
  Info,
  Landmark,
  Loader2,
  Mail,
  Moon,
  Plus,
  ReceiptText,
  RefreshCw,
  Send,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  WalletCards,
  X,
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
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import XAuthControl from "./XAuthControl";
import SignInMenu from "./SignInMenu";
import XDebtsPanel from "./XDebtsPanel";
import XHistoryPanel from "./XHistoryPanel";
import DashboardPanel from "./DashboardPanel";
import { HistoryCard, PaidBillStamp } from "./HistoryCard";
import {
  bridgeSourceChains,
  bridgeUsdcToArc,
  BridgeSourceChain,
  type BridgeStepEvent,
  BridgeSummary,
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
  readDebtsForWallet,
  usdcToBillUnits,
  verifyBillPreimage,
  type BillPreimage,
  claimBillFunds,
} from "@/lib/bill-split-contracts";
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
  emptyParsedBill,
  equalSplit,
  normalizeParsedBill,
  ParsedBill,
  SplitParticipant,
} from "@/lib/snapsplit";
import { providerDisplay } from "@/lib/provider-display";
import { ReputationBadge } from "./ReputationBadge";
import type { IdentityProvider } from "@/lib/types";
import { useTheme } from "@/lib/use-theme";
import { wagmiConfig } from "@/lib/wagmi";

// A collapse/expand toggle that survives reloads. null = auto (caller decides
// from list length); an explicit tap persists true/false to localStorage.
// localStorage may be unavailable (private mode) — then it just isn't remembered.
function usePersistedExpand(key: string): [boolean | null, (next: boolean) => void] {
  const [value, setValue] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key);
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

type OcrState = "idle" | "reading" | "ready" | "error";
type BillRunState = "idle" | "connecting" | "working" | "success" | "error";
type RecurringRunState = "idle" | "connecting" | "working" | "error" | "success";
type AppTab = "bills" | "recurring" | "history" | "dashboard";
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
type FlowStepIcon = "switch" | "approve" | "pay" | "bridge" | "claim";
type FlowStep = {
  key: string;
  icon: FlowStepIcon;
  label: string;
  hint: string;
  state: FlowStepState;
  explorerUrl?: string;
};
type ProgressFlow = {
  kind: "pay" | "bridge" | "claim";
  open: boolean;
  amountLabel: string;
  contextLabel: string;
  status: "running" | "success" | "error";
  errorMessage: string;
  // Overrides the footer status while running — server-side (Circle wallet)
  // flows have no browser-wallet confirmations to point at.
  runningLabel?: string;
  steps: FlowStep[];
};

const recurringCycleOptions: Array<{ id: RecurringCycle; label: string; seconds: bigint }> = [
  { id: "test", label: "Every 3 minutes", seconds: 3n * 60n },
  { id: "weekly", label: "Weekly", seconds: 7n * 24n * 60n * 60n },
  { id: "monthly", label: "Monthly", seconds: 30n * 24n * 60n * 60n },
  { id: "custom", label: "Custom", seconds: 30n * 24n * 60n * 60n },
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

// A yyyy-mm-dd string from an <input type="date"> → Unix seconds at local
// midnight of that day, or undefined for empty/invalid input. `new Date("yyyy-
// mm-dd")` parses as UTC midnight, so we build the date from parts in local time
// instead — the creator means "due that calendar day where they are".
function dueDateToUnix(value: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor(date.getTime() / 1000);
}

// A dual-identity user (signed in social + connected browser wallet) has TWO
// Arc wallets that can create/pay/claim bills: their Circle DCW and their own
// non-custodial wallet. Registry rows are tagged with the wallet they were read
// for, so pay/claim can route each bill to the right signer — the server (DCW)
// or the browser wallet — instead of guessing from global connection state.
type OwnedBillSplitDebt = BillSplitDebt & { account: `0x${string}`; via: "wallet" | "social" };

// Which identity signs createBill (and therefore owns the bill + collects the
// payments) when both are available. Persisted so the picker remembers the
// creator's last choice across sessions.
type CreatorIdentity = "wallet" | "social";
const CREATOR_IDENTITY_KEY = "splitsy-creator-identity";

// Cache the debtor's re-OCR result keyed by the receipt's content hash, so a
// page reload doesn't re-run the (paid, slow) OCR. Content-addressed: a cache
// hit is provably the same image. localStorage may be unavailable (private mode)
// — treat any failure as a cache miss.
const OCR_CACHE_PREFIX = "splitsy-receipt-scan:";
function readCachedScan(receiptHash: string): number | null {
  try {
    const raw = window.localStorage.getItem(OCR_CACHE_PREFIX + receiptHash.toLowerCase());
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function writeCachedScan(receiptHash: string, scannedUsd: number): void {
  try {
    window.localStorage.setItem(OCR_CACHE_PREFIX + receiptHash.toLowerCase(), String(scannedUsd));
  } catch {
    // Full/unavailable storage — just skip caching.
  }
}

// Debtor-side audit: independently OCR a receipt's bytes and return its total in
// USD, so it can be compared to the on-chain total. Returns null when OCR or FX
// is unavailable (the caller then falls back to the human eyeball check). Reuses
// the same /api/ocr and /api/fx endpoints the creator used, so the extraction
// logic is identical — only the trust source differs (the debtor runs it).
async function scanReceiptTotalUsd(bytes: Uint8Array): Promise<number | null> {
  try {
    const form = new FormData();
    form.append("image", new Blob([bytes as BlobPart], { type: "image/jpeg" }), "receipt.jpg");
    const ocr = await fetch("/api/ocr", { method: "POST", body: form });
    if (!ocr.ok) return null;
    const { bill } = (await ocr.json()) as { bill?: { total?: number; currency?: string } };
    const total = Number(bill?.total);
    if (!Number.isFinite(total) || total <= 0) return null;

    const currency = (bill?.currency ?? "USD").toUpperCase();
    if (currency === "USD") return Number(total.toFixed(2));

    const fx = await fetch("/api/fx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: total, fromCurrency: currency }),
    });
    if (!fx.ok) return null;
    const quote = (await fx.json()) as { amountUsd?: number };
    return Number.isFinite(quote.amountUsd) ? Number(quote.amountUsd) : null;
  } catch {
    return null;
  }
}

export default function HomeClient({ testCycleEnabled = false }: { testCycleEnabled?: boolean }) {  const [activeTab, setActiveTab] = useState<AppTab>("bills");
  const { theme, setTheme } = useTheme();
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [error, setError] = useState("");
  const [imagePreview, setImagePreview] = useState("");
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
  const [splitMode, setSplitMode] = useState<"equal" | "manual">("equal");
  // Optional "pay by" date for the split, as a yyyy-mm-dd string from a <input
  // type=date> ("" = no due date). Committed into the on-chain metadata hash and
  // used to grade payment-reputation timeliness; absent leaves scoring unchanged.
  const [dueDateInput, setDueDateInput] = useState("");
  const [bridgeResults, setBridgeResults] = useState<Record<string, BridgeSummary>>({});
  const [bridgeSession, setBridgeSession] = useState<BrowserWalletSession | null>(null);
  const [recurringCycle, setRecurringCycle] = useState<RecurringCycle>("weekly");
  const [customCycleDays, setCustomCycleDays] = useState("30");
  const [billWallet, setBillWallet] = useState<BillSplitWallet | null>(null);
  const [billState, setBillState] = useState<BillRunState>("idle");
  const [billMessage, setBillMessage] = useState("");
  const [debtMessages, setDebtMessages] = useState<Record<string, { message: string; tone: "error" | "neutral" | "success" }>>({});
  const [progressFlow, setProgressFlow] = useState<ProgressFlow | null>(null);
  const [claimMessage, setClaimMessage] = useState("");
  const [claimMessageTone, setClaimMessageTone] = useState<"error" | "neutral" | "success">("neutral");
  const [submittedBillId, setSubmittedBillId] = useState<bigint | null>(null);
  const [debts, setDebts] = useState<OwnedBillSplitDebt[]>([]);
  const [splitterBills, setSplitterBills] = useState<OwnedBillSplitDebt[]>([]);
  const [arcUsdcBalance, setArcUsdcBalance] = useState<bigint | null>(null);
  // Per-identity-wallet balances (keyed by lowercase address), so a debt row
  // shows the balance of the wallet that will actually pay it.
  const [arcUsdcBalances, setArcUsdcBalances] = useState<Record<string, bigint>>({});
  const [arcUsdcBalanceFlash, setArcUsdcBalanceFlash] = useState(false);
  const [partialPayments, setPartialPayments] = useState<Record<string, string>>({});
  const [claimAmounts, setClaimAmounts] = useState<Record<string, string>>({});
  const [participantShareInputs, setParticipantShareInputs] = useState<Record<string, string>>({});
  // Off-chain (social) counts reported up by the self-fetching X panels, so the
  // merged pending window and the shared History panel can sum/gate across both
  // the social and on-chain debt systems.
  const [socialPendingCount, setSocialPendingCount] = useState(0);
  // Sum of the off-chain (social) debts, reported up by XDebtsPanel, so the
  // collapsed "Action needed" summary shows one $ total across both systems.
  const [socialPendingTotalUsd, setSocialPendingTotalUsd] = useState(0);
  const [socialHistoryCount, setSocialHistoryCount] = useState(0);
  // Whether the "Action needed" list is expanded. Null = auto: expanded for a
  // short list, collapsed once it gets long (a summary stands in). A tap pins
  // it, persisted across reloads.
  const [debtsExpanded, setDebtsExpanded] = usePersistedExpand("splitsy-expand-debts");
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
  const { switchChainAsync } = useSwitchChain();

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

  // On-chain debts still owed, and the merged pending count (social + wallet)
  // that the single "Action needed" window heading shows.
  const activeWalletDebts = registryReadAddress ? debts.filter((debt) => debt.remaining > 0n) : [];
  const pendingTotal = socialPendingCount + activeWalletDebts.length;
  // Combined $ owed across both systems, for the collapsed summary line.
  const walletPendingUnits = activeWalletDebts.reduce((sum, debt) => sum + debt.remaining, 0n);
  const pendingTotalUsd = socialPendingTotalUsd + Number(billUnitsToUsdc(walletPendingUnits));
  // Auto-collapse a long pending list; a tap on Expand/Collapse pins the choice.
  const debtsShown = debtsExpanded ?? pendingTotal <= 3;
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
  const originCurrency = fxQuote?.source ?? bill.currency;
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

    const response = await fetch("/api/ocr", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();

    if (!response.ok) {
      setOcrState("error");
      setError(payload.error ?? "Receipt scan failed.");
      return;
    }

    const parsed = normalizeParsedBill(payload.bill);
    setBill(parsed);
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

    await quoteFx(parsed.total, parsed.currency);
  }

  async function quoteFx(amount: number, currency: string) {
    setError("");
    const response = await fetch("/api/fx", {
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
    setBill((current) =>
      normalizeParsedBill({
        ...current,
        [field]: Number.isFinite(nextSourceValue) ? nextSourceValue : 0,
      }),
    );
    if (field === "total" && fxQuote) {
      setFxQuote({
        ...fxQuote,
        amountUsd: Number.isFinite(nextUsd) ? Number(nextUsd.toFixed(2)) : 0,
      });
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
    setParticipantShareInputs((current) => ({ ...current, [id]: value }));

    const nextAmount = Number(value);
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
      await switchChainAsync({ chainId: arcTestnet.id });
      const nextWalletClient = await getWalletClient(wagmiConfig, { chainId: arcTestnet.id });
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
    setBridgeResults({});
    setBillWallet(null);
    setRecurringWallet(null);
    setDebts([]);
    setSplitterBills([]);
    setArcUsdcBalances({});
    setPartialPayments({});
    setClaimAmounts({});
    setDebtMessages({});
    setClaimMessage("");
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
      setArcUsdcBalances(Object.fromEntries(perAccount.map(({ account: owner, balance }) => [owner.toLowerCase(), balance])));
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
        setArcUsdcBalances((current) => ({ ...current, [account.toLowerCase()]: next }));
        if (previousBalance === null || next !== previousBalance) {
          if (previousBalance !== null) {
            // Re-arm the animation: clear first so the class re-adds and replays.
            setArcUsdcBalanceFlash(false);
            window.requestAnimationFrame(() => setArcUsdcBalanceFlash(true));
            window.setTimeout(() => setArcUsdcBalanceFlash(false), 1000);
          }
          return;
        }
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
    const rows = displayParticipants.filter((p) => p.amountUsd > 0 && p.walletAddress.trim());
    if (rows.length === 0) {
      setBillState("error");
      setBillMessage("Add at least one participant with a positive share.");
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
      for (const [i, p] of rows.entries()) {
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
        setBillMessage(`Bill #${data.billId} is live on Arc from your Splitsy wallet. Tagged people will see it after signing in.`);
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
      });
      setSubmittedBillId(result.billId);
      setBillState("success");
      setBillMessage(`Bill #${result.billId.toString()} is live on Arc. Payers will see it when they connect.`);
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
          participantLabels: labels, receiptHash, dueDate,
          receiptImageBase64: publishedReceipt ? bytesToBase64(publishedReceipt.bytes) : undefined,
        }),
      }).catch(() => {});
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
    }
  }

  function beginPayFlow(billId: string, amountLabel: string) {
    setProgressFlow({
      kind: "pay",
      open: true,
      amountLabel,
      contextLabel: `bill #${billId}`,
      status: "running",
      errorMessage: "",
      steps: [
        { key: "switch", icon: "switch", label: "Connect to Arc Testnet", hint: "Approve the network switch in your wallet", state: "active" },
        { key: "approve", icon: "approve", label: "Approve USDC", hint: "Let the bill registry move your USDC", state: "pending" },
        { key: "pay", icon: "pay", label: "Send payment", hint: "Settle the debt on Arc with a memo", state: "pending" },
      ],
    });
  }

  // Server-side (Circle DCW) pay: one POST does approve + payDebt from the
  // user's Circle wallet, so the modal shows both steps but can only observe
  // the round-trip — completeFlow marks them done when the route returns.
  function beginSocialPayFlow(billId: string, amountLabel: string) {
    setProgressFlow({
      kind: "pay",
      open: true,
      amountLabel,
      contextLabel: `bill #${billId}`,
      status: "running",
      errorMessage: "",
      runningLabel: "Processing from your Circle wallet — this can take a moment",
      steps: [
        { key: "approve", icon: "approve", label: "Approve USDC", hint: "Your Circle wallet lets the bill registry move USDC", state: "active" },
        { key: "pay", icon: "pay", label: "Send payment", hint: "Settle the debt on Arc", state: "pending" },
      ],
    });
  }

  function beginClaimFlow(billId: string, amountLabel: string) {
    setProgressFlow({
      kind: "claim",
      open: true,
      amountLabel,
      contextLabel: `bill #${billId}`,
      status: "running",
      errorMessage: "",
      runningLabel: "Processing from your Circle wallet — this can take a moment",
      steps: [
        { key: "claim", icon: "claim", label: "Claim funds", hint: "Pull paid USDC from the registry to your wallet", state: "active" },
      ],
    });
  }

  function beginBridgeFlow(amountLabel: string, source: string) {
    setProgressFlow({
      kind: "bridge",
      open: true,
      amountLabel,
      contextLabel: `from ${source}`,
      status: "running",
      errorMessage: "",
      steps: [
        { key: "approve", icon: "approve", label: "Approve USDC", hint: `Allow CCTP to move USDC on ${source}`, state: "active" },
        { key: "bridge", icon: "bridge", label: "Bridge via CCTP", hint: "Burn on the source chain, then await Circle's attestation", state: "pending" },
        { key: "claim", icon: "claim", label: "Claim on Arc", hint: "Mint the bridged USDC on Arc Testnet", state: "pending" },
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
    fireSuccessConfetti();
  }

  function failFlow(message: string) {
    setProgressFlow((current) =>
      current
        ? {
            ...current,
            status: "error",
            errorMessage: message,
            steps: current.steps.map((step) => (step.state === "active" ? { ...step, state: "error" } : step)),
          }
        : current,
    );
  }

  function closeFlow() {
    setProgressFlow((current) => (current ? { ...current, open: false } : current));
  }

  async function payDebtOnArc(debt: OwnedBillSplitDebt) {
    const debtKey = debt.billId.toString();

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
      beginSocialPayFlow(debtKey, amountLabel);
      try {
        setBillState("working");
        setDebtMessages((current) => {
          const next = { ...current };
          delete next[debtKey];
          return next;
        });
        const res = await fetch(`/api/onchain-bills/${debtKey}/pay`, { method: "POST" });
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
          [debtKey]: { tone: "success", message: `Paid bill #${debtKey} from your wallet.` },
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
    beginPayFlow(debtKey, amountLabel);

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
        [debtKey]: { tone: "success", message: `Paid ${amountLabel} USDC toward bill #${debtKey}.` },
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

  async function bridgeForDebt(debt: BillSplitDebt, debtSourceChain: BridgeSourceChain) {
    const session = bridgeSession ?? (await connectForBridge());
    const debtKey = debt.billId.toString();

    if (!session || !billWallet) {
      setBillState("error");
      setDebtMessages((current) => ({
        ...current,
        [debtKey]: { tone: "error", message: "Connect your wallet first so bridged USDC can arrive at your Arc address." },
      }));
      return;
    }

    const amount = usdcToBillUnits(partialPayments[debt.billId.toString()] ?? billUnitsToUsdc(debt.remaining));

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
    beginBridgeFlow(amountLabel, source);

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
      setBridgeResults((current) => ({ ...current, [debtKey]: result }));

      if (result.state === "error") {
        failFlow("The bridge did not complete. No funds were claimed on Arc.");
        setBillState("error");
        setDebtMessages((current) => ({
          ...current,
          [debtKey]: { tone: "error", message: "Bridge failed." },
        }));
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
    beginBridgeFlow(amountLabel, source);

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
        failFlow("The bridge did not complete. No funds were claimed on Arc.");
        setRecurringState("error");
        setRecurringMessage("Bridge failed.");
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
    const debtKey = debt.billId.toString();

    // Bill split by the user's Circle (DCW) wallet — only that wallet can claim,
    // so the server claims it, gated by the same PIN unlock. The route reads the
    // claimable amount from chain and always claims all of it, so no amount is
    // sent (partial claims aren't supported for Circle wallets).
    if (debt.via === "social" && me?.walletAddress) {
      const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
      if (!pin.unlocked) {
        setClaimMessageTone("neutral");
        setClaimMessage("Unlock your wallet (the wallet button in the bottom-right corner), then tap Claim again.");
        return;
      }
      beginClaimFlow(debtKey, billUnitsToUsdc(debt.claimable));
      try {
        setBillState("working");
        setClaimMessageTone("neutral");
        setClaimMessage("Claiming paid funds.");
        const res = await fetch(`/api/onchain-bills/${debtKey}/claim`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBillState("error");
          failFlow(data.error ?? "Claim failed.");
          setClaimMessageTone("error");
          setClaimMessage(data.error ?? "Claim failed.");
          return;
        }
        completeFlow();
        setBillState("success");
        setClaimMessageTone("success");
        setClaimMessage(`Claimed funds from bill #${debtKey} to your wallet.`);
        await refreshBillRegistry();
      } catch (caught) {
        setBillState("error");
        failFlow(errorMessage(caught));
        setClaimMessageTone("error");
        setClaimMessage(errorMessage(caught));
      }
      return;
    }

    const wallet = billWallet ?? (await connectBillWallet());

    if (!wallet) {
      return;
    }

    const amount = usdcToBillUnits(claimAmounts[debt.billId.toString()] ?? billUnitsToUsdc(debt.claimable));

    if (amount <= 0n || amount > debt.claimable) {
      setBillState("error");
      setClaimMessageTone("error");
      setClaimMessage("Enter an amount up to the claimable balance.");
      return;
    }

    try {
      setBillState("working");
      setClaimMessageTone("neutral");
      setClaimMessage("Claiming paid funds.");
      await claimBillFunds({ ...wallet, billId: debt.billId, amount });
      setBillState("success");
      setClaimMessageTone("success");
      setClaimMessage(`Claimed ${billUnitsToUsdc(amount)} USDC from bill #${debt.billId.toString()}.`);
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      setClaimMessageTone("error");
      setClaimMessage(errorMessage(caught));
    }
  }

  function showBillPreview(file: File | null) {
    if (!file) {
      setImagePreview("");
      return;
    }

    setImagePreview(URL.createObjectURL(file));
  }

  function updatePreview(event: ChangeEvent<HTMLInputElement>) {
    showBillPreview(event.target.files?.[0] ?? null);
  }

  // Testing convenience: load the bundled /bill.jpg sample into the upload box
  // exactly as if the user picked it, so "Scan receipt" works unchanged.
  async function useSampleBill() {
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

  return (
    <main className="app-shell min-h-screen text-[var(--text)]">
      <header className="static z-30 border-b border-[var(--border)] bg-[color:var(--header-bg)] backdrop-blur-xl">
        <div className="mx-auto max-w-[88rem] px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0 shrink">
              <Link aria-label="Splitsy home" className="brand-lockup" href="/">
                <span className="logo-crop logo-crop-app">
                  <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
                </span>
              </Link>
              <div className="header-title-row mt-1">
                <h1 className="app-title">
                  Split bills, Settle cleanly
                </h1>
                <span className="network-stamp">Arc Testnet</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 md:justify-end lg:flex-nowrap">
              <div className="segmented-control">
                <TabButton active={activeTab === "bills"} onClick={() => switchAppTab("bills")}>
                  Bills
                </TabButton>
                <TabButton active={activeTab === "recurring"} onClick={() => switchAppTab("recurring")}>
                  Recurring
                </TabButton>
                <TabButton active={activeTab === "history"} onClick={() => switchAppTab("history")}>
                  History
                </TabButton>
                <TabButton active={activeTab === "dashboard"} onClick={() => switchAppTab("dashboard")}>
                  Dashboard
                </TabButton>
                <Link className="tab-button" href="/docs">
                  <BookOpen size={16} />
                  Docs
                </Link>
              </div>
              <div className="flex flex-nowrap items-center gap-2">
                <SignInMenu />
                <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
                <button
                  aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                  className="icon-button shrink-0"
                  onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
                  type="button"
                >
                  {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <AnimatePresence mode="wait">
        {activeTab === "bills" ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="space-y-5"
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            key="bills"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {/* One merged "Action needed" window. The wrapper stays mounted even
                when nothing is pending (no chrome) so XDebtsPanel keeps fetching
                and can report its social count up for the summed heading. */}
            <div className={pendingTotal > 0 ? "debt-alert p-4" : undefined}>
              {pendingTotal > 0 ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-[var(--accent)]">Action needed</p>
                    <h3 className="mt-1 text-[clamp(1.35rem,3vw,2.2rem)] font-semibold leading-tight">
                      You have {pendingTotal} unpaid bill{pendingTotal === 1 ? "" : "s"}
                    </h3>
                    <p className="mt-2 text-sm text-[var(--text-muted)]">
                      {debtsShown
                        ? "Tagged to your handle or registered to your wallet. Settle each from the matching account."
                        : `Total $${pendingTotalUsd.toFixed(2)} owed. Expand to settle each from the matching account.`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Collapse once the list gets long (>3), so many unpaid bills
                        don't stretch the page; a tap pins the choice. */}
                    {pendingTotal > 3 ? (
                      <button className="secondary-button" onClick={() => setDebtsExpanded(!debtsShown)} type="button">
                        <ChevronDown className={`transition-transform ${debtsShown ? "rotate-180" : ""}`} size={16} />
                        {debtsShown ? "Collapse" : "Expand"}
                      </button>
                    ) : null}
                    {registryReadAddress ? (
                      <button className="secondary-button" onClick={() => refreshBillRegistry()} type="button">
                        <RefreshCw size={16} />
                        Refresh
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className={`${pendingTotal > 0 ? "mt-4 space-y-3" : ""}${debtsShown ? "" : " hidden"}`}>
                <XDebtsPanel onCount={setSocialPendingCount} onTotal={setSocialPendingTotalUsd} />
                {registryReadAddress ? (
                  <WalletDebtRows
                    activeDebts={activeWalletDebts}
                    arcUsdcBalances={arcUsdcBalances}
                    arcUsdcBalanceFlash={arcUsdcBalanceFlash}
                    bridgeForDebt={bridgeForDebt}
                    bridgeResults={bridgeResults}
                    billState={billState}
                    partialPayments={partialPayments}
                    payDebtOnArc={payDebtOnArc}
                    debtMessages={debtMessages}
                    setPartialPayments={setPartialPayments}
                  />
                ) : null}
              </div>
            </div>
            {registryReadAddress ? (
              <ClaimFundsPanel
                splitterBills={splitterBills}
                billState={billState}
                claimAmounts={claimAmounts}
                claimMessage={claimMessage}
                claimMessageTone={claimMessageTone}
                claimSplitterFunds={claimSplitterFunds}
                setClaimAmounts={setClaimAmounts}
              />
            ) : null}

            <div className="space-y-5">
              {/* After a successful submit the split form resets (unmounting the
                  panel that shows billMessage), so surface the "Bill #N is live"
                  confirmation here until a new bill is started. */}
              {billState === "success" && billMessage && !billReadyForSplit ? (
                <Message tone="success">{billMessage}</Message>
              ) : null}
              <Panel title="Upload bill" icon={<Upload size={19} />}>
                <form className="space-y-4" onSubmit={parseBill}>
                  <label
                    className={`scan-surface upload-focus flex min-h-[28rem] cursor-pointer flex-col items-center justify-center rounded-[var(--radius)] border border-dashed bg-[var(--receipt)] p-6 text-center text-[var(--receipt-text)] transition hover:border-[var(--accent)] sm:min-h-[34rem] ${
                      isDraggingBill ? "border-[var(--accent)]" : "border-[var(--border-strong)]"
                    }`}
                    data-scanning={ocrState === "reading"}
                    onDragLeave={handleBillDragLeave}
                    onDragOver={handleBillDragOver}
                    onDrop={handleBillDrop}
                  >
                    {imagePreview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt="Bill preview"
                        className="max-h-80 rounded-md object-contain shadow-sm"
                        src={imagePreview}
                      />
                    ) : (
                      <>
                        <Camera className="text-[var(--accent)]" size={44} />
                        <p className="mt-4 text-xl font-semibold">Upload the bill</p>
                        <p className="mt-1 text-sm text-[var(--receipt-muted)]">Click to browse or drag &amp; drop an image</p>
                        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--receipt-muted)]">
                          Use a local receipt or bill photo in any language. Splitsy reads totals, tax, tip, and line items so the split starts clean.
                        </p>
                        <p className="mt-4 text-sm text-[var(--receipt-muted)]">
                          Don&apos;t have a receipt image right now?{" "}
                          {/* A <span>, not a <button>: buttons are labelable, so the
                              surrounding upload <label> would adopt it as its control
                              and every click on the box would trigger it. */}
                          <span
                            className="cursor-pointer font-semibold text-[var(--accent)] underline underline-offset-2 hover:opacity-80"
                            onClick={(event) => {
                              // Inside the upload <label>: stop the click from also
                              // opening the file picker.
                              event.preventDefault();
                              event.stopPropagation();
                              void useSampleBill();
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                void useSampleBill();
                              }
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            Use this
                          </span>
                        </p>
                      </>
                    )}
                    <input accept="image/*" className="sr-only" name="image" onChange={updatePreview} ref={imageInputRef} type="file" />
                  </label>

                  {error ? <Message tone="error">{error}</Message> : null}

                  <button className="primary-button scan-receipt-button w-full" disabled={ocrState === "reading"}>
                    {ocrState === "reading" ? <Loader2 className="animate-spin" size={18} /> : <FileJson size={18} />}
                    {ocrState === "reading" ? "Reading receipt" : "Scan receipt"}
                  </button>
                  <button
                    className="manual-entry-link"
                    onClick={() => {
                      setManualBillEntry(true);
                      setReceiptCommit(null);
                      setError("");
                    }}
                    type="button"
                  >
                    Or enter manually
                  </button>
                </form>
              </Panel>

              <AnimatePresence>
                {showBillEditor ? (
                  <motion.div
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 12, scale: 0.985 }}
                    initial={{ opacity: 0, y: 16, scale: 0.985 }}
                    ref={reviewBillRef}
                    transition={{ duration: 0.26, ease: "easeOut" }}
                  >
                    <Panel title="Review bill" icon={<ReceiptText size={19} />}>
                      <div className="receipt-card p-4 sm:p-5" ref={receiptPrintRef}>
                        {billIsScanned ? (
                          <>
                            <div className="mb-4 rounded-[var(--radius)] border border-[var(--receipt-border-soft)] bg-[var(--receipt-overlay)] p-3 text-xs text-[var(--receipt-muted)]">
                              <p className="font-semibold text-[var(--receipt-text)]">Converted to USD for settlement</p>
                              <p className="mt-1">
                                Origin currency {originCurrency}. Rate{" "}
                                <span className="amount-text">1 {originCurrency} = {usdRate.toFixed(6)} USD</span>
                                {fxQuote?.asOf ? ` · ${new Date(fxQuote.asOf).toLocaleString()}` : ""}
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <Field label="Merchant" value={bill.merchant} onChange={(value) => updateBillField("merchant", value)} />
                              <Field label="Origin currency" value={bill.currency} onChange={(value) => updateBillField("currency", value)} />
                              <Field label="Subtotal USD" type="number" value={toUsdInput(bill.subtotal, usdRate)} onChange={(value) => updateBillUsdField("subtotal", value)} />
                              <Field label="Tax USD" type="number" value={toUsdInput(bill.tax, usdRate)} onChange={(value) => updateBillUsdField("tax", value)} />
                              <Field label="Tip USD" type="number" value={toUsdInput(bill.tip, usdRate)} onChange={(value) => updateBillUsdField("tip", value)} />
                              <Field label="Total USD" type="number" value={toUsdInput(bill.total, usdRate)} onChange={(value) => updateBillUsdField("total", value)} />
                            </div>
                          </>
                        ) : (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="Merchant" value={bill.merchant} onChange={(value) => updateBillField("merchant", value)} />
                            <Field label="Total USD" type="number" value={String(bill.total)} onChange={(value) => updateBillField("total", value)} />
                          </div>
                        )}

                        {billIsScanned && bill.lineItems.length > 0 ? (
                          <details className="bill-items-disclosure mt-5">
                            <summary>
                              <span>
                                <span className="block text-sm font-semibold text-[var(--receipt-text)]">Bill items</span>
                                <span className="mt-0.5 block text-xs text-[var(--receipt-muted)]">
                                  {bill.lineItems.length} extracted item{bill.lineItems.length === 1 ? "" : "s"}
                                </span>
                              </span>
                              <span className="bill-items-summary-total">
                                <span className="amount-text">
                                  ${bill.lineItems.reduce((sum, item) => sum + item.amount * usdRate, 0).toFixed(2)}
                                </span>
                                <ChevronDown className="bill-items-chevron" size={18} />
                              </span>
                            </summary>
                            <div className="bill-items-body">
                              {bill.lineItems.map((item, index) => (
                                <div className="receipt-row" data-receipt-row key={`${item.description}-${index}`}>
                                  <span className="receipt-index">{String(index + 1).padStart(2, "0")}</span>
                                  <span className="min-w-0 text-sm font-medium">{item.description}</span>
                                  <span className="amount-text text-sm font-semibold">${(item.amount * usdRate).toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </Panel>
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
                    <Panel
                      title="Review your split"
                      icon={<WalletCards size={19} />}
                      action={
                        <div className="segmented-control">
                          <ModeButton active={splitMode === "equal"} onClick={() => setSplitMode("equal")}>
                            Equal
                          </ModeButton>
                          <ModeButton active={splitMode === "manual"} onClick={() => setSplitMode("manual")}>
                            Manual
                          </ModeButton>
                        </div>
                      }
                    >
                <div className="route-strip text-sm">
                  <div>
                    <p className="font-semibold text-[var(--text)]">Bill registry (escrow)</p>
                    <p className="mt-1 text-[var(--text-muted)]">
                      Tag each payer by wallet address, X, Discord, or email. Written to the on-chain escrow — tagged
                      people get a wallet and can pay + be claimed on Arc.
                    </p>
                  </div>
                  <div className="route-line" aria-hidden="true" />
                  <div>
                    <p className="font-semibold text-[var(--text)]">Arc Testnet</p>
                    <p className="mt-1 text-[var(--text-muted)]">Fees settle in USDC with transaction memos.</p>
                  </div>
                </div>

                {billMessage ? (
                  <div className="mt-4">
                    <Message tone={billState === "error" ? "error" : billState === "success" ? "success" : "neutral"}>{billMessage}</Message>
                  </div>
                ) : null}

                <div className="receipt-card mt-4 p-4">
                  {displayParticipants.map((participant) => {
                    return (
                      <div className="receipt-divider py-3 first:border-t-0 first:pt-0" key={participant.id}>
                        <div className="grid gap-3 md:grid-cols-[0.48fr_1fr_0.32fr_auto] md:items-end">
                          <Field
                            label="Name"
                            value={participant.label}
                            onChange={(value) => updateParticipant(participant.id, "label", value)}
                          />
                          <HandleField
                            provider={participant.provider ?? "x"}
                            onProviderChange={(value) => updateParticipant(participant.id, "provider", value)}
                            value={participant.walletAddress}
                            onChange={(value) => updateParticipant(participant.id, "walletAddress", value)}
                          />
                          <Field
                            disabled={splitMode === "equal"}
                            label="Share"
                            type="number"
                            value={
                              splitMode === "manual"
                                ? (participantShareInputs[participant.id] ?? (participant.amountUsd > 0 ? String(participant.amountUsd) : ""))
                                : participant.amountUsd.toFixed(2)
                            }
                            onChange={(value) => updateParticipantShare(participant.id, value)}
                          />
                          <button
                            aria-label={`Remove ${participant.label}`}
                            className="icon-button"
                            onClick={() => removeParticipant(participant.id)}
                            type="button"
                          >
                            <Trash2 size={17} />
                          </button>
                        </div>

                        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <ReputationBadge provider={rowProvider(participant)} value={participant.walletAddress} />
                          <span className="amount-text font-semibold">${participant.amountUsd.toFixed(2)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Optional pay-by date. Committed into the on-chain metadata
                    hash so payment reputation can grade timeliness against a
                    deadline the creator can't move after the fact. Leaving it
                    blank keeps the bill (and every payer's score) exactly as it
                    was before due dates existed. */}
                <div className="mt-4 flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <label className="font-semibold text-[var(--text)]" htmlFor="bill-due-date">
                      Pay by <span className="font-normal text-[var(--text-muted)]">(optional)</span>
                    </label>
                    <p className="mt-1 text-[var(--text-muted)]">
                      Payers who settle on time build stronger on-chain payment reputation. Leave blank for no deadline.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className="input-field w-auto"
                      id="bill-due-date"
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(event) => setDueDateInput(event.target.value)}
                      type="date"
                      value={dueDateInput}
                    />
                    {dueDateInput ? (
                      <button
                        className="secondary-button"
                        onClick={() => setDueDateInput("")}
                        type="button"
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Dual identity (signed in social + connected wallet): the
                    creator picks which wallet writes the bill to Arc and
                    collects the payments. With one identity there is no
                    ambiguity and no picker. */}
                {canChooseCreator && socialWalletAddress && connectedWalletAccount ? (
                  <div className="mt-4 flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-semibold text-[var(--text)]">Create as</p>
                      <p className="mt-1 text-[var(--text-muted)]">
                        {creatorIdentity === "social"
                          ? `Your Splitsy wallet ${shortAddress(socialWalletAddress)} writes the bill and collects the payments — no signing needed.`
                          : `Your connected wallet ${shortAddress(connectedWalletAccount)} signs the bill and collects the payments. Payers see this address as the bill's creator.`}
                      </p>
                    </div>
                    <div className="segmented-control shrink-0">
                      <ModeButton active={creatorIdentity === "social"} onClick={() => chooseCreatorIdentity("social")}>
                        {socialCreatorLabel}
                      </ModeButton>
                      <ModeButton active={creatorIdentity === "wallet"} onClick={() => chooseCreatorIdentity("wallet")}>
                        {shortAddress(connectedWalletAccount)}
                      </ModeButton>
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-2">
                    <button className="secondary-button" onClick={addParticipant} type="button">
                      <Plus size={16} />
                      Add payer
                    </button>
                    <button
                      className="primary-button"
                      disabled={billState === "working" || billState === "connecting"}
                      onClick={submitBillOnchainMixed}
                      type="button"
                    >
                      {billState === "working" ? <Loader2 className="animate-spin" size={16} /> : <Landmark size={16} />}
                      Write on Arc
                    </button>
                  </div>
                  <div className="text-sm text-[var(--text-muted)]">
                    Split total <span className="amount-text font-semibold text-[var(--text)]">${splitTotal.toFixed(2)}</span>
                    {Math.abs(splitDelta) > 0.009 ? (
                      <span className="ml-2 text-[var(--warning-text)]">delta ${splitDelta.toFixed(2)}</span>
                    ) : null}
                  </div>
                </div>
                {submittedBillId ? (
                  <div className="mt-4 flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between">
                    <span>Bill #{submittedBillId.toString()} is live. Payers see it when they connect the matching wallet.</span>
                    <div className="settlement-stamp" ref={settlementStampRef}>
                      Settled
                    </div>
                  </div>
                ) : null}
                    </Panel>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : activeTab === "recurring" ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            key="recurring"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
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
        ) : activeTab === "history" ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            key="history"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <Panel title="History" icon={<BadgeDollarSign size={19} />}>
              <div className="space-y-6">
                <XHistoryPanel onCount={setSocialHistoryCount} />
                <HistoryWorkspace debts={debts} splitterBills={splitterBills} />
                {socialHistoryCount === 0 && walletHistoryEmpty ? (
                  <p className="text-sm text-[var(--text-muted)]">
                    No bill history yet. Bills you split, settle, or claim — on-chain or tagged by handle — appear here as records.
                  </p>
                ) : null}
              </div>
            </Panel>
          </motion.div>
        ) : (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            key="dashboard"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <DashboardPanel socialWallet={socialWalletAddress} browserWallet={connectedWalletAccount} />
          </motion.div>
        )}
        </AnimatePresence>
      </section>

      {progressFlow ? <ProgressModal flow={progressFlow} onClose={closeFlow} /> : null}
      <XAuthControl />
    </main>
  );
}

// The on-chain payable-debt rows, rendered headerless inside the shared
// "Action needed" window (whose heading/refresh live in the bills tab). The
// off-chain XDebtsPanel rows render as siblings above these.
function WalletDebtRows({
  bridgeForDebt,
  bridgeResults,
  billState,
  arcUsdcBalances,
  arcUsdcBalanceFlash,
  activeDebts,
  debtMessages,
  partialPayments,
  payDebtOnArc,
  setPartialPayments,
}: {
  bridgeForDebt: (debt: BillSplitDebt, debtSourceChain: BridgeSourceChain) => void;
  bridgeResults: Record<string, BridgeSummary>;
  billState: BillRunState;
  // Balance per identity wallet (lowercase address key), so each row shows the
  // balance of the wallet that will actually pay it.
  arcUsdcBalances: Record<string, bigint>;
  arcUsdcBalanceFlash: boolean;
  activeDebts: OwnedBillSplitDebt[];
  debtMessages: Record<string, { message: string; tone: "error" | "neutral" | "success" }>;
  partialPayments: Record<string, string>;
  payDebtOnArc: (debt: OwnedBillSplitDebt) => void;
  setPartialPayments: (value: Record<string, string>) => void;
}) {
  const [fallbackBridgeChains, setFallbackBridgeChains] = useState<Record<string, BridgeSourceChain>>({});
  // Which debt cards are expanded. A long list of payable bills otherwise makes
  // the page huge; collapsed by default (a lone bill auto-expands below).
  const [expandedDebts, setExpandedDebts] = useState<Record<string, boolean>>({});
  // ponytail: dropped the auto-scroll-to-debt effect — the merged window now
  // owns placement and social rows sit above; re-add a ref on the shared window
  // if jump-to-pending is wanted again.

  return (
    <>
            {activeDebts.map((debt) => {
              const key = debt.billId.toString();
              const bridgeResult = bridgeResults[key];
              const debtMessage = debtMessages[key];
              // Debt owed by the user's Circle (DCW) wallet: it lives only on
              // Arc Testnet, so the CCTP bridge path is irrelevant, and the
              // server pay route always settles the full remaining debt — no
              // partial-amount input.
              const socialWallet = debt.via === "social";
              const rowBalance = arcUsdcBalances[debt.account.toLowerCase()] ?? null;
              // A lone bill is always expanded; otherwise collapsed until opened.
              const expanded = expandedDebts[key] ?? activeDebts.length === 1;

              return (
                <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] p-3" key={`${key}:${debt.account}`}>
                  <button
                    className="flex w-full items-start justify-between gap-2 text-left"
                    onClick={() => setExpandedDebts((prev) => ({ ...prev, [key]: !expanded }))}
                    type="button"
                  >
                    <div>
                      <p className="flex items-center gap-1.5 font-semibold">
                        <ChevronDown className={`transition-transform ${expanded ? "rotate-180" : ""}`} size={15} />
                        Bill #{key}
                      </p>
                      <p className="mt-1 text-sm text-[var(--text-muted)]">
                        Owed <span className="amount-text">${billUnitsToUsdc(debt.owed)}</span> · paid{" "}
                        <span className="amount-text">${billUnitsToUsdc(debt.paid)}</span>
                      </p>
                      {expanded ? (
                        <p className="mt-1 break-all text-xs text-[var(--text-muted)]">Splitter {debt.splitter}</p>
                      ) : null}
                    </div>
                    <Metric label="Remaining" value={`$${billUnitsToUsdc(debt.remaining)}`} />
                  </button>

                  {!expanded ? null : (
                  <>
                  <BillVerification billId={debt.billId} metadataHash={debt.metadataHash} />

                  {!socialWallet ? (
                  <div className="mt-3">
                    <Field
                      label="Payment amount"
                      type="number"
                      value={partialPayments[key] ?? billUnitsToUsdc(debt.remaining)}
                      onChange={(value) => setPartialPayments({ ...partialPayments, [key]: value })}
                    />
                  </div>
                  ) : null}

                  {debtMessage ? (
                    <div className="mt-3">
                      <Message tone={debtMessage.tone}>{debtMessage.message}</Message>
                    </div>
                  ) : null}

                  {!socialWallet ? (
                  <div className="route-strip mt-3 text-sm">
                    <div>
                      <p className="font-semibold text-[var(--text)]">Pay directly on Arc</p>
                      <p className="mt-1 text-[var(--text-muted)]">One Arc memo payment when your USDC is already on Arc.</p>
                    </div>
                    <div className="route-line" aria-hidden="true" />
                    <div>
                      <p className="font-semibold text-[var(--text)]">Bridge first from another chain</p>
                      <p className="mt-1 text-[var(--text-muted)]">CCTP V2 brings USDC to Arc, then you pay on Arc.</p>
                    </div>
                  </div>
                  ) : null}

                  <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-semibold text-[var(--text)]">Pay on Arc</p>
                        <p className="mt-1 text-[var(--text-muted)]">
                          {socialWallet
                            ? "Settles the remaining debt from your Circle wallet on Arc Testnet."
                            : "Use this after your USDC is already on Arc Testnet."}
                        </p>
                      </div>
                      <div className="flex flex-col items-stretch gap-1 sm:items-end">
                        <button
                          className="chain-button chain-button-active sm:min-w-44"
                          disabled={billState === "working"}
                          onClick={() => payDebtOnArc(debt)}
                          type="button"
                        >
                          {billState === "working" ? (
                            <span className="inline-flex items-center gap-2">
                              <Loader2 className="animate-spin" size={15} />
                              Processing…
                            </span>
                          ) : (
                            "Pay on Arc Testnet"
                          )}
                        </button>
                        <p className="text-xs text-[var(--text-muted)] sm:text-right">
                          Balance:{" "}
                          <span className={`amount-text${arcUsdcBalanceFlash ? " balance-flash" : ""}`}>
                            ${rowBalance === null ? "—" : billUnitsToUsdc(rowBalance)}
                          </span>{" "}
                          USDC on Arc Testnet
                        </p>
                      </div>
                    </div>

                    {!socialWallet ? (
                    <div className="mt-4 border-t border-[var(--border)] pt-4">
                      <p className="font-semibold text-[var(--text)]">Bridge USDC to Arc first</p>
                      <p className="mt-1 text-[var(--text-muted)]">
                        Bridging from another chain takes 3 transactions: approve USDC, bridge with CCTP V2, then claim the bridged USDC on Arc Testnet.
                        After that, pay the debt on Arc.
                      </p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {bridgeSourceChains.map((chain) => (
                        <button
                          className={`chain-button ${fallbackBridgeChains[key] === chain.id ? "chain-button-active" : ""}`}
                          disabled={billState === "working"}
                          key={chain.id}
                          onClick={() => {
                            setFallbackBridgeChains({ ...fallbackBridgeChains, [key]: chain.id });
                            bridgeForDebt(debt, chain.id);
                          }}
                          type="button"
                        >
                          Bridge from {chain.label}
                        </button>
                      ))}
                      </div>
                    </div>
                    ) : null}
                  </div>

                  {bridgeResult?.explorerUrls.length ? (
                    <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface-muted)] p-3 text-sm">
                      <p className="font-semibold">Testnet explorer</p>
                      <div className="mt-2 space-y-1">
                        {bridgeResult.explorerUrls.map((url) => (
                          <a className="flex items-center gap-2 break-all text-[var(--accent)] underline" href={url} key={url}>
                            <ExternalLink size={14} />
                            {url}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  </>
                  )}
                </div>
              );
            })}
    </>
  );
}

// Creditor POV: claim paid USDC out of the registry. Own panel below the shared
// pending window (was the second half of the old DebtWorkspace).
function ClaimFundsPanel({
  splitterBills,
  billState,
  claimAmounts,
  claimMessage,
  claimMessageTone,
  claimSplitterFunds,
  setClaimAmounts,
}: {
  splitterBills: OwnedBillSplitDebt[];
  billState: BillRunState;
  claimAmounts: Record<string, string>;
  claimMessage: string;
  claimMessageTone: "error" | "neutral" | "success";
  claimSplitterFunds: (debt: OwnedBillSplitDebt) => void;
  setClaimAmounts: (value: Record<string, string>) => void;
}) {
  const claimableBills = splitterBills.filter((debt) => debt.claimable > 0n);
  const claimRef = useRef<HTMLDivElement | null>(null);
  // Collapse a long claimable list (>3) behind a summary; a tap pins the choice
  // (persisted across reloads).
  const [expanded, setExpanded] = usePersistedExpand("splitsy-expand-claims");
  const shown = expanded ?? claimableBills.length <= 3;
  const claimableTotalUnits = claimableBills.reduce((sum, debt) => sum + debt.claimable, 0n);

  useEffect(() => {
    if (claimableBills.length === 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      claimRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [claimableBills.length]);

  if (claimableBills.length === 0) {
    return null;
  }

  return (
    <div ref={claimRef}>
      <Panel
        title="Claim funds"
        icon={<BadgeDollarSign size={19} />}
        action={
          claimableBills.length > 3 ? (
            <button className="secondary-button" onClick={() => setExpanded(!shown)} type="button">
              <ChevronDown className={`transition-transform ${shown ? "rotate-180" : ""}`} size={16} />
              {shown ? "Collapse" : "Expand"}
            </button>
          ) : null
        }
      >
        {claimMessage ? (
          <div className="mb-4">
            <Message tone={claimMessageTone}>{claimMessage}</Message>
          </div>
        ) : null}
        {!shown ? (
          <p className="text-sm text-[var(--text-muted)]">
            {claimableBills.length} bills ready to claim, total{" "}
            <span className="amount-text">${billUnitsToUsdc(claimableTotalUnits)}</span>.
          </p>
        ) : (
        <div className="space-y-3">
          {claimableBills.map((debt) => {
            const key = debt.billId.toString();
            // Bill split by the user's Circle (DCW) wallet: the server claim
            // route always claims the full claimable balance, so the
            // partial-amount input is hidden.
            const socialWallet = debt.via === "social";
            return (
              <div className={`relative grid gap-3 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] p-3 sm:items-end ${socialWallet ? "sm:grid-cols-[1fr_auto]" : "sm:grid-cols-[1fr_0.4fr_auto]"}`} key={`${key}:${debt.account}`}>
                <div>
                  <p className="font-semibold">Bill #{key}</p>
                  <p className="mt-1 text-sm text-[var(--text-muted)]">
                    Paid <span className="amount-text">${billUnitsToUsdc(debt.totalPaid)}</span> · claimed{" "}
                    <span className="amount-text">${billUnitsToUsdc(debt.claimed)}</span>
                  </p>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    {socialWallet
                      ? `Claim pulls the full $${billUnitsToUsdc(debt.claimable)} paid USDC from the registry to your wallet.`
                      : "Claim pulls paid USDC from the registry to your Arc wallet."}
                  </p>
                </div>
                {!socialWallet ? (
                <Field
                  label="Claim"
                  type="number"
                  value={claimAmounts[key] ?? billUnitsToUsdc(debt.claimable)}
                  onChange={(value) => setClaimAmounts({ ...claimAmounts, [key]: value })}
                />
                ) : null}
                <button
                  className="primary-button h-11"
                  disabled={billState === "working"}
                  onClick={() => claimSplitterFunds(debt)}
                  type="button"
                >
                  {billState === "working" ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="animate-spin" size={15} />
                      Processing…
                    </span>
                  ) : (
                    "Claim on Arc"
                  )}
                </button>
              </div>
            );
          })}
        </div>
        )}
      </Panel>
    </div>
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

  // Headerless wallet history sections; the shared History Panel + empty state
  // live in the history tab so social and wallet records sit under one card.
  return (
    <>
            {pendingBills.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-[var(--text-muted)]">
                  Pending bill{pendingBills.length === 1 ? "" : "s"} — awaiting payment from debtors
                </p>
                <div className="space-y-2">
                  {pendingBills.map((debt) => {
                    const remaining = debt.totalOwed - debt.totalPaid;

                    return (
                      <HistoryRecordCard
                        debt={debt}
                        key={`${debt.billId.toString()}:${debt.account}`}
                        badge={<span className="status-dot status-warn">Pending</span>}
                        summary={
                          <>
                            Paid <span className="amount-text">${billUnitsToUsdc(debt.totalPaid)}</span> of{" "}
                            <span className="amount-text">${billUnitsToUsdc(debt.totalOwed)}</span> ·{" "}
                            <span className="amount-text">${billUnitsToUsdc(remaining)}</span> outstanding
                          </>
                        }
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}

            {paidDebts.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-[var(--text-muted)]">
                  Paid bill{paidDebts.length === 1 ? "" : "s"} — your settled records
                </p>
                <div className="space-y-2">
                  {paidDebts.map((debt) => (
                    <HistoryRecordCard
                      debt={debt}
                      key={`${debt.billId.toString()}:${debt.account}`}
                      badge={<PaidBillStamp compact />}
                      summary={
                        <>
                          Paid <span className="amount-text">${billUnitsToUsdc(debt.paid)}</span> of{" "}
                          <span className="amount-text">${billUnitsToUsdc(debt.owed)}</span>
                        </>
                      }
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {claimedBills.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-[var(--text-muted)]">
                  Claimed bill{claimedBills.length === 1 ? "" : "s"} — your collected records
                </p>
                <div className="space-y-2">
                  {claimedBills.map((debt) => (
                    <HistoryRecordCard
                      debt={debt}
                      key={`${debt.billId.toString()}:${debt.account}`}
                      badge={<PaidBillStamp compact alt="Claimed" src="/claimed.png" width={652} height={512} />}
                      summary={
                        <>
                          Claimed <span className="amount-text">${billUnitsToUsdc(debt.claimed)}</span> of{" "}
                          <span className="amount-text">${billUnitsToUsdc(debt.totalPaid)}</span> paid
                        </>
                      }
                    />
                  ))}
                </div>
              </div>
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
            <p className="text-sm text-[var(--text-muted)]">Loading on-chain activity…</p>
          ) : activity.status === "error" ? (
            <Message tone="error">Could not load on-chain activity. Try again shortly.</Message>
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
                    <p className="mt-1 text-[var(--text-muted)]">—</p>
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
                    <span className="text-[var(--text-muted)]">—</span>
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
                          <span className="text-[var(--text-muted)]"> · {formatTimestamp(payment.timestamp)}</span>
                        </span>
                        <a className="history-tx-link" href={`https://testnet.arcscan.app/tx/${payment.txHash}`} rel="noreferrer" target="_blank">
                          tx
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[var(--text-muted)]">No payments recorded in the recent block window.</p>
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
                          <span className="text-[var(--text-muted)]"> · {formatTimestamp(claim.timestamp)}</span>
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
            <p className="text-sm text-[var(--text-muted)]">No on-chain activity found in the recent block window.</p>
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
  // (persisted across reloads).
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
  const showRecurringDetails = Boolean(actingAccount && (walletTabs.length > 0 || tabState));
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

  return (
    <div className={`grid gap-5 ${showRecurringDetails ? "lg:grid-cols-[0.9fr_1.1fr]" : "lg:grid-cols-1"}`}>
      <div className="space-y-5">
        <Panel title="Create recurring tab" icon={<Landmark size={19} />}>
          <div className="space-y-3">
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--text-muted)]">
              {createAsSocial
                ? "Your Splitsy wallet receives each recurring settlement. Members can be wallet addresses or tagged handles."
                : "The connected creator wallet receives each recurring settlement. Members can be wallet addresses or tagged handles."}
            </div>
            {/* Same dual-identity choice as the one-off split form: which wallet
                creates the tab and receives every settlement. */}
            {canChooseCreator && socialWalletAddress && connectedWalletAccount ? (
              <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-[var(--text)]">Create as</p>
                  <p className="mt-1 text-[var(--text-muted)]">
                    {creatorIdentity === "social"
                      ? `Your Splitsy wallet ${shortAddress(socialWalletAddress)} creates the tab and receives the settlements — no signing needed.`
                      : `Your connected wallet ${shortAddress(connectedWalletAccount)} signs the tab and receives the settlements.`}
                  </p>
                </div>
                <div className="segmented-control shrink-0">
                  <ModeButton active={creatorIdentity === "social"} onClick={() => chooseCreatorIdentity("social")}>
                    {socialCreatorLabel}
                  </ModeButton>
                  <ModeButton active={creatorIdentity === "wallet"} onClick={() => chooseCreatorIdentity("wallet")}>
                    {shortAddress(connectedWalletAccount)}
                  </ModeButton>
                </div>
              </div>
            ) : null}
            <div className="segmented-control">
              <ModeButton active={recurringSplitMode === "equal"} onClick={() => setRecurringSplitMode("equal")}>
                Equal
              </ModeButton>
              <ModeButton active={recurringSplitMode === "manual"} onClick={() => setRecurringSplitMode("manual")}>
                Manual
              </ModeButton>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_0.45fr_0.7fr_0.5fr]">
              <Field
                label="Total USD"
                type="number"
                value={recurringTotalUsd}
                onChange={setRecurringTotalUsd}
              />
              <Field
                label="Cycles"
                type="number"
                value={recurringCycleCount}
                onChange={setRecurringCycleCount}
              />
              <label className="block text-sm font-medium text-[var(--text-soft)]">
                Cycle
                <select
                  className="field-control"
                  onChange={(event) => setRecurringCycle(event.target.value as RecurringCycle)}
                  value={recurringCycle}
                >
                  {availableRecurringCycleOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {recurringCycle === "custom" ? (
                <Field
                  label="Custom days"
                  type="number"
                  value={customCycleDays}
                  onChange={setCustomCycleDays}
                />
              ) : null}
            </div>
            {!cyclesValid ? (
              <p className="text-xs text-[var(--warning-text)]">Cycles must be at least 1.</p>
            ) : !customDaysValid ? (
              <p className="text-xs text-[var(--warning-text)]">Custom days must be a whole number of at least 1 day.</p>
            ) : Number(recurringTotalUsd) > 0 ? (
              <p className="text-xs text-[var(--text-muted)]">
                Total USD is the full amount across all {createCycleCount} cycle{createCycleCount === 1 ? "" : "s"}. Each cycle
                collects ${perCycleTotalUsd.toFixed(2)}
                {displayRecurringMembers.length > 1 ? ` across ${displayRecurringMembers.length} members` : ""}.
              </p>
            ) : null}
            {displayRecurringMembers.map((member) => (
              <div className="grid gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] p-3 sm:grid-cols-[1fr_0.35fr_auto] sm:items-end" key={member.id}>
                <HandleField
                  provider={member.provider ?? "wallet"}
                  onProviderChange={(value) => updateRecurringMember(member.id, "provider", value)}
                  value={member.address}
                  onChange={(value) => updateRecurringMember(member.id, "address", value)}
                />
                {recurringSplitMode === "manual" ? (
                  <Field
                    label="Share"
                    type="number"
                    value={member.share}
                    onChange={(value) => updateRecurringMember(member.id, "share", value)}
                  />
                ) : (
                  <div className="metric">
                    <p className="text-xs font-semibold uppercase text-[var(--text-muted)]">Share</p>
                    <p className="amount-text mt-1 text-lg font-semibold text-[var(--text)]">
                      ${recurringShareUsd.toFixed(2)}
                    </p>
                  </div>
                )}
                <button
                  aria-label="Remove member"
                  className="icon-button"
                  onClick={() => removeRecurringMember(member.id)}
                  type="button"
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button className="secondary-button" onClick={addRecurringMember} type="button">
              <Plus size={16} />
              Add member
            </button>
            <button className="primary-button" disabled={recurringState === "working" || !scheduleValid} onClick={createOnchainTab} type="button">
              {recurringState === "working" ? <Loader2 className="animate-spin" size={16} /> : <Landmark size={16} />}
              Create
            </button>
          </div>
          {recurringCreateMessage ? (
            <div className="mt-4">
              <Message tone={recurringCreateMessageTone}>{recurringCreateMessage}</Message>
            </div>
          ) : null}
        </Panel>

        {showRecurringDetails ? (
          <Panel
            title="Your recurring tabs"
            icon={<RefreshCw size={19} />}
            action={
              tabRowCount > 3 ? (
                <button className="secondary-button" onClick={() => setTabsExpanded(!tabsShown)} type="button">
                  <ChevronDown className={`transition-transform ${tabsShown ? "rotate-180" : ""}`} size={16} />
                  {tabsShown ? "Collapse" : "Expand"}
                </button>
              ) : null
            }
          >
            <div className="flex flex-wrap gap-2">
              <button className="secondary-button" disabled={!actingAccount} onClick={refreshRecurringTabsForWallet} type="button">
                <RefreshCw size={16} />
                Refresh tabs
              </button>
            </div>
            {recurringMessage ? (
              <div className="mt-4">
                <Message tone={recurringState === "error" ? "error" : recurringState === "success" ? "success" : "neutral"}>{recurringMessage}</Message>
              </div>
            ) : null}
            {!tabsShown ? (
              <p className="mt-4 text-sm text-[var(--text-muted)]">
                {tabRowCount} recurring tabs. Expand to view and act on each.
              </p>
            ) : (
            <div className="mt-4 space-y-2">
              {walletTabs.flatMap((tab) => {
                // A tab where the viewer is both recipient and a payer becomes
                // two rows so each role gets its own actions instead of one row
                // that mixes Approve and Claim.
                const roles: Array<"recipient" | "payer"> = [];
                if (isViewer(tab.recipient)) roles.push("recipient");
                if (tab.members.some((member) => isViewer(member.address))) roles.push("payer");
                if (roles.length === 0) roles.push("recipient");
                return roles.map((role) => (
                  <button
                    className={`w-full rounded-[var(--radius)] border p-3 text-left text-sm transition hover:bg-[var(--surface-muted)] ${
                      tabState?.address === tab.address && viewingRole === role
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] bg-[var(--surface-strong)]"
                    }`}
                    key={`${tab.address}-${role}`}
                    onClick={() => {
                      setViewRole(role);
                      selectRecurringTab(tab.address);
                    }}
                    type="button"
                  >
                    <span className="block font-semibold text-[var(--text)]">{shortAddress(tab.address)}</span>
                    <span className="mt-1 block text-[var(--text-muted)]">
                      {role === "payer" ? "You are a payer" : "You receive settlement"}{" "}
                      ·{" "}
                      {role === "payer"
                        ? recurringTabPaidForWallet(tab)
                          ? "paid off"
                          : tab.dueCycles > 0n
                            ? `${tab.dueCycles.toString()} due now`
                            : `next ${formatUnix(tab.nextSettlementAt)}`
                        : `$${unitsToUsdc(tab.claimable)} claimable`}
                    </span>
                  </button>
                ));
              })}
            </div>
            )}
          </Panel>
        ) : null}
      </div>

      {showRecurringDetails && tabState ? (
        <div className="space-y-5">
          <>
            <Panel title="Active cycle" icon={<ReceiptText size={19} />}>
              {actingAccount && visibleMembers.length === 1 && !isRecipient ? (
                <div className={`relative overflow-hidden rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent-soft)] p-4 ${recurringTabPaidForWallet(tabState) ? "paid-off-window" : ""}`}>
                  {(() => {
                    const debtor = visibleMembers[0];
                    if (!debtor) {
                      return null;
                    }
                    const debtorTotal = debtor.fixedShare * tabState.maxSettlements;
                    const debtorPaidOff = debtor.totalSettled >= debtorTotal;
                    const approvalNeeded = debtor.dueNow > 0n ? debtor.dueNow : activeTabComplete ? 0n : debtor.fixedShare;
                    const balanceNeeded = debtor.dueNow > 0n ? debtor.dueNow : activeTabComplete ? 0n : debtor.fixedShare;
                    const approvalShort = debtor.allowance < approvalNeeded;
                    const balanceShort = debtor.walletBalance < balanceNeeded;
                    const status = debtorPaidOff
                      ? "Paid off"
                      : debtor.dueNow > 0n && approvalShort
                        ? "Needs approval"
                        : debtor.dueNow > 0n && balanceShort
                          ? "Low balance"
                          : debtor.dueNow > 0n
                            ? activeTabComplete
                              ? "Partially paid"
                              : "Ready to settle"
                            : tabState.dueCycles === 0n
                              ? "Not due yet"
                              : "Ready to settle";
                    return (
                      <>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-[var(--accent)]">Your payment</p>
                            <h3 className="amount-text mt-1 text-2xl font-semibold text-[var(--text)]">
                              {debtorPaidOff
                                ? "Paid off"
                                : activeTabComplete
                                  ? `$${unitsToUsdc(debtor.dueNow)} outstanding`
                                  : `$${unitsToUsdc(debtor.dueNow)} due now`}
                            </h3>
                            <p className="mt-1 text-sm text-[var(--text-muted)]">
                              ${unitsToUsdc(debtor.fixedShare)} per cycle ·{" "}
                              {activeTabComplete ? "all cycles complete" : `next ${formatUnix(tabState.nextSettlementAt)}`}
                            </p>
                          </div>
                          <span className={`status-dot ${status === "Ready to settle" || status === "Paid off" ? "status-ok" : "status-warn"}`}>
                            {status}
                          </span>
                        </div>
                        {debtorPaidOff ? <PaidBillStamp /> : null}
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <Metric label="Approved" value={`$${unitsToUsdc(debtor.allowance)}`} />
                          <Metric label="Wallet balance" value={`$${unitsToUsdc(debtor.walletBalance)}`} />
                          <Metric label="Paid total" value={`$${unitsToUsdc(debtor.totalSettled)}`} />
                          <Metric label="Debt total" value={`$${unitsToUsdc(debtorTotal)}`} />
                          <Metric label="Cycles due" value={tabState.dueCycles.toString()} />
                          <Metric
                            label="Progress"
                            value={`${tabState.settlementCount.toString()} / ${tabState.maxSettlements.toString()}`}
                          />
                        </div>
                        <p className="mt-4 text-sm text-[var(--text-muted)]">
                          {debtorPaidOff
                            ? "This recurring bill is fully paid."
                            : debtor.dueNow > 0n
                              ? activeTabComplete
                                ? "All cycle windows have passed, but the outstanding recurring debt can still be collected after approval."
                                : "Funds stay in your wallet unless this tab is approved for the due amount and the cycle time has arrived."
                              : "No recurring debt is currently due for this wallet."}
                        </p>
                        {/* Bridging needs a browser-wallet session AND the debtor
                            to be that wallet; Splitsy (DCW) members top up their
                            wallet from the wallet dock instead. */}
                        {!debtorPaidOff && recurringWallet && debtor.address.toLowerCase() === recurringWallet.account.toLowerCase() ? (
                          (() => {
                            const bridgeAmount = balanceNeeded > 0n ? balanceNeeded : debtor.fixedShare;
                            return (
                              <div className="mt-4 border-t border-[var(--border)] pt-4">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                  <div>
                                    <p className="font-semibold text-[var(--text)]">Bridge USDC to Arc</p>
                                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                                      {balanceShort
                                        ? `Your Arc balance is below the $${unitsToUsdc(bridgeAmount)} USDC needed this cycle. `
                                        : ""}
                                      Move USDC from another chain to Arc in 3 transactions: approve USDC, bridge with CCTP V2,
                                      then claim on Arc Testnet. After that, approve the tab so the due cycle can be collected.
                                    </p>
                                  </div>
                                  <button
                                    className="secondary-button shrink-0"
                                    onClick={() => setShowBridge((open) => !open)}
                                    type="button"
                                  >
                                    <ArrowLeftRight size={16} />
                                    {showBridge ? "Hide bridge options" : "Bridge USDC"}
                                  </button>
                                </div>
                                {showBridge ? (
                                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                    {bridgeSourceChains.map((chain) => (
                                      <button
                                        className={`chain-button ${selectedBridgeChain === chain.id ? "chain-button-active" : ""}`}
                                        disabled={recurringState === "working"}
                                        key={chain.id}
                                        onClick={() => {
                                          setSelectedBridgeChain(chain.id);
                                          bridgeForRecurring(unitsToUsdc(bridgeAmount), chain.id);
                                        }}
                                        type="button"
                                      >
                                        Bridge from {chain.label}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })()
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Metric label="Recipient" value={shortAddress(tabState.recipient)} />
                    <Metric
                      label="Cycle progress"
                      value={`${tabState.settlementCount.toString()} / ${tabState.maxSettlements.toString()}`}
                    />
                    <Metric label="Overdue cycles" value={tabState.dueCycles.toString()} />
                    <Metric label="Due now" value={`$${unitsToUsdc(dueAmount)}`} />
                    <Metric label="Next settlement" value={formatUnix(tabState.nextSettlementAt)} />
                    <Metric label="Cycle length" value={formatDuration(tabState.settlementInterval)} />
                  </div>

                  <div className="route-strip mt-4 text-sm">
                    <div>
                      <p className="font-semibold text-[var(--text)]">RecurringTab.sol</p>
                      <a
                        className="mt-1 block break-all text-[var(--accent)] underline"
                        href={`https://testnet.arcscan.app/address/${tabState.address}`}
                      >
                        {shortAddress(tabState.address)}
                      </a>
                    </div>
                    <div className="route-line" aria-hidden="true" />
                    <div>
                      <p className="font-semibold text-[var(--text)]">Funds stay in wallets</p>
                      <p className="mt-1 text-[var(--text-muted)]">
                        Collection needs payer approval, enough balance, and a due cycle.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
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
                        <div className="p-3" key={member.address}>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <p className="break-all font-mono text-xs">{member.address}</p>
                            <span className={`status-dot ${memberPaidOff || memberStatus === "ready" ? "status-ok" : "status-warn"}`}>
                              {memberStatus}
                            </span>
                          </div>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <Metric label="Share" value={`$${unitsToUsdc(member.fixedShare)}`} />
                            <Metric label="Due now" value={`$${unitsToUsdc(member.dueNow)}`} />
                            <Metric label="Remaining total" value={`$${unitsToUsdc(member.remainingTotal)}`} />
                            <Metric label="Wallet balance" value={`$${unitsToUsdc(member.walletBalance)}`} />
                            <Metric label="Approved" value={`$${unitsToUsdc(member.allowance)}`} />
                            <Metric label="Collected total" value={`$${unitsToUsdc(member.totalSettled)}`} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </Panel>

            <Panel title="Actions" icon={<BadgeDollarSign size={19} />}>
              {/* Payer actions (approve/revoke) belong to payers only — hidden
                  on the recipient/settler side, whether single- or dual-role. */}
              {isRecipient ? null : (
                <>
              {/* A Splitsy (DCW) member's approval is set server-side to exactly
                  their remaining debt, so there is no limit to pick. */}
              {recurringWallet && (!viewerMember || walletIsTabMember) ? (
                <>
                  <Field
                    label="Approval limit"
                    type="number"
                    value={authorizationAmount || approvalPlaceholder}
                    onChange={setAuthorizationAmount}
                  />
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    {approvalPlaceholder ? `Default: ${approvalPlaceholder} USDC` : "Default updates after you load a tab."}
                  </p>
                </>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">
                  Approving from your Splitsy wallet authorizes exactly your remaining recurring debt on this tab.
                </p>
              )}
              <p className="mt-3 text-sm text-[var(--text-muted)]">
                Funds stay in the payer wallet unless this tab is approved for the due amount and the cycle time has arrived.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="primary-button" onClick={authorizeActiveTab} type="button">
                  Approve
                </button>
                <button className="secondary-button" onClick={revokeActiveTab} type="button">
                  Revoke
                </button>
              </div>
                </>
              )}
              {isRecipient ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    className="primary-button"
                    disabled={tabState.claimable <= 0n || recurringState === "working"}
                    onClick={claimActiveRecurringFunds}
                    type="button"
                  >
                    Claim recurring funds (${unitsToUsdc(tabState.claimable)})
                  </button>
                </div>
              ) : null}
            </Panel>

            {visibleEvents.length > 0 ? (
              <Panel title="Events" icon={<CheckCircle2 size={19} />}>
                <div className="space-y-2">
                  {visibleEvents.slice(0, 5).map((event, index) => (
                    <a
                      className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm hover:bg-[var(--surface-muted)]"
                      href={`https://testnet.arcscan.app/tx/${event.txHash}`}
                      key={`${event.txHash}-${event.name}-${event.blockNumber.toString()}-${index}`}
                    >
                      <span className="font-semibold">{event.name}</span>
                      <span className="font-mono text-xs text-[var(--text-muted)]">{shortAddress(event.txHash)}</span>
                    </a>
                  ))}
                </div>
              </Panel>
            ) : null}
          </>
        </div>
      ) : null}
    </div>
  );
}

const flowStepIcons: Record<FlowStepIcon, typeof ShieldCheck> = {
  switch: WalletCards,
  approve: ShieldCheck,
  pay: Send,
  bridge: ArrowLeftRight,
  claim: Landmark,
};

function ProgressModal({ flow, onClose }: { flow: ProgressFlow; onClose: () => void }) {
  const running = flow.status === "running";
  const succeeded = flow.status === "success";
  const isBridge = flow.kind === "bridge";
  const isClaim = flow.kind === "claim";

  const headIcon = succeeded ? (
    <CheckCircle2 size={22} />
  ) : flow.status === "error" ? (
    <AlertTriangle size={22} />
  ) : isBridge ? (
    <ArrowLeftRight size={22} />
  ) : (
    <BadgeDollarSign size={22} />
  );

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

  const explorerLinks = flow.steps
    .filter((step) => step.explorerUrl)
    .map((step) => ({ key: step.key, label: step.label, url: step.explorerUrl as string }));

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
        <Dialog.Overlay className="pay-modal-overlay" />
        <Dialog.Content
          aria-describedby="pay-modal-sub"
          className={`pay-modal pay-modal-${flow.status}`}
          onEscapeKeyDown={(event) => running && event.preventDefault()}
          onInteractOutside={(event) => running && event.preventDefault()}
        >
          <div className="pay-modal-head">
            <span className={`pay-modal-icon pay-modal-icon-${flow.status}`} aria-hidden="true">
              {headIcon}
            </span>
            <div className="min-w-0">
              <Dialog.Title className="pay-modal-title">{title}</Dialog.Title>
              <Dialog.Description className="pay-modal-sub" id="pay-modal-sub">
                {subtitle}
              </Dialog.Description>
            </div>
            {!running ? (
              <Dialog.Close className="icon-button pay-modal-close" aria-label="Close">
                <X size={17} />
              </Dialog.Close>
            ) : null}
          </div>

          <ol className="pay-steps">
            {flow.steps.map((step) => {
              const StepIcon = flowStepIcons[step.icon];
              return (
                <li className="pay-step" data-state={step.state} key={step.key}>
                  <span className="pay-step-icon" aria-hidden="true">
                    {step.state === "active" ? (
                      <Loader2 className="animate-spin" size={16} />
                    ) : step.state === "done" ? (
                      <CheckCircle2 size={16} />
                    ) : step.state === "error" ? (
                      <AlertTriangle size={16} />
                    ) : (
                      <StepIcon size={15} />
                    )}
                  </span>
                  <span className="pay-step-body">
                    <span className="pay-step-label">{step.label}</span>
                    <span className="pay-step-hint">
                      {step.state === "done"
                        ? "Confirmed"
                        : step.state === "error"
                          ? "Failed"
                          : step.hint}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>

          {explorerLinks.length > 0 ? (
            <div className="pay-modal-links">
              {explorerLinks.map((link) => (
                <a className="pay-modal-link" href={link.url} key={link.key} rel="noreferrer" target="_blank">
                  <ExternalLink size={13} />
                  {link.label} transaction
                </a>
              ))}
            </div>
          ) : null}

          <div className="pay-modal-foot">
            <span className={`pay-modal-status pay-modal-status-${flow.status}`}>
              {running ? (
                <>
                  <Loader2 className="animate-spin" size={15} />
                  {flow.runningLabel ?? (isBridge ? "Keep this open until the bridge finishes" : "Confirm each step in your wallet")}
                </>
              ) : succeeded ? (
                <>
                  <CheckCircle2 size={15} />
                  All transactions confirmed
                </>
              ) : (
                <>
                  <AlertTriangle size={15} />
                  No funds were lost
                </>
              )}
            </span>
            {!running ? (
              <button className="primary-button" onClick={onClose} type="button">
                {succeeded ? "Done" : "Close"}
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

function Panel({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-[var(--accent)]">{icon}</span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  disabled = false,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block text-sm font-medium text-[var(--text-soft)]">
      {label}
      <input
        className="field-control"
        disabled={disabled}
        min={type === "number" ? "0" : undefined}
        onChange={(event) => onChange(event.target.value)}
        step={type === "number" ? "0.01" : undefined}
        type={type}
        value={value}
      />
    </label>
  );
}

// The one debtor field: accepts a 0x wallet address, an email address, or an
// X/Discord handle. Wallet and email are auto-detected from the value; the
// inline dropdown only disambiguates X vs Discord for bare handles, so one
// bill can mix debtors across platforms. Per detected kind:
//  - Wallet: anything starting with 0x — no preview, used as-is on-chain.
//  - X: a valid handle triggers a live unavatar.io lookup (fallback=false) so
//    the avatar only shows once it resolves to a real account — a typo 404s and
//    stays hidden, the "your handle became real" confirmation.
//  - Discord: no public username→avatar CDN, so no preview.
//  - Email: tagged (and matched) by address; both Google sign-in and Email-OTP
//    resolve to it. unavatar.io resolves a Gravatar once the address looks valid.
// The trimmed value is stored (leading @ stripped); the server lowercases it
// before matching, so casing here doesn't affect debt linking.
function HandleField({
  provider: pickedProvider,
  onProviderChange,
  value,
  onChange,
}: {
  provider: IdentityProvider | "wallet";
  onProviderChange: (value: IdentityProvider | "wallet") => void;
  value: string;
  onChange: (value: string) => void;
}) {
  const handle = value.replace(/^@+/, "").trim();
  // An explicit "Wallet address" pick is authoritative; otherwise a typed 0x
  // address or email re-labels the row to match what it actually holds.
  const provider: IdentityProvider | "wallet" =
    pickedProvider === "wallet" || /^0x/i.test(handle)
      ? "wallet"
      : looksLikeEmail(handle)
        ? "email"
        : pickedProvider;
  // Per-kind validity gates the avatar preview: X handles are ≤15 word chars;
  // email must look like an address; wallet and Discord show no preview.
  const valid =
    provider === "x"
      ? /^[a-zA-Z0-9_]{1,15}$/.test(handle)
      : provider === "email"
        ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle)
        : false;
  const [debounced, setDebounced] = useState(handle);
  const [avatarOk, setAvatarOk] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(handle), 400);
    return () => clearTimeout(timer);
  }, [handle]);

  // X keys unavatar by handle; email keys it by the address (Gravatar).
  const src =
    valid && debounced
      ? provider === "x"
        ? `https://unavatar.io/x/${debounced.toLowerCase()}?fallback=false`
        : provider === "email"
          ? `https://unavatar.io/${encodeURIComponent(debounced.toLowerCase())}?fallback=false`
          : ""
      : "";
  // A new handle hasn't resolved yet — fade the old avatar out until onLoad fires.
  useEffect(() => setAvatarOk(false), [src]);

  const label =
    provider === "wallet"
      ? "Wallet address"
      : provider === "discord"
        ? "Discord username"
        : provider === "email"
          ? "Email address"
          : "X handle";

  return (
    <label className="block text-sm font-medium text-[var(--text-soft)]">
      <span className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1">
          {provider === "wallet" ? (
            <WalletCards size={12} />
          ) : provider === "discord" ? (
            <svg width="12" height="12" viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden="true">
              <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z" />
            </svg>
          ) : provider === "email" ? (
            <Mail size={12} />
          ) : (
            <Image src="/x.png" alt="" width={12} height={12} />
          )}
          {label}
        </span>
        <select
          aria-label="Tag by"
          value={provider}
          onChange={(event) => onProviderChange(event.target.value as IdentityProvider | "wallet")}
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-xs font-medium text-[var(--text)]"
        >
          <option value="wallet">Wallet address</option>
          <option value="x">X</option>
          <option value="discord">Discord</option>
          <option value="email">Email address</option>
        </select>
      </span>
      <span className="handle-field">
        <input
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          inputMode={provider === "email" ? "email" : "text"}
          className={`field-control handle-input${avatarOk ? " is-resolved" : ""}`}
          onChange={(event) => onChange(event.target.value.replace(/^@+/, "").trim())}
          spellCheck={false}
          value={handle}
        />
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote unavatar URL, not a bundled asset
          <img
            alt={`${debounced} avatar`}
            className={`handle-avatar${avatarOk ? " is-visible" : ""}`}
            height={24}
            onError={() => setAvatarOk(false)}
            onLoad={() => setAvatarOk(true)}
            src={src}
            width={24}
          />
        ) : null}
      </span>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <p className="text-xs font-semibold uppercase text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 break-all text-lg font-semibold text-[var(--text)]">{value}</p>
    </div>
  );
}

function Message({ tone, children }: { tone: "error" | "neutral" | "success"; children: ReactNode }) {
  return (
    <div
      className={`message ${
        tone === "error" ? "message-error" : tone === "success" ? "message-success" : "message-neutral"
      }`}
    >
      {tone === "error" ? (
        <AlertTriangle className="mt-0.5 shrink-0" size={17} />
      ) : tone === "success" ? (
        <CheckCircle2 className="mt-0.5 shrink-0" size={17} />
      ) : (
        <Info className="mt-0.5 shrink-0" size={17} />
      )}
      {children}
    </div>
  );
}

// Recomputes an on-chain bill's hash from its published plaintext details and
// shows whether they match the fingerprint locked on Arc. "Verified" means the
// merchant/total/split shown here are exactly what the creator committed
// on-chain; "Couldn't verify" means the details don't match — a red flag. The
// comparison runs in the payer's own browser, so it trusts only the chain.
function BillVerification({ billId, metadataHash }: { billId: bigint; metadataHash: `0x${string}` }) {
  const [status, setStatus] = useState<"loading" | "verified" | "mismatch" | "unpublished" | "error">("loading");
  const [merchant, setMerchant] = useState<string>("");
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  // The committed due date (Unix seconds), surfaced so payers know the deadline
  // their timeliness is scored against. 0/undefined = no due date on this bill.
  const [dueDate, setDueDate] = useState<number | undefined>(undefined);
  // Independent re-OCR of the receipt vs the on-chain total. "altered" is the
  // signal that the creator charged something other than what the receipt reads.
  // "no-receipt" = the creator typed the total by hand (nothing to cross-check).
  const [audit, setAudit] = useState<
    | { state: "idle" | "checking" | "unavailable" | "no-receipt" }
    | { state: "ok" | "altered"; scannedUsd: number; onchainUsd: number }
  >({ state: "idle" });
  const [showDetail, setShowDetail] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("loading");
      setAudit({ state: "idle" });
      try {
        const res = await fetch(
          `/api/onchain-bills/preimage?registry=${BILL_SPLIT_REGISTRY_ADDRESS}&billId=${billId.toString()}`,
        );
        if (res.status === 404) {
          if (!cancelled) setStatus("unpublished");
          return;
        }
        if (!res.ok) {
          if (!cancelled) setStatus("error");
          return;
        }
        const { preimage } = (await res.json()) as { preimage: BillPreimage & { receiptUrl: string | null } };
        const ok = verifyBillPreimage(preimage, metadataHash);
        if (!cancelled) {
          setMerchant(preimage.merchant);
          // Only trust the due date once the preimage verifies — it's part of
          // the committed hash, so a verified preimage proves the creator set it.
          setDueDate(ok ? preimage.dueDate : undefined);
          setStatus(ok ? "verified" : "mismatch");
        }
        if (!ok) return;
        if (!preimage.receiptHash || !preimage.receiptUrl) {
          // Hand-entered bill: the creator typed the total, no receipt exists.
          if (!cancelled) setAudit({ state: "no-receipt" });
          return;
        }

        const onchainUsd = preimage.total;
        // Cached from a previous view? The receiptHash is content-addressed, so a
        // hit is provably the same image — no need to re-fetch or re-OCR.
        const cached = readCachedScan(preimage.receiptHash);
        if (cached !== null) {
          if (!cancelled) {
            setReceiptUrl(preimage.receiptUrl);
            const altered = Math.abs(cached - onchainUsd) > Math.max(0.05, onchainUsd * 0.02);
            setAudit({ state: altered ? "altered" : "ok", scannedUsd: cached, onchainUsd });
          }
          return;
        }

        // Fetch the committed receipt and hash it in THIS browser against the
        // committed receiptHash — trust the chain, not the storage bucket. A
        // tampered image simply won't show and won't be audited.
        let bytes: Uint8Array;
        try {
          const img = await fetch(preimage.receiptUrl);
          bytes = new Uint8Array(await img.arrayBuffer());
        } catch {
          if (!cancelled) setAudit({ state: "unavailable" });
          return;
        }
        if (hashReceiptBytes(bytes).toLowerCase() !== preimage.receiptHash.toLowerCase()) {
          // Image doesn't match the chain — don't show it or trust its total.
          if (!cancelled) setAudit({ state: "unavailable" });
          return;
        }
        if (!cancelled) {
          setReceiptUrl(preimage.receiptUrl);
          setAudit({ state: "checking" });
        }

        // Re-OCR the verified receipt and compare its total to the on-chain
        // total. Because the debtor extracts the number independently, a creator
        // who committed a different total is caught. Best-effort: if OCR/FX is
        // unavailable we fall back to the human eyeball (image is shown anyway).
        const scannedUsd = await scanReceiptTotalUsd(bytes);
        if (cancelled) return;
        if (scannedUsd === null) {
          setAudit({ state: "unavailable" });
          return;
        }
        writeCachedScan(preimage.receiptHash, scannedUsd);
        // Tolerance absorbs OCR rounding + FX drift; flag only a real gap.
        const altered = Math.abs(scannedUsd - onchainUsd) > Math.max(0.05, onchainUsd * 0.02);
        setAudit({ state: altered ? "altered" : "ok", scannedUsd, onchainUsd });
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [billId, metadataHash]);

  // Altered total: the receipt IS the evidence, so open it by default — but leave
  // the user free to hide it via the toggle.
  useEffect(() => {
    if (audit.state === "altered") setShowReceipt(true);
  }, [audit.state]);

  if (status === "loading") {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <Loader2 className="animate-spin" size={13} /> Checking this bill against Arc…
      </p>
    );
  }

  if (status === "unpublished" || status === "error") {
    return (
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        {status === "unpublished"
          ? "On-chain verification isn’t available for this bill."
          : "Couldn’t reach the verifier — refresh to retry."}
      </p>
    );
  }

  const verified = status === "verified";
  const altered = verified && audit.state === "altered";
  // Green reassurance is only honest when the commitment matches AND the receipt
  // total agrees. An altered total is treated as a red warning, like a mismatch.
  const safe = verified && !altered;
  const receiptOpen = showReceipt;
  const title = altered
    ? `Warning — the total was changed${merchant ? ` — ${merchant}` : ""}`
    : verified
      ? `Verified on Arc${merchant ? ` — ${merchant}` : ""}`
      : "This bill doesn’t match Arc";
  return (
    <div
      className={`mt-2 rounded-[var(--radius)] border p-2.5 text-xs ${
        safe
          ? "border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
          : "border-[color-mix(in_srgb,#dc2626_45%,transparent)] bg-[color-mix(in_srgb,#dc2626_10%,transparent)]"
      }`}
    >
      <div className="flex items-start gap-1.5 font-semibold">
        {safe ? (
          <ShieldCheck className="mt-0.5 shrink-0 text-[var(--accent)]" size={15} />
        ) : (
          <AlertTriangle className="mt-0.5 shrink-0 text-[#dc2626]" size={15} />
        )}
        <span>{title}</span>
      </div>

      {/* Two independent checks, shown separately so it's clear what passed and
          what didn't: (1) do the details match the chain, (2) does the charged
          total match the receipt. */}
      <div className="mt-2 space-y-1.5">
        {/* Check 1 — commitment integrity. */}
        {verified ? (
          <p className="flex items-start gap-1.5 text-[var(--accent)]">
            <CheckCircle2 className="mt-0.5 shrink-0" size={13} />
            <span className="text-[var(--text)]">Genuine bill on Arc — the details shown here are exactly what the creator committed (not tampered with since).</span>
          </p>
        ) : (
          <p className="flex items-start gap-1.5 font-semibold text-[#dc2626]">
            <AlertTriangle className="mt-0.5 shrink-0" size={13} />
            <span>Details don’t match Arc — don’t pay until the creator re-checks this bill.</span>
          </p>
        )}

        {/* Committed pay-by date, if the creator set one. Positive framing:
            paying on time builds reputation; it's a nudge, not a threat. */}
        {verified && dueDate ? (
          <p className="flex items-start gap-1.5 text-[var(--text-muted)]">
            <CalendarClock className="mt-0.5 shrink-0" size={13} />
            <span>
              Pay by {new Date(dueDate * 1000).toLocaleDateString()} to keep your on-chain payment reputation strong.
            </span>
          </p>
        ) : null}

        {/* Check 2 — does the charged total match the receipt? Only meaningful
            once the commitment itself is verified. */}
        {verified && audit.state === "checking" ? (
          <p className="flex items-center gap-1.5 text-[var(--text-muted)]">
            <Loader2 className="animate-spin" size={13} /> Checking the total against the receipt…
          </p>
        ) : null}
        {verified && audit.state === "ok" ? (
          <p className="flex items-start gap-1.5 text-[var(--accent)]">
            <CheckCircle2 className="mt-0.5 shrink-0" size={13} />
            <span className="text-[var(--text)]">Total matches the receipt (~${audit.onchainUsd.toFixed(2)}).</span>
          </p>
        ) : null}
        {verified && audit.state === "altered" ? (
          <p className="flex items-start gap-1.5 font-semibold text-[#dc2626]">
            <AlertTriangle className="mt-0.5 shrink-0" size={13} />
            <span>
              Total was changed — the receipt reads about ${audit.scannedUsd.toFixed(2)}, but you’re charged $
              {audit.onchainUsd.toFixed(2)}. Ask the creator before paying.
            </span>
          </p>
        ) : null}
        {verified && audit.state === "no-receipt" ? (
          <p className="flex items-start gap-1.5 text-[var(--text-muted)]">
            <Info className="mt-0.5 shrink-0" size={13} />
            <span>No receipt was uploaded — the creator typed this total by hand, so it can’t be checked against a bill.</span>
          </p>
        ) : null}
        {verified && audit.state === "unavailable" ? (
          <p className="flex items-start gap-1.5 text-[var(--text-muted)]">
            <Info className="mt-0.5 shrink-0" size={13} />
            <span>Couldn’t re-read the total automatically — open the receipt below and compare it yourself.</span>
          </p>
        ) : null}
      </div>

      {verified && receiptUrl ? (
        <div className="mt-2">
          <button
            className="inline-flex items-center gap-1 text-[var(--text-muted)] underline underline-offset-2"
            onClick={() => setShowReceipt((open) => !open)}
            type="button"
          >
            <ChevronDown className={`transition-transform ${receiptOpen ? "rotate-180" : ""}`} size={12} />
            {receiptOpen ? "Hide receipt" : "View the receipt committed on-chain"}
          </button>
          {receiptOpen ? (
            <div className="mt-1.5">
              <p className="mb-1 text-[var(--text-muted)]">Check the total matches what you’re charged:</p>
              <a href={receiptUrl} rel="noreferrer" target="_blank">
                {/* Plain img: a Supabase Storage URL isn't in next.config's allowed domains. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt="Receipt committed on-chain for this bill"
                  className="max-h-64 w-auto rounded-[var(--radius)] border border-[var(--receipt-border-soft)]"
                  src={receiptUrl}
                />
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        className="mt-2 inline-flex items-center gap-1 text-[var(--text-muted)] underline underline-offset-2"
        onClick={() => setShowDetail((open) => !open)}
        type="button"
      >
        <ChevronDown className={`transition-transform ${showDetail ? "rotate-180" : ""}`} size={12} />
        What does this mean?
      </button>
      {showDetail ? (
        <div className="mt-1.5 space-y-2 text-[var(--text-muted)]">
          <p>
            <span className="font-semibold text-[var(--text)]">1. Genuine bill on Arc.</span> When this bill
            was created, Splitsy wrote a tamper-proof fingerprint of its details onto the Arc blockchain,
            where it can’t be edited. Your browser recomputed that fingerprint and
            {verified
              ? " it matches — so the merchant, total, and split shown here are exactly what the creator committed. (This does NOT mean the total is correct — that’s check 2.)"
              : " it does NOT match — so what you’re shown is not what was committed. Don’t pay."}
          </p>
          <p>
            <span className="font-semibold text-[var(--text)]">2. Total matches the receipt.</span>{" "}
            {audit.state === "no-receipt"
              ? "This bill has no receipt — the creator entered the total by hand, so there’s nothing to cross-check the amount against."
              : audit.state === "ok"
                ? "The receipt image is committed too, so your browser re-read it and confirmed its total matches what you’re being charged."
                : audit.state === "altered"
                  ? "Your browser re-read the committed receipt: the total the creator committed doesn’t match the amount printed on the receipt. The bill is genuine, but the charged total is wrong."
                  : "The receipt image is committed, but your browser couldn’t re-read its total automatically — open it above and compare by eye."}
          </p>
          <p className="break-all font-mono text-[10px]">On-chain hash: {metadataHash}</p>
        </div>
      ) : null}
    </div>
  );
}

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
    <button className={`tab-button ${active ? "tab-button-active" : ""}`} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={`mode-button ${active ? "mode-button-active" : ""}`} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function sourceLabel(id: BridgeSourceChain) {
  return bridgeSourceChains.find((chain) => chain.id === id)?.label ?? id;
}

function toUsdInput(value: number, rate: number) {
  return (value * rate).toFixed(2);
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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
