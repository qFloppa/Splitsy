"use client";

import {
  AlertTriangle,
  ArrowLeftRight,
  BadgeDollarSign,
  BookOpen,
  Camera,
  ChevronDown,
  CheckCircle2,
  ExternalLink,
  FileJson,
  Landmark,
  Loader2,
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
import XSignInButton from "./XSignInButton";
import XDebtsPanel from "./XDebtsPanel";
import XHistoryPanel from "./XHistoryPanel";
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
  BillActivity,
  BillSplitDebt,
  BillSplitWallet,
  billUnitsToUsdc,
  createBillSplit,
  createBillSplitWallet,
  ensureBillSplitWalletOnArc,
  isBillRegistryConfigured,
  payBillDebtWithMemo,
  readArcUsdcBalance,
  readBillActivity,
  readBillsForSplitter,
  readDebtsForWallet,
  usdcToBillUnits,
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
import { wagmiConfig } from "@/lib/wagmi";

type FxQuote = {
  amountUsd: number;
  rate: number;
  source: string;
  asOf: string;
};

type OcrState = "idle" | "reading" | "ready" | "error";
type BillRunState = "idle" | "connecting" | "working" | "success" | "error";
type RecurringRunState = "idle" | "connecting" | "working" | "error" | "success";
type AppTab = "bills" | "recurring" | "history";
type AppTheme = "light" | "dark";
type RecurringCycle = "test" | "weekly" | "monthly" | "custom";
type RecurringMemberInput = {
  id: string;
  address: string;
  share: string;
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
  kind: "pay" | "bridge";
  open: boolean;
  amountLabel: string;
  contextLabel: string;
  status: "running" | "success" | "error";
  errorMessage: string;
  steps: FlowStep[];
};

const recurringCycleOptions: Array<{ id: RecurringCycle; label: string; seconds: bigint }> = [
  { id: "test", label: "Every 3 minutes", seconds: 3n * 60n },
  { id: "weekly", label: "Weekly", seconds: 7n * 24n * 60n * 60n },
  { id: "monthly", label: "Monthly", seconds: 30n * 24n * 60n * 60n },
  { id: "custom", label: "Custom", seconds: 30n * 24n * 60n * 60n },
];

export default function HomeClient({ testCycleEnabled = false }: { testCycleEnabled?: boolean }) {
  const [activeTab, setActiveTab] = useState<AppTab>("bills");
  const [theme, setTheme] = useState<AppTheme>(() => {
    if (typeof window === "undefined") {
      return "light";
    }
    const storedTheme = window.sessionStorage.getItem("splitsy-theme");
    return storedTheme === "dark" ? "dark" : "light";
  });
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [error, setError] = useState("");
  const [imagePreview, setImagePreview] = useState("");
  const [isDraggingBill, setIsDraggingBill] = useState(false);
  const [manualBillEntry, setManualBillEntry] = useState(false);
  const [bill, setBill] = useState<ParsedBill>({
    ...emptyParsedBill,
    merchant: "Upload a bill",
  });
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  const [splitMode, setSplitMode] = useState<"equal" | "manual">("equal");
  const [bridgeResults, setBridgeResults] = useState<Record<string, BridgeSummary>>({});
  const [bridgeSession, setBridgeSession] = useState<BrowserWalletSession | null>(null);
  const [recurringCycle, setRecurringCycle] = useState<RecurringCycle>("weekly");
  const [customCycleDays, setCustomCycleDays] = useState("30");
  const [billWallet, setBillWallet] = useState<BillSplitWallet | null>(null);
  const [billState, setBillState] = useState<BillRunState>("idle");
  const [billMessage, setBillMessage] = useState("");
  const [debtMessages, setDebtMessages] = useState<Record<string, { message: string; tone: "error" | "neutral" }>>({});
  const [progressFlow, setProgressFlow] = useState<ProgressFlow | null>(null);
  const [claimMessage, setClaimMessage] = useState("");
  const [claimMessageTone, setClaimMessageTone] = useState<"error" | "neutral">("neutral");
  const [submittedBillId, setSubmittedBillId] = useState<bigint | null>(null);
  const [debts, setDebts] = useState<BillSplitDebt[]>([]);
  const [splitterBills, setSplitterBills] = useState<BillSplitDebt[]>([]);
  const [arcUsdcBalance, setArcUsdcBalance] = useState<bigint | null>(null);
  const [arcUsdcBalanceFlash, setArcUsdcBalanceFlash] = useState(false);
  const [partialPayments, setPartialPayments] = useState<Record<string, string>>({});
  const [claimAmounts, setClaimAmounts] = useState<Record<string, string>>({});
  const [participantShareInputs, setParticipantShareInputs] = useState<Record<string, string>>({});
  const [splitBy, setSplitBy] = useState<"address" | "handle">("address");

  // Switching to @handle mode clears any prefilled 0x… demo addresses so the
  // identifier field starts empty (a wallet address is not a valid handle).
  function chooseSplitBy(next: "address" | "handle") {
    if (next === "handle") {
      setParticipants((current) =>
        current.map((p) => (/^0x[a-fA-F0-9]{40}$/.test(p.walletAddress) ? { ...p, walletAddress: "" } : p)),
      );
    }
    setSplitBy(next);
  }
  const [recurringWallet, setRecurringWallet] = useState<RecurringWallet | null>(null);
  const [recurringState, setRecurringState] = useState<RecurringRunState>("idle");
  const [recurringMessage, setRecurringMessage] = useState("");
  const [recurringCreateMessage, setRecurringCreateMessage] = useState("");
  const [recurringCreateMessageTone, setRecurringCreateMessageTone] = useState<"error" | "neutral">("neutral");
  const [recurringTotalUsd, setRecurringTotalUsd] = useState("200.00");
  const [recurringCycleCount, setRecurringCycleCount] = useState("3");
  const [recurringSplitMode, setRecurringSplitMode] = useState<"equal" | "manual">("equal");
  const [recurringMembers, setRecurringMembers] = useState<RecurringMemberInput[]>([
    { id: "rec-member-1", address: "0x1111111111111111111111111111111111111111", share: "0.00" },
    { id: "rec-member-2", address: "0x2222222222222222222222222222222222222222", share: "0.00" },
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
      walletAddress: "0x1111111111111111111111111111111111111111",
      amountUsd: 0,
      status: "unpaid",
    },
    {
      id: "payer-2",
      label: "Payer 2",
      walletAddress: "0x2222222222222222222222222222222222222222",
      amountUsd: 0,
      status: "unpaid",
    },
  ]);
  const { address, connector } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();

  const confirmedUsd = fxQuote?.amountUsd ?? (bill.currency === "USD" ? bill.total : 0);
  const displayParticipants = useMemo(() => {
    return splitMode === "equal" ? equalSplit(confirmedUsd, participants) : participants;
  }, [confirmedUsd, participants, splitMode]);
  const splitTotal = displayParticipants.reduce((sum, participant) => sum + participant.amountUsd, 0);
  const splitDelta = Number((confirmedUsd - splitTotal).toFixed(2));
  // "Total USD" is the full amount across the whole schedule, so a $3 tab over 3
  // cycles is $1 collected per cycle — not $3/cycle (which would total $9). The
  // contract's fixedShare is per-cycle, so divide the total by both members and
  // cycle count to get each member's per-cycle share.
  const recurringCycleCountNum = Math.max(1, Math.floor(Number(recurringCycleCount) || 1));
  const recurringShareUsd =
    recurringMembers.length > 0
      ? Number(recurringTotalUsd || "0") / recurringMembers.length / recurringCycleCountNum
      : 0;
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
    document.documentElement.dataset.theme = theme;
    sessionStorage.setItem("splitsy-theme", theme);
  }, [theme]);

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
      setBillMessage(`Connected ${shortAddress(bill.account)} on Arc Testnet.`);
      setRecurringMessage(`Connected ${shortAddress(recurring.account)} on Arc Testnet.`);
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

  async function refreshBillRegistry(account = billWallet?.account) {
    if (!account) {
      return;
    }

    try {
      const [nextDebts, nextSplitterBills, nextArcUsdcBalance] = await Promise.all([
        readDebtsForWallet(account),
        readBillsForSplitter(account),
        readArcUsdcBalance(account),
      ]);
      // Keep fully-paid debts in state so the debtor retains a shrunk, stamped record of what they paid.
      setDebts(nextDebts);
      setSplitterBills(nextSplitterBills);
      setArcUsdcBalance(nextArcUsdcBalance);
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


  async function submitBillOnchain() {
    if (splitMode === "manual" && splitTotal - confirmedUsd > 0.009) {
      setBillState("error");
      setBillMessage("Manual shares cannot be larger than the bill Total USD amount.");
      return;
    }

    const wallet = billWallet ?? (await connectBillWallet());

    if (!wallet) {
      return;
    }

    if (!isBillRegistryConfigured()) {
      setBillState("error");
      setBillMessage("Bill registry is not configured yet.");
      return;
    }

    const payableParticipants = displayParticipants.filter(
      (participant) => participant.amountUsd > 0 && /^0x[a-fA-F0-9]{40}$/.test(participant.walletAddress),
    );

    if (payableParticipants.length === 0) {
      setBillState("error");
      setBillMessage("Add at least one payer wallet with a positive share.");
      return;
    }

    try {
      setBillState("working");
      setBillMessage("Switching to Arc Testnet…");
      await ensureBillSplitWalletOnArc(wallet);
      setBillMessage("Writing the split to Arc.");
      const result = await createBillSplit({
        ...wallet,
        metadataHash: billMetadataHash({
          merchant: bill.merchant,
          currency: bill.currency,
          total: confirmedUsd,
          participantLabels: payableParticipants.map((participant) => participant.label),
        }),
        participants: payableParticipants.map((participant) => normalizeAddress(participant.walletAddress)),
        owedAmounts: payableParticipants.map((participant) => usdcToBillUnits(participant.amountUsd.toFixed(2))),
      });

      setSubmittedBillId(result.billId);
      setBillState("success");
      setBillMessage(`Bill #${result.billId.toString()} is live on Arc. Payers will see it when they connect.`);
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
    }
  }

  // Off-chain path: tag payers by @handle and store the bill in Supabase. Tagged
  // people discover it and settle from their DCW after signing in with X.
  async function submitBillOffchain() {
    if (splitMode === "manual" && splitTotal - confirmedUsd > 0.009) {
      setBillState("error");
      setBillMessage("Manual shares cannot be larger than the bill Total USD amount.");
      return;
    }

    const debts = displayParticipants
      .filter((participant) => participant.amountUsd > 0 && participant.walletAddress.trim())
      .map((participant) => ({ handle: participant.walletAddress.trim(), amount: participant.amountUsd }));

    if (debts.length === 0) {
      setBillState("error");
      setBillMessage("Add at least one @handle with a positive share.");
      return;
    }

    try {
      setBillState("working");
      setBillMessage("Saving the split…");
      const res = await fetch("/api/bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant: bill.merchant, currency: bill.currency, debts }),
      });
      if (res.status === 401) {
        setBillState("error");
        setBillMessage("Sign in with X (top right) to split by @handle.");
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setBillState("error");
        setBillMessage(data.error ?? "Could not create the bill.");
        return;
      }
      setBillState("success");
      setBillMessage("Bill created. Tagged people will see it under their unpaid bills when they sign in with X.");
      // Clear the form so the same split can't be submitted again on re-click.
      setParticipants([{ id: `payer-${Date.now()}`, label: "Payer 1", walletAddress: "", amountUsd: 0, status: "unpaid" }]);
      setParticipantShareInputs({});
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

  async function payDebtOnArc(debt: BillSplitDebt) {
    const wallet = billWallet ?? (await connectBillWallet());
    const debtKey = debt.billId.toString();

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
        [debtKey]: { tone: "neutral", message: `Paid ${amountLabel} USDC toward bill #${debtKey}.` },
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
          tone: "neutral",
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
        void refreshRecurringTab(activeTabAddress);
      }
    } catch (caught) {
      setRecurringState("error");
      failFlow(errorMessage(caught));
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function claimSplitterFunds(debt: BillSplitDebt) {
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
      setClaimMessageTone("neutral");
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

  async function createOnchainTab() {
    const wallet = recurringWallet ?? (await connectRecurring());

    if (!wallet) {
      return;
    }

    try {
      setRecurringState("working");
      setRecurringCreateMessageTone("neutral");
      setRecurringCreateMessage("Switching to Arc Testnet…");
      await ensureRecurringWalletOnArc(wallet);
      setRecurringCreateMessage("Creating recurring tab on Arc Testnet.");
      const totalUsd = Number(recurringTotalUsd);
      if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
        throw new Error("Enter a recurring total greater than 0 USDC.");
      }
      if (recurringMembers.length === 0) {
        throw new Error("Add at least one member wallet.");
      }
      const cycleCountNum = Math.floor(Number(recurringCycleCount));
      if (!Number.isFinite(cycleCountNum) || cycleCountNum < 1) {
        throw new Error("Enter at least 1 cycle.");
      }
      const cycleCount = BigInt(cycleCountNum);
      const members = recurringMembers.map((member) => normalizeAddress(member.address));
      if (new Set(members.map((member) => member.toLowerCase())).size !== members.length) {
        throw new Error("Each recurring member wallet must be unique.");
      }
      const sourceMembers = recurringSplitMode === "equal" ? displayRecurringMembers : recurringMembers;
      const shares = sourceMembers.map((member) => usdcToUnits(member.share));
      // Member shares are per-cycle. Across the whole schedule they should sum to
      // the Total USD, so per cycle they must sum to Total ÷ cycles.
      const perCycleTotal = totalUsd / Number(cycleCount);
      const shareTotal = sourceMembers.reduce((sum, member) => sum + Number(member.share || "0"), 0);
      if (shares.some((share) => share <= 0n)) {
        throw new Error("Every recurring member needs a positive share.");
      }
      if (Math.abs(shareTotal - perCycleTotal) > 0.009) {
        throw new Error(
          `Recurring shares are per cycle and must add up to $${perCycleTotal.toFixed(2)} (Total USD ÷ ${cycleCount.toString()} cycles).`,
        );
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
      setRecurringCreateMessageTone("neutral");
      setRecurringCreateMessage(`Created tab #${result.tabId.toString()} at ${shortAddress(result.tabAddress)}.`);
      await refreshRecurringTab(result.tabAddress);
      await refreshRecurringTabsForWallet(wallet.account);
    } catch (caught) {
      setRecurringState("error");
      setRecurringCreateMessageTone("error");
      setRecurringCreateMessage(errorMessage(caught));
    }
  }

  async function refreshRecurringTab(address = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput)) {
    if (!address) {
      setRecurringState("error");
      setRecurringMessage("Enter a tab contract address.");
      return;
    }

    try {
      setRecurringState("working");
      setRecurringMessage("Loading tab state from Arc.");
      const state = await readRecurringTab(address);
      const events = await readRecurringEvents(address).catch(() => []);
      setActiveTabAddress(address);
      setTabAddressInput(address);
      setTabState(state);
      setTabEvents(events);
      setRecurringState("idle");
      setRecurringMessage(`Loaded ${shortAddress(address)}.`);
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function refreshRecurringTabsForWallet(account = recurringWallet?.account) {
    if (!account) {
      return;
    }

    try {
      setRecurringState("working");
      setRecurringMessage("Refreshing recurring tabs.");
      const tabs = await readRecurringTabsForWallet(account);
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
      setRecurringState("idle");
      setRecurringMessage(tabs.length > 0 ? "Recurring tabs refreshed." : "No recurring tabs found for this wallet.");
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function selectRecurringTab(address: `0x${string}`) {
    await refreshRecurringTab(address);
  }

  async function authorizeActiveTab() {
    const wallet = recurringWallet ?? (await connectRecurring());
    const tabAddress = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput);

    if (!wallet || !tabAddress) {
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
      await refreshRecurringTab(tabAddress);
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function revokeActiveTab() {
    const wallet = recurringWallet ?? (await connectRecurring());
    const tabAddress = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput);

    if (!wallet || !tabAddress) {
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
      await refreshRecurringTab(tabAddress);
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  async function claimActiveRecurringFunds() {
    const wallet = recurringWallet ?? (await connectRecurring());
    const tabAddress = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput);

    if (!wallet || !tabAddress) {
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
      await refreshRecurringTab(tabAddress);
      await refreshRecurringTabsForWallet(wallet.account);
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
    }
  }

  function updateRecurringMember(id: string, field: keyof RecurringMemberInput, value: string) {
    setRecurringMembers((current) =>
      current.map((member) => (member.id === id ? { ...member, [field]: value } : member)),
    );
  }

  function addRecurringMember() {
    setRecurringMembers((current) => [
      ...current,
      { id: `rec-member-${Date.now()}`, address: "", share: "0.00" },
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
              <div aria-label="Splitsy" className="brand-lockup">
                <span className="logo-crop logo-crop-app">
                  <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
                </span>
              </div>
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
                <Link className="tab-button" href="/docs">
                  <BookOpen size={16} />
                  Docs
                </Link>
              </div>
              <div className="flex flex-nowrap items-center gap-2">
                <XSignInButton />
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
            <XDebtsPanel />
            {billWallet ? (
              <DebtWorkspace
                arcUsdcBalance={arcUsdcBalance}
                arcUsdcBalanceFlash={arcUsdcBalanceFlash}
                bridgeForDebt={bridgeForDebt}
                bridgeResults={bridgeResults}
                billState={billState}
                claimAmounts={claimAmounts}
                claimMessage={claimMessage}
                claimMessageTone={claimMessageTone}
                claimSplitterFunds={claimSplitterFunds}
                debts={debts}
                partialPayments={partialPayments}
                payDebtOnArc={payDebtOnArc}
                debtMessages={debtMessages}
                refreshBillRegistry={() => refreshBillRegistry()}
                setClaimAmounts={setClaimAmounts}
                setPartialPayments={setPartialPayments}
                splitterBills={splitterBills}
              />
            ) : null}

            <div className="space-y-5">
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
                        <div className="flex flex-wrap gap-2">
                          <div className="segmented-control">
                            <ModeButton active={splitBy === "address"} onClick={() => chooseSplitBy("address")}>
                              Wallet
                            </ModeButton>
                            <ModeButton active={splitBy === "handle"} onClick={() => chooseSplitBy("handle")}>
                              <span className="inline-flex items-center gap-1">
                                <Image src="/x.png" alt="" width={12} height={12} />
                                handle
                              </span>
                            </ModeButton>
                          </div>
                          <div className="segmented-control">
                            <ModeButton active={splitMode === "equal"} onClick={() => setSplitMode("equal")}>
                              Equal
                            </ModeButton>
                            <ModeButton active={splitMode === "manual"} onClick={() => setSplitMode("manual")}>
                              Manual
                            </ModeButton>
                          </div>
                        </div>
                      }
                    >
                <div className="route-strip text-sm">
                  <div>
                    <p className="font-semibold text-[var(--text)]">
                      {splitBy === "handle" ? "Off-chain bill" : "Bill registry"}
                    </p>
                    <p className="mt-1 text-[var(--text-muted)]">
                      {splitBy === "handle"
                        ? "Tag payers by @handle; they settle after signing in with X."
                        : "Debt is discovered by wallet address."}
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
                    <Message tone={billState === "error" ? "error" : "neutral"}>{billMessage}</Message>
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
                          {splitBy === "handle" ? (
                            <XHandleField
                              value={participant.walletAddress}
                              onChange={(value) => updateParticipant(participant.id, "walletAddress", value)}
                            />
                          ) : (
                            <Field
                              label="Wallet"
                              value={participant.walletAddress}
                              onChange={(value) => updateParticipant(participant.id, "walletAddress", value)}
                            />
                          )}
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

                        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                          <span className="amount-text font-semibold">${participant.amountUsd.toFixed(2)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-2">
                    <button className="secondary-button" onClick={addParticipant} type="button">
                      <Plus size={16} />
                      Add payer
                    </button>
                    <button
                      className="primary-button"
                      disabled={billState === "working" || billState === "connecting"}
                      onClick={splitBy === "handle" ? submitBillOffchain : submitBillOnchain}
                      type="button"
                    >
                      {billState === "working" ? <Loader2 className="animate-spin" size={16} /> : <Landmark size={16} />}
                      {splitBy === "handle" ? "Create bill" : "Write on Arc"}
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
        ) : (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            key="history"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <XHistoryPanel />
            <HistoryWorkspace debts={debts} splitterBills={splitterBills} hasWallet={Boolean(billWallet)} />
          </motion.div>
        )}
        </AnimatePresence>
      </section>

      {progressFlow ? <ProgressModal flow={progressFlow} onClose={closeFlow} /> : null}
      <XAuthControl />
    </main>
  );
}

function DebtWorkspace({
  bridgeForDebt,
  bridgeResults,
  billState,
  arcUsdcBalance,
  arcUsdcBalanceFlash,
  claimAmounts,
  claimMessage,
  claimMessageTone,
  claimSplitterFunds,
  debts,
  debtMessages,
  partialPayments,
  payDebtOnArc,
  refreshBillRegistry,
  setClaimAmounts,
  setPartialPayments,
  splitterBills,
}: {
  bridgeForDebt: (debt: BillSplitDebt, debtSourceChain: BridgeSourceChain) => void;
  bridgeResults: Record<string, BridgeSummary>;
  billState: BillRunState;
  arcUsdcBalance: bigint | null;
  arcUsdcBalanceFlash: boolean;
  claimAmounts: Record<string, string>;
  claimMessage: string;
  claimMessageTone: "error" | "neutral";
  claimSplitterFunds: (debt: BillSplitDebt) => void;
  debts: BillSplitDebt[];
  debtMessages: Record<string, { message: string; tone: "error" | "neutral" }>;
  partialPayments: Record<string, string>;
  payDebtOnArc: (debt: BillSplitDebt) => void;
  refreshBillRegistry: () => void;
  setClaimAmounts: (value: Record<string, string>) => void;
  setPartialPayments: (value: Record<string, string>) => void;
  splitterBills: BillSplitDebt[];
}) {
  const activeDebts = debts.filter((debt) => debt.remaining > 0n);
  const claimableBills = splitterBills.filter((debt) => debt.claimable > 0n);
  const [fallbackBridgeChains, setFallbackBridgeChains] = useState<Record<string, BridgeSourceChain>>({});
  const debtAlertRef = useRef<HTMLDivElement | null>(null);
  const claimRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activeDebts.length === 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      debtAlertRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [activeDebts.length]);

  useEffect(() => {
    if (claimableBills.length === 0 || activeDebts.length > 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      claimRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [claimableBills.length, activeDebts.length]);

  return (
    <div className="space-y-5">
      {activeDebts.length > 0 ? (
        <div ref={debtAlertRef} className="debt-alert p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-[var(--accent)]">Action needed</p>
              <h3 className="mt-1 text-[clamp(1.35rem,3vw,2.2rem)] font-semibold leading-tight">
                You have {activeDebts.length} unpaid bill{activeDebts.length === 1 ? "" : "s"}
              </h3>
              <p className="mt-2 text-sm text-[var(--text-muted)]">
                Settle directly on Arc, or bridge USDC through CCTP V2 and then pay the registered debt.
              </p>
            </div>
            <button className="secondary-button" onClick={refreshBillRegistry} type="button">
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {activeDebts.map((debt) => {
              const key = debt.billId.toString();
              const bridgeResult = bridgeResults[key];
              const debtMessage = debtMessages[key];

              return (
                <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] p-3" key={key}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-semibold">Bill #{key}</p>
                      <p className="mt-1 text-sm text-[var(--text-muted)]">
                        Owed <span className="amount-text">${billUnitsToUsdc(debt.owed)}</span> · paid{" "}
                        <span className="amount-text">${billUnitsToUsdc(debt.paid)}</span>
                      </p>
                      <p className="mt-1 break-all text-xs text-[var(--text-muted)]">
                        Splitter {debt.splitter}
                      </p>
                    </div>
                    <Metric label="Remaining" value={`$${billUnitsToUsdc(debt.remaining)}`} />
                  </div>

                  <div className="mt-3">
                    <Field
                      label="Payment amount"
                      type="number"
                      value={partialPayments[key] ?? billUnitsToUsdc(debt.remaining)}
                      onChange={(value) => setPartialPayments({ ...partialPayments, [key]: value })}
                    />
                  </div>

                  {debtMessage ? (
                    <div className="mt-3">
                      <Message tone={debtMessage.tone}>{debtMessage.message}</Message>
                    </div>
                  ) : null}

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

                  <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-semibold text-[var(--text)]">Pay on Arc</p>
                        <p className="mt-1 text-[var(--text-muted)]">Use this after your USDC is already on Arc Testnet.</p>
                      </div>
                      <div className="flex flex-col items-stretch gap-1 sm:items-end">
                        <button
                          className="chain-button chain-button-active sm:min-w-44"
                          disabled={billState === "working"}
                          onClick={() => payDebtOnArc(debt)}
                          type="button"
                        >
                          Pay on Arc Testnet
                        </button>
                        <p className="text-xs text-[var(--text-muted)] sm:text-right">
                          Balance:{" "}
                          <span className={`amount-text${arcUsdcBalanceFlash ? " balance-flash" : ""}`}>
                            ${arcUsdcBalance === null ? "—" : billUnitsToUsdc(arcUsdcBalance)}
                          </span>{" "}
                          USDC on Arc Testnet
                        </p>
                      </div>
                    </div>

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
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {claimableBills.length > 0 ? (
        <div ref={claimRef}>
        <Panel title="Claim funds" icon={<BadgeDollarSign size={19} />}>
          {claimMessage ? (
            <div className="mb-4">
              <Message tone={claimMessageTone}>{claimMessage}</Message>
            </div>
          ) : null}
          <div className="space-y-3">
            {claimableBills.map((debt) => {
              const key = debt.billId.toString();
              return (
                <div className="relative grid gap-3 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] p-3 sm:grid-cols-[1fr_0.4fr_auto] sm:items-end" key={key}>
                  <div>
                    <p className="font-semibold">Bill #{key}</p>
                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                      Paid <span className="amount-text">${billUnitsToUsdc(debt.totalPaid)}</span> · claimed{" "}
                      <span className="amount-text">${billUnitsToUsdc(debt.claimed)}</span>
                    </p>
                    <p className="mt-2 text-xs text-[var(--text-muted)]">
                      Claim pulls paid USDC from the registry to your Arc wallet.
                    </p>
                  </div>
                  <Field
                    label="Claim"
                    type="number"
                    value={claimAmounts[key] ?? billUnitsToUsdc(debt.claimable)}
                    onChange={(value) => setClaimAmounts({ ...claimAmounts, [key]: value })}
                  />
                  <button className="primary-button h-11" onClick={() => claimSplitterFunds(debt)} type="button">
                    Claim on Arc
                  </button>
                </div>
              );
            })}
          </div>
        </Panel>
        </div>
      ) : null}
    </div>
  );
}

function HistoryWorkspace({
  debts,
  splitterBills,
  hasWallet,
}: {
  debts: BillSplitDebt[];
  splitterBills: BillSplitDebt[];
  hasWallet: boolean;
}) {
  const paidDebts = debts.filter((debt) => debt.remaining <= 0n);
  // Creditor POV: bills this wallet split that debtors haven't fully paid yet.
  const pendingBills = splitterBills.filter((debt) => debt.totalPaid < debt.totalOwed);
  const claimedBills = splitterBills.filter((debt) => debt.claimable <= 0n && debt.claimed > 0n);
  const isEmpty = paidDebts.length === 0 && pendingBills.length === 0 && claimedBills.length === 0;

  return (
    <div className="space-y-5">
      <Panel title="History" icon={<BadgeDollarSign size={19} />}>
        {!hasWallet ? (
          <p className="text-sm text-[var(--text-muted)]">
            Connect your wallet to see your bill history.
          </p>
        ) : isEmpty ? (
          <p className="text-sm text-[var(--text-muted)]">
            No bill history yet. Bills you split, settle, or claim will appear here as records.
          </p>
        ) : (
          <div className="space-y-6">
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
                        key={debt.billId.toString()}
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
                      key={debt.billId.toString()}
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
                      key={debt.billId.toString()}
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
          </div>
        )}
      </Panel>
    </div>
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
  const key = debt.billId.toString();
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    data?: BillActivity;
  }>({ status: "idle" });

  async function toggle() {
    const next = !open;
    setOpen(next);

    if (next && activity.status === "idle") {
      setActivity({ status: "loading" });
      try {
        const data = await readBillActivity(debt.billId);
        setActivity({ status: "ready", data });
      } catch {
        setActivity({ status: "error" });
      }
    }
  }

  // Distinct debtor wallets: prefer the actual payers from chain activity, and
  // fall back to the bill's registered participant list before any payment.
  const data = activity.data;
  const debtorWallets = (() => {
    const payers = data ? data.payments.map((payment) => payment.payer) : [];
    const source = payers.length > 0 ? payers : [...debt.participantList];
    return [...new Set(source.map((address) => getAddress(address)))];
  })();

  return (
    <div className="history-record" data-open={open}>
      <button className="history-record-toggle" onClick={toggle} type="button" aria-expanded={open}>
        <span className="min-w-0">
          <span className="block font-semibold">Bill #{key}</span>
          <span className="mt-1 block text-sm text-[var(--text-muted)]">{summary}</span>
        </span>
        <span className="history-record-badge">
          {badge}
          <ChevronDown className="history-chevron" size={18} />
        </span>
      </button>

      {open ? (
        <div className="history-detail">
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
        </div>
      ) : null}
    </div>
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
  recurringCreateMessageTone: "error" | "neutral";
  recurringCycleCount: string;
  recurringCycle: RecurringCycle;
  recurringMessage: string;
  recurringShareUsd: number;
  recurringSplitMode: "equal" | "manual";
  recurringState: RecurringRunState;
  recurringTotalUsd: string;
  recurringWallet: RecurringWallet | null;
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
  updateRecurringMember: (id: string, field: keyof RecurringMemberInput, value: string) => void;
  walletTabs: RecurringTabState[];
}) {
  const isRecipient =
    Boolean(recurringWallet && tabState?.recipient.toLowerCase() === recurringWallet.account.toLowerCase());
  const visibleMembers =
    !recurringWallet || !tabState || isRecipient
      ? tabState?.members ?? []
      : tabState.members.filter((member) => member.address.toLowerCase() === recurringWallet.account.toLowerCase());
  const debtorShare = tabState?.members.find(
    (member) => recurringWallet && member.address.toLowerCase() === recurringWallet.account.toLowerCase(),
  )?.fixedShare;
  const approvalPlaceholder = debtorShare
    ? unitsToUsdc(
        tabState?.members.find(
          (member) => recurringWallet && member.address.toLowerCase() === recurringWallet.account.toLowerCase(),
        )?.dueNow ?? debtorShare * (tabState ? tabState.remainingCycles : 1n),
      )
    : authorizationAmount;
  const dueAmount = tabState?.members.reduce((sum, member) => sum + member.dueNow, 0n) ?? 0n;
  const activeTabComplete = Boolean(tabState && tabState.settlementCount >= tabState.maxSettlements);
  const showRecurringDetails = Boolean(recurringWallet && (walletTabs.length > 0 || tabState));
  const recurringTabPaidForWallet = (tab: RecurringTabState) => {
    if (!recurringWallet) {
      return tab.members.every((member) => member.totalSettled >= member.fixedShare * tab.maxSettlements);
    }

    const debtor = tab.members.find((member) => member.address.toLowerCase() === recurringWallet.account.toLowerCase());
    if (debtor) {
      return debtor.totalSettled >= debtor.fixedShare * tab.maxSettlements;
    }

    return tab.members.every((member) => member.totalSettled >= member.fixedShare * tab.maxSettlements);
  };

  const [selectedBridgeChain, setSelectedBridgeChain] = useState<BridgeSourceChain | null>(null);
  const [showBridge, setShowBridge] = useState(false);

  // Each member's share is per cycle, so the whole schedule collects
  // share x members x cycles. Surface the per-cycle total so the Total USD field
  // reads as the full amount across every cycle, not the per-cycle charge.
  const parsedCycleCount = Math.floor(Number(recurringCycleCount));
  const cyclesValid = Number.isFinite(parsedCycleCount) && parsedCycleCount >= 1;
  const createCycleCount = cyclesValid ? parsedCycleCount : 1;
  const customDaysNum = Number(customCycleDays);
  const customDaysValid = recurringCycle !== "custom" || (Number.isInteger(customDaysNum) && customDaysNum >= 1);
  const scheduleValid = cyclesValid && customDaysValid;
  const perCycleTotalUsd = recurringShareUsd * displayRecurringMembers.length;

  return (
    <div className={`grid gap-5 ${showRecurringDetails ? "lg:grid-cols-[0.9fr_1.1fr]" : "lg:grid-cols-1"}`}>
      <div className="space-y-5">
        <Panel title="Create recurring tab" icon={<Landmark size={19} />}>
          <div className="space-y-3">
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--text-muted)]">
              The connected creator wallet receives each recurring settlement.
            </div>
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
                <Field
                  label="Member wallet"
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
          <Panel title="Your recurring tabs" icon={<RefreshCw size={19} />}>
            <div className="flex flex-wrap gap-2">
              <button className="secondary-button" disabled={!recurringWallet} onClick={refreshRecurringTabsForWallet} type="button">
                <RefreshCw size={16} />
                Refresh tabs
              </button>
            </div>
            {recurringMessage ? (
              <div className="mt-4">
                <Message tone={recurringState === "error" ? "error" : "neutral"}>{recurringMessage}</Message>
              </div>
            ) : null}
            <div className="mt-4 space-y-2">
              {walletTabs.map((tab) => (
                <button
                  className={`w-full rounded-[var(--radius)] border p-3 text-left text-sm transition hover:bg-[var(--surface-muted)] ${
                    tabState?.address === tab.address ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] bg-[var(--surface-strong)]"
                  }`}
                  key={tab.address}
                  onClick={() => selectRecurringTab(tab.address)}
                  type="button"
                >
                  <span className="block font-semibold text-[var(--text)]">{shortAddress(tab.address)}</span>
                  <span className="mt-1 block text-[var(--text-muted)]">
                    {recurringWallet && tab.members.some((member) => member.address.toLowerCase() === recurringWallet.account.toLowerCase())
                      ? "You are a payer"
                      : "You receive settlement"}{" "}
                    ·{" "}
                    {recurringTabPaidForWallet(tab)
                      ? "paid off"
                      : tab.dueCycles > 0n
                        ? `${tab.dueCycles.toString()} due now`
                        : `next ${formatUnix(tab.nextSettlementAt)}`}
                  </span>
                </button>
              ))}
            </div>
          </Panel>
        ) : null}
      </div>

      {showRecurringDetails && tabState ? (
        <div className="space-y-5">
          <>
            <Panel title="Active cycle" icon={<ReceiptText size={19} />}>
              {recurringWallet && visibleMembers.length === 1 && !isRecipient ? (
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
                        {!debtorPaidOff ? (
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
              <Field
                label="Approval limit"
                type="number"
                value={authorizationAmount || approvalPlaceholder}
                onChange={setAuthorizationAmount}
              />
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                {approvalPlaceholder ? `Default: ${approvalPlaceholder} USDC` : "Default updates after you load a tab."}
              </p>
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
                {isRecipient ? (
                  <button
                    className="primary-button"
                    disabled={tabState.claimable <= 0n || recurringState === "working"}
                    onClick={claimActiveRecurringFunds}
                    type="button"
                  >
                    Claim recurring funds (${unitsToUsdc(tabState.claimable)})
                  </button>
                ) : null}
              </div>
            </Panel>

            {tabEvents.length > 0 ? (
              <Panel title="Events" icon={<CheckCircle2 size={19} />}>
                <div className="space-y-2">
                  {tabEvents.slice(0, 5).map((event, index) => (
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
    : succeeded
      ? "Payment settled"
      : flow.status === "error"
        ? "Payment failed"
        : "Settling on Arc";

  const verb = isBridge ? "Moving" : "Paying";
  const destination = isBridge ? "to Arc" : "toward";
  const subtitle =
    flow.status === "error"
      ? flow.errorMessage || "Something went wrong."
      : succeeded
        ? isBridge
          ? `$${flow.amountLabel} USDC has arrived on your Arc wallet ${flow.contextLabel}.`
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
                  {isBridge ? "Keep this open until the bridge finishes" : "Confirm each step in your wallet"}
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

function PaidBillStamp({
  compact = false,
  src = "/paid.png",
  alt = "Paid",
  width = 1024,
  height = 788,
}: {
  compact?: boolean;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
}) {
  return (
    <div className={`paid-bill-stamp ${compact ? "paid-bill-stamp-compact" : ""}`} aria-hidden="true">
      <Image alt={alt} height={height} priority src={src} width={width} />
    </div>
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

// @handle field with a live X avatar. As a valid handle is typed we hit
// unavatar.io (a free avatar CDN) with fallback=false, so the <img> only shows
// once it resolves to a real account — a typo 404s and the avatar stays hidden,
// which is the "your handle became real" confirmation. Debounced so we don't
// fetch on every keystroke. The bare handle is stored (leading @ stripped); the
// server lowercases it before matching, so this doesn't affect debt linking.
function XHandleField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const handle = value.replace(/^@+/, "").trim();
  const valid = /^[a-zA-Z0-9_]{1,15}$/.test(handle);
  const [debounced, setDebounced] = useState(handle);
  const [avatarOk, setAvatarOk] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(handle), 400);
    return () => clearTimeout(timer);
  }, [handle]);

  const src = valid && debounced ? `https://unavatar.io/x/${debounced.toLowerCase()}?fallback=false` : "";
  // A new handle hasn't resolved yet — fade the old avatar out until onLoad fires.
  useEffect(() => setAvatarOk(false), [src]);

  return (
    <label className="block text-sm font-medium text-[var(--text-soft)]">
      <span className="inline-flex items-center gap-1">
        <Image src="/x.png" alt="" width={12} height={12} />
        X handle
      </span>
      <span className="handle-field">
        <span aria-hidden="true" className="handle-at">@</span>
        <input
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          className="field-control handle-input"
          onChange={(event) => onChange(event.target.value.replace(/^@+/, ""))}
          placeholder="username"
          spellCheck={false}
          value={handle}
        />
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote unavatar URL, not a bundled asset
          <img
            alt={`@${debounced} on X`}
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

function Message({ tone, children }: { tone: "error" | "neutral"; children: ReactNode }) {
  return (
    <div className={`message ${tone === "error" ? "message-error" : "message-neutral"}`}>
      {tone === "error" ? <AlertTriangle className="mt-0.5 shrink-0" size={17} /> : <CheckCircle2 className="mt-0.5 shrink-0" size={17} />}
      {children}
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
