"use client";

import {
  AlertTriangle,
  BadgeDollarSign,
  Camera,
  CheckCircle2,
  ExternalLink,
  FileJson,
  Landmark,
  Loader2,
  Moon,
  Plus,
  ReceiptText,
  RefreshCw,
  Sun,
  Trash2,
  Upload,
  WalletCards,
} from "lucide-react";
import { ChangeEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, type EIP1193Provider } from "viem";
import {
  bridgeSourceChains,
  bridgeUsdcToArc,
  BridgeSourceChain,
  BridgeSummary,
  BrowserWalletSession,
  connectBrowserWallet,
} from "@/lib/appkit-bridge";
import {
  approveBillRegistry,
  billMetadataHash,
  BillSplitDebt,
  BillSplitWallet,
  billUnitsToUsdc,
  createBillSplit,
  createBillSplitWallet,
  isBillRegistryConfigured,
  payBillDebtWithMemo,
  readBillsForSplitter,
  readDebtsForWallet,
  usdcToBillUnits,
  claimBillFunds,
} from "@/lib/bill-split-contracts";
import {
  authorizeRecurringPayment,
  approveUsdc,
  createRecurringTab,
  createRecurringWallet,
  readRecurringEvents,
  readRecurringTab,
  RecurringEvent,
  RecurringTabState,
  RecurringWallet,
  settleRecurringTab,
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

type FxQuote = {
  amountUsd: number;
  rate: number;
  source: string;
  asOf: string;
};

type OcrState = "idle" | "reading" | "ready" | "error";
type BillRunState = "idle" | "connecting" | "working" | "success" | "error";
type RecurringRunState = "idle" | "connecting" | "working" | "error" | "success";
type AppTab = "bills" | "recurring";
type RecurringCycle = "weekly" | "monthly" | "custom";
type RecurringMemberInput = {
  id: string;
  address: string;
  share: string;
};

const recurringCycleOptions: Array<{ id: RecurringCycle; label: string; seconds: bigint }> = [
  { id: "weekly", label: "Weekly", seconds: 7n * 24n * 60n * 60n },
  { id: "monthly", label: "Monthly", seconds: 30n * 24n * 60n * 60n },
  { id: "custom", label: "Custom", seconds: 30n * 24n * 60n * 60n },
];

export default function Home() {
  const [activeTab, setActiveTab] = useState<AppTab>("bills");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [error, setError] = useState("");
  const [imagePreview, setImagePreview] = useState("");
  const [bill, setBill] = useState<ParsedBill>({
    ...emptyParsedBill,
    merchant: "Upload a bill",
  });
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  const [creatorAddress, setCreatorAddress] = useState("0xee42a492b183cdff04439f2cb6a9c49f857f70ac");
  const [splitMode, setSplitMode] = useState<"equal" | "manual">("equal");
  const [bridgeSession, setBridgeSession] = useState<BrowserWalletSession | null>(null);
  const [bridgeResults, setBridgeResults] = useState<Record<string, BridgeSummary>>({});
  const [recurringCycle, setRecurringCycle] = useState<RecurringCycle>("monthly");
  const [customCycleDays, setCustomCycleDays] = useState("30");
  const [billWallet, setBillWallet] = useState<BillSplitWallet | null>(null);
  const [billState, setBillState] = useState<BillRunState>("idle");
  const [billMessage, setBillMessage] = useState("");
  const [debtMessage, setDebtMessage] = useState("");
  const [debtMessageTone, setDebtMessageTone] = useState<"error" | "neutral">("neutral");
  const [claimMessage, setClaimMessage] = useState("");
  const [claimMessageTone, setClaimMessageTone] = useState<"error" | "neutral">("neutral");
  const [submittedBillId, setSubmittedBillId] = useState<bigint | null>(null);
  const [debts, setDebts] = useState<BillSplitDebt[]>([]);
  const [splitterBills, setSplitterBills] = useState<BillSplitDebt[]>([]);
  const [partialPayments, setPartialPayments] = useState<Record<string, string>>({});
  const [claimAmounts, setClaimAmounts] = useState<Record<string, string>>({});
  const [recurringWallet, setRecurringWallet] = useState<RecurringWallet | null>(null);
  const [recurringState, setRecurringState] = useState<RecurringRunState>("idle");
  const [recurringMessage, setRecurringMessage] = useState("");
  const [recurringRecipient, setRecurringRecipient] = useState("0xee42a492b183cdff04439f2cb6a9c49f857f70ac");
  const [recurringMembers, setRecurringMembers] = useState<RecurringMemberInput[]>([
    { id: "rec-member-1", address: "0x1111111111111111111111111111111111111111", share: "100.00" },
    { id: "rec-member-2", address: "0x2222222222222222222222222222222222222222", share: "100.00" },
  ]);
  const [tabAddressInput, setTabAddressInput] = useState("");
  const [activeTabAddress, setActiveTabAddress] = useState<`0x${string}` | null>(null);
  const [tabState, setTabState] = useState<RecurringTabState | null>(null);
  const [tabEvents, setTabEvents] = useState<RecurringEvent[]>([]);
  const [authorizationAmount, setAuthorizationAmount] = useState("100.00");
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

  const confirmedUsd = fxQuote?.amountUsd ?? (bill.currency === "USD" ? bill.total : 0);
  const displayParticipants = useMemo(() => {
    return splitMode === "equal" ? equalSplit(confirmedUsd, participants) : participants;
  }, [confirmedUsd, participants, splitMode]);
  const splitTotal = displayParticipants.reduce((sum, participant) => sum + participant.amountUsd, 0);
  const splitDelta = Number((confirmedUsd - splitTotal).toFixed(2));
  const billIsScanned = ocrState === "ready";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
  }

  async function connectBillWallet() {
    const provider = getBrowserProvider();

    if (!provider) {
      setBillState("error");
      setBillMessage("No EVM browser wallet found.");
      return null;
    }

    setBillState("connecting");
    setBillMessage("");

    try {
      const wallet = await createBillSplitWallet(provider);
      setBillWallet(wallet);
      setBillState("idle");
      setBillMessage(`Connected ${shortAddress(wallet.account)} on Arc Testnet.`);
      await refreshBillRegistry(wallet.account);
      return wallet;
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
      return null;
    }
  }

  async function refreshBillRegistry(account = billWallet?.account) {
    if (!account) {
      return;
    }

    try {
      const [nextDebts, nextSplitterBills] = await Promise.all([
        readDebtsForWallet(account),
        readBillsForSplitter(account),
      ]);
      setDebts(nextDebts.filter((debt) => debt.remaining > 0n));
      setSplitterBills(nextSplitterBills);
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
      setDebtMessageTone("error");
      setDebtMessage(errorMessage(caught));
    }
  }

  async function submitBillOnchain() {
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
      setBillMessage("Submitting split bill onchain.");
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
      setBillMessage(`Bill #${result.billId.toString()} submitted. Payers will see it when they connect.`);
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
    }
  }

  async function payDebtOnArc(debt: BillSplitDebt) {
    const wallet = billWallet ?? (await connectBillWallet());

    if (!wallet) {
      return;
    }

    const amount = usdcToBillUnits(partialPayments[debt.billId.toString()] ?? billUnitsToUsdc(debt.remaining));

    if (amount <= 0n || amount > debt.remaining) {
      setBillState("error");
      setDebtMessageTone("error");
      setDebtMessage("Enter an amount up to the remaining debt.");
      return;
    }

    try {
      setBillState("working");
      setDebtMessageTone("neutral");
      setDebtMessage("Approving USDC.");
      await approveBillRegistry({ ...wallet, amount });
      setDebtMessage("Paying debt with transaction memo.");
      await payBillDebtWithMemo({ ...wallet, billId: debt.billId, amount });
      setBillState("success");
      setDebtMessageTone("neutral");
      setDebtMessage(`Paid ${billUnitsToUsdc(amount)} USDC toward bill #${debt.billId.toString()}.`);
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      setDebtMessageTone("error");
      setDebtMessage(errorMessage(caught));
    }
  }

  async function bridgeForDebt(debt: BillSplitDebt, debtSourceChain: BridgeSourceChain) {
    const session = bridgeSession ?? (await connectForBridge());

    if (!session || !billWallet) {
      setBillState("error");
      setDebtMessageTone("error");
      setDebtMessage("Connect your wallet first so bridged USDC can arrive at your Arc address.");
      return;
    }

    const amount = usdcToBillUnits(partialPayments[debt.billId.toString()] ?? billUnitsToUsdc(debt.remaining));

    if (amount <= 0n || amount > debt.remaining) {
      setBillState("error");
      setDebtMessageTone("error");
      setDebtMessage("Enter an amount up to the remaining debt.");
      return;
    }

    try {
      setDebtMessageTone("neutral");
      setDebtMessage(`Bridging ${billUnitsToUsdc(amount)} USDC to your Arc wallet from ${sourceLabel(debtSourceChain)}.`);
      const result = await bridgeUsdcToArc({
        session,
        sourceChain: debtSourceChain,
        recipientAddress: billWallet.account,
        amount: billUnitsToUsdc(amount),
      });
      setBridgeResults((current) => ({ ...current, [debt.billId.toString()]: result }));
      setBillState(result.state === "error" ? "error" : "success");
      setDebtMessageTone(result.state === "error" ? "error" : "neutral");
      setDebtMessage(
        result.state === "error"
          ? "Bridge failed."
          : "USDC bridged to Arc. Pay the registered debt with a memo once funds arrive.",
      );
    } catch (caught) {
      setBillState("error");
      setDebtMessageTone("error");
      setDebtMessage(errorMessage(caught));
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

  function updatePreview(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      setImagePreview("");
      return;
    }

    setImagePreview(URL.createObjectURL(file));
  }

  async function connectForBridge() {
    try {
      const session = await connectBrowserWallet();
      setBridgeSession(session);
      return session;
    } catch (caught) {
      setBillState("error");
      setDebtMessageTone("error");
      setDebtMessage(errorMessage(caught));
      return null;
    }
  }

  async function connectRecurring() {
    const provider = getBrowserProvider();

    if (!provider) {
      setRecurringState("error");
      setRecurringMessage("No EVM browser wallet found.");
      return null;
    }

    setRecurringState("connecting");
    setRecurringMessage("");

    try {
      const wallet = await createRecurringWallet(provider);
      setRecurringWallet(wallet);
      setRecurringState("idle");
      setRecurringMessage(`Connected ${shortAddress(wallet.account)} on Arc Testnet.`);
      return wallet;
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
      return null;
    }
  }

  async function createOnchainTab() {
    const wallet = recurringWallet ?? (await connectRecurring());

    if (!wallet) {
      return;
    }

    try {
      setRecurringState("working");
      setRecurringMessage("Creating recurring tab on Arc Testnet.");
      const members = recurringMembers.map((member) => normalizeAddress(member.address));
      const shares = recurringMembers.map((member) => usdcToUnits(member.share));
      const intervalSeconds =
        recurringCycle === "custom" ? BigInt(Math.max(1, Number(customCycleDays) || 1)) * 24n * 60n * 60n : recurringCycleOptions.find((option) => option.id === recurringCycle)?.seconds ?? 30n * 24n * 60n * 60n;
      const result = await createRecurringTab({
        ...wallet,
        recipient: normalizeAddress(recurringRecipient),
        intervalSeconds,
        members,
        fixedShares: shares,
      });

      setTabAddressInput(result.tabAddress);
      setActiveTabAddress(result.tabAddress);
      setRecurringState("success");
      setRecurringMessage(`Created tab #${result.tabId.toString()} at ${shortAddress(result.tabAddress)}.`);
      await refreshRecurringTab(result.tabAddress);
    } catch (caught) {
      setRecurringState("error");
      setRecurringMessage(errorMessage(caught));
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
      const [state, events] = await Promise.all([readRecurringTab(address), readRecurringEvents(address)]);
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

  async function authorizeActiveTab() {
    const wallet = recurringWallet ?? (await connectRecurring());
    const tabAddress = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput);

    if (!wallet || !tabAddress) {
      setRecurringState("error");
      setRecurringMessage("Connect a wallet and load a tab first.");
      return;
    }

    try {
      const amount = usdcToUnits(authorizationAmount);
      setRecurringState("working");
      setRecurringMessage("Approving the tab to collect from your wallet on cycle dates.");
      await authorizeRecurringPayment({ ...wallet, tabAddress, amount });
      setRecurringState("success");
      setRecurringMessage(`Authorized ${authorizationAmount} USDC. Funds stay in your wallet until settlement.`);
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
      setRecurringMessage("Connect a wallet and load a tab first.");
      return;
    }

    try {
      setRecurringState("working");
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

  async function settleActiveTab() {
    const wallet = recurringWallet ?? (await connectRecurring());
    const tabAddress = activeTabAddress ?? normalizeOptionalAddress(tabAddressInput);

    if (!wallet || !tabAddress) {
      setRecurringState("error");
      setRecurringMessage("Connect a wallet and load a tab first.");
      return;
    }

    try {
      setRecurringState("working");
      setRecurringMessage("Calling settleTab().");
      await settleRecurringTab({ ...wallet, tabAddress });
      setRecurringState("success");
      setRecurringMessage("Settlement transaction confirmed.");
      await refreshRecurringTab(tabAddress);
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
      { id: `rec-member-${Date.now()}`, address: "", share: "100.00" },
    ]);
  }

  function removeRecurringMember(id: string) {
    setRecurringMembers((current) => current.filter((member) => member.id !== id));
  }

  return (
    <main className="app-shell min-h-screen text-[var(--text)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color:var(--header-bg)] backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-[var(--accent)]">SnapSplit</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-normal sm:text-3xl">
                Split bills and collect USDC on Arc
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="segmented-control">
                <TabButton active={activeTab === "bills"} onClick={() => setActiveTab("bills")}>
                  Bills
                </TabButton>
                <TabButton active={activeTab === "recurring"} onClick={() => setActiveTab("recurring")}>
                  Recurring
                </TabButton>
              </div>
              <button
                aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                className="icon-button"
                onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
                type="button"
              >
                {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
              </button>
            </div>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {activeTab === "bills" ? (
          <div className="space-y-5">
            {billWallet ? (
              <DebtWorkspace
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
                debtMessage={debtMessage}
                debtMessageTone={debtMessageTone}
                refreshBillRegistry={() => refreshBillRegistry()}
                setClaimAmounts={setClaimAmounts}
                setPartialPayments={setPartialPayments}
                splitterBills={splitterBills}
              />
            ) : null}

            <div className="grid gap-5 lg:grid-cols-[0.82fr_1.18fr]">
              <div className="space-y-5">
              <Panel title="Upload bill" icon={<Upload size={19} />}>
                <form className="space-y-4" onSubmit={parseBill}>
                  <label className="flex min-h-60 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-muted)] p-4 text-center transition hover:border-[var(--accent)]">
                    {imagePreview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt="Bill preview"
                        className="max-h-72 rounded-md object-contain"
                        src={imagePreview}
                      />
                    ) : (
                      <>
                        <Camera className="text-[var(--accent)]" size={32} />
                        <p className="mt-3 font-semibold">Upload a receipt or bill photo</p>
                        <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">
                          We extract the merchant, totals, tax, tip, and line items for review.
                        </p>
                      </>
                    )}
                    <input accept="image/*" className="sr-only" name="image" onChange={updatePreview} type="file" />
                  </label>

                  {error ? <Message tone="error">{error}</Message> : null}

                  <button className="primary-button w-full" disabled={ocrState === "reading"}>
                    {ocrState === "reading" ? <Loader2 className="animate-spin" size={18} /> : <FileJson size={18} />}
                    Scan bill
                  </button>
                </form>
              </Panel>

              </div>

              <div className="space-y-5">
              <Panel title="Review bill" icon={<ReceiptText size={19} />}>
                {billIsScanned ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Merchant" value={bill.merchant} onChange={(value) => updateBillField("merchant", value)} />
                    <Field label="Currency" value={bill.currency} onChange={(value) => updateBillField("currency", value)} />
                    <Field label="Subtotal" type="number" value={String(bill.subtotal)} onChange={(value) => updateBillField("subtotal", value)} />
                    <Field label="Tax" type="number" value={String(bill.tax)} onChange={(value) => updateBillField("tax", value)} />
                    <Field label="Tip" type="number" value={String(bill.tip)} onChange={(value) => updateBillField("tip", value)} />
                    <Field label="Total" type="number" value={String(bill.total)} onChange={(value) => updateBillField("total", value)} />
                  </div>
                ) : (
                  <Field label="Total" type="number" value={String(bill.total)} onChange={(value) => updateBillField("total", value)} />
                )}

                {billIsScanned && bill.lineItems.length > 0 ? (
                  <div className="mt-4 overflow-hidden rounded-md border border-[var(--border)]">
                    {bill.lineItems.map((item, index) => (
                      <div className="grid gap-2 border-b border-[var(--border)] p-3 last:border-b-0 sm:grid-cols-[1fr_auto]" key={`${item.description}-${index}`}>
                        <p className="text-sm font-medium">{item.description}</p>
                        <p className="text-sm font-semibold">${item.amount.toFixed(2)}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Panel>

              <Panel
                title="Submit split bill"
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
                <div className="grid gap-3">
                  <Field label="Arc recipient" value={creatorAddress} onChange={setCreatorAddress} />
                </div>

                <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--text-muted)]">
                  Each payer will discover their debt automatically after connecting the matching wallet.
                </div>

                {billMessage ? (
                  <div className="mt-4">
                    <Message tone={billState === "error" ? "error" : "neutral"}>{billMessage}</Message>
                  </div>
                ) : null}

                <div className="mt-4 divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                  {displayParticipants.map((participant) => {
                    return (
                      <div className="p-3" key={participant.id}>
                        <div className="grid gap-3 md:grid-cols-[0.48fr_1fr_0.32fr_auto] md:items-end">
                          <Field
                            label="Name"
                            value={participant.label}
                            onChange={(value) => updateParticipant(participant.id, "label", value)}
                          />
                          <Field
                            label="Wallet"
                            value={participant.walletAddress}
                            onChange={(value) => updateParticipant(participant.id, "walletAddress", value)}
                          />
                          <Field
                            disabled={splitMode === "equal"}
                            label="Share"
                            type="number"
                            value={participant.amountUsd.toFixed(2)}
                            onChange={(value) => updateParticipant(participant.id, "amountUsd", value)}
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
                          <span className="text-sm text-[var(--text-muted)]">Registered debt recipient</span>
                          <span className="font-semibold">${participant.amountUsd.toFixed(2)}</span>
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
                    <button className="secondary-button" onClick={connectBillWallet} type="button">
                      <WalletCards size={16} />
                      {billWallet ? "Wallet connected" : "Connect wallet"}
                    </button>
                    <button
                      className="primary-button"
                      disabled={billState === "working" || billState === "connecting"}
                      onClick={submitBillOnchain}
                      type="button"
                    >
                      {billState === "working" ? <Loader2 className="animate-spin" size={16} /> : <Landmark size={16} />}
                      Submit onchain
                    </button>
                  </div>
                  <div className="text-sm text-[var(--text-muted)]">
                    Split total <span className="font-semibold text-[var(--text)]">${splitTotal.toFixed(2)}</span>
                    {Math.abs(splitDelta) > 0.009 ? (
                      <span className="ml-2 text-[var(--warning-text)]">delta ${splitDelta.toFixed(2)}</span>
                    ) : null}
                  </div>
                </div>
                {submittedBillId ? (
                  <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--text-muted)]">
                    Bill #{submittedBillId.toString()} is live on Arc. Debtors see it automatically when they connect the matching wallet.
                  </div>
                ) : null}
              </Panel>

              </div>
            </div>
          </div>
        ) : (
          <RecurringWorkspace
            addRecurringMember={addRecurringMember}
            authorizationAmount={authorizationAmount}
            authorizeActiveTab={authorizeActiveTab}
            connectRecurring={connectRecurring}
            createOnchainTab={createOnchainTab}
            customCycleDays={customCycleDays}
            refreshRecurringTab={refreshRecurringTab}
            recurringCycle={recurringCycle}
            recurringMembers={recurringMembers}
            recurringMessage={recurringMessage}
            recurringRecipient={recurringRecipient}
            recurringState={recurringState}
            recurringWallet={recurringWallet}
            removeRecurringMember={removeRecurringMember}
            revokeActiveTab={revokeActiveTab}
            setCustomCycleDays={setCustomCycleDays}
            setAuthorizationAmount={setAuthorizationAmount}
            setRecurringCycle={setRecurringCycle}
            setRecurringRecipient={setRecurringRecipient}
            setTabAddressInput={setTabAddressInput}
            settleActiveTab={settleActiveTab}
            tabAddressInput={tabAddressInput}
            tabEvents={tabEvents}
            tabState={tabState}
            updateRecurringMember={updateRecurringMember}
          />
        )}
      </section>
    </main>
  );
}

function DebtWorkspace({
  bridgeForDebt,
  bridgeResults,
  billState,
  claimAmounts,
  claimMessage,
  claimMessageTone,
  claimSplitterFunds,
  debts,
  debtMessage,
  debtMessageTone,
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
  claimAmounts: Record<string, string>;
  claimMessage: string;
  claimMessageTone: "error" | "neutral";
  claimSplitterFunds: (debt: BillSplitDebt) => void;
  debts: BillSplitDebt[];
  debtMessage: string;
  debtMessageTone: "error" | "neutral";
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
              <p className="text-sm font-semibold text-[var(--accent)]">Unpaid debt</p>
              <h3 className="mt-1 text-xl font-semibold">
                You have {activeDebts.length} unpaid bill{activeDebts.length === 1 ? "" : "s"}
              </h3>
            </div>
            <button className="secondary-button" onClick={refreshBillRegistry} type="button">
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>

          {debtMessage ? (
            <div className="mt-4">
              <Message tone={debtMessageTone}>{debtMessage}</Message>
            </div>
          ) : null}

          <div className="mt-4 space-y-3">
            {activeDebts.map((debt) => {
              const key = debt.billId.toString();
              const bridgeResult = bridgeResults[key];

              return (
                <div className="rounded-md border border-[var(--border)] bg-[var(--surface-strong)] p-3" key={key}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-semibold">Bill #{key}</p>
                      <p className="mt-1 text-sm text-[var(--text-muted)]">
                        Owed ${billUnitsToUsdc(debt.owed)} · paid ${billUnitsToUsdc(debt.paid)}
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

                  <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm">
                    <p className="font-semibold text-[var(--text)]">Pay from</p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <button
                        className="chain-button chain-button-active"
                        disabled={billState === "working"}
                        onClick={() => payDebtOnArc(debt)}
                        type="button"
                      >
                        Arc Testnet
                      </button>
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
                          {chain.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {bridgeResult?.explorerUrls.length ? (
                    <div className="mt-3 rounded-md bg-[var(--surface-muted)] p-3 text-sm">
                      <p className="font-semibold">Bridge proofs</p>
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

      <div ref={claimRef}>
      <Panel title="Claim funds" icon={<BadgeDollarSign size={19} />}>
        {claimMessage ? (
          <div className="mb-4">
            <Message tone={claimMessageTone}>{claimMessage}</Message>
          </div>
        ) : null}
        {claimableBills.length > 0 ? (
          <div className="space-y-3">
            {claimableBills.map((debt) => {
              const key = debt.billId.toString();
              return (
                <div className="grid gap-3 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[1fr_0.4fr_auto] sm:items-end" key={key}>
                  <div>
                    <p className="font-semibold">Bill #{key}</p>
                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                      Paid ${billUnitsToUsdc(debt.totalPaid)} · claimed ${billUnitsToUsdc(debt.claimed)}
                    </p>
                  </div>
                  <Field
                    label="Claim"
                    type="number"
                    value={claimAmounts[key] ?? billUnitsToUsdc(debt.claimable)}
                    onChange={(value) => setClaimAmounts({ ...claimAmounts, [key]: value })}
                  />
                  <button className="primary-button h-11" onClick={() => claimSplitterFunds(debt)} type="button">
                    Claim
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">No claimable funds for the connected splitter wallet.</p>
        )}
      </Panel>
      </div>
    </div>
  );
}

function RecurringWorkspace({
  addRecurringMember,
  authorizationAmount,
  authorizeActiveTab,
  connectRecurring,
  createOnchainTab,
  customCycleDays,
  refreshRecurringTab,
  recurringCycle,
  recurringMembers,
  recurringMessage,
  recurringRecipient,
  recurringState,
  recurringWallet,
  removeRecurringMember,
  revokeActiveTab,
  setCustomCycleDays,
  setAuthorizationAmount,
  setRecurringCycle,
  setRecurringRecipient,
  setTabAddressInput,
  settleActiveTab,
  tabAddressInput,
  tabEvents,
  tabState,
  updateRecurringMember,
}: {
  addRecurringMember: () => void;
  authorizationAmount: string;
  authorizeActiveTab: () => void;
  connectRecurring: () => Promise<RecurringWallet | null>;
  createOnchainTab: () => void;
  customCycleDays: string;
  refreshRecurringTab: () => void;
  recurringCycle: RecurringCycle;
  recurringMembers: RecurringMemberInput[];
  recurringMessage: string;
  recurringRecipient: string;
  recurringState: RecurringRunState;
  recurringWallet: RecurringWallet | null;
  removeRecurringMember: (id: string) => void;
  revokeActiveTab: () => void;
  setCustomCycleDays: (value: string) => void;
  setAuthorizationAmount: (value: string) => void;
  setRecurringCycle: (value: RecurringCycle) => void;
  setRecurringRecipient: (value: string) => void;
  setTabAddressInput: (value: string) => void;
  settleActiveTab: () => void;
  tabAddressInput: string;
  tabEvents: RecurringEvent[];
  tabState: RecurringTabState | null;
  updateRecurringMember: (id: string, field: keyof RecurringMemberInput, value: string) => void;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-5">
        <Panel title="Create tab" icon={<Landmark size={19} />}>
          <div className="space-y-3">
            <Field label="Recipient" value={recurringRecipient} onChange={setRecurringRecipient} />
            <div className="grid gap-3 sm:grid-cols-[1fr_0.5fr]">
              <label className="block text-sm font-medium text-[var(--text-soft)]">
                Cycle
                <select
                  className="field-control"
                  onChange={(event) => setRecurringCycle(event.target.value as RecurringCycle)}
                  value={recurringCycle}
                >
                  {recurringCycleOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                disabled={recurringCycle !== "custom"}
                label="Custom days"
                type="number"
                value={customCycleDays}
                onChange={setCustomCycleDays}
              />
            </div>
            {recurringMembers.map((member) => (
              <div className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[1fr_0.35fr_auto] sm:items-end" key={member.id}>
                <Field
                  label="Member wallet"
                  value={member.address}
                  onChange={(value) => updateRecurringMember(member.id, "address", value)}
                />
                <Field
                  label="Share"
                  type="number"
                  value={member.share}
                  onChange={(value) => updateRecurringMember(member.id, "share", value)}
                />
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
            <button className="secondary-button" onClick={connectRecurring} type="button">
              <WalletCards size={16} />
              {recurringWallet ? "Wallet connected" : "Connect wallet"}
            </button>
            <button className="primary-button" disabled={recurringState === "working"} onClick={createOnchainTab} type="button">
              {recurringState === "working" ? <Loader2 className="animate-spin" size={16} /> : <Landmark size={16} />}
              Create tab
            </button>
          </div>
        </Panel>

        <Panel title="Load tab" icon={<RefreshCw size={19} />}>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Contract address" value={tabAddressInput} onChange={setTabAddressInput} />
            <button className="secondary-button h-11" onClick={refreshRecurringTab} type="button">
              Load
            </button>
          </div>
          {recurringMessage ? (
            <div className="mt-4">
              <Message tone={recurringState === "error" ? "error" : "neutral"}>{recurringMessage}</Message>
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="space-y-5">
        {tabState ? (
          <>
            <Panel title="Tab state" icon={<ReceiptText size={19} />}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Metric label="Recipient" value={shortAddress(tabState.recipient)} />
                <Metric label="Next settlement" value={formatUnix(tabState.nextSettlementAt)} />
              </div>

              <div className="mt-4 divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                {tabState.members.map((member) => (
                  <div className="p-3" key={member.address}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="break-all font-mono text-xs">{member.address}</p>
                      <span className={`status-dot ${member.collectible ? "status-ok" : "status-warn"}`}>
                        {member.collectible ? "ready" : "needs approval"}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Metric label="Share" value={`$${unitsToUsdc(member.fixedShare)}`} />
                      <Metric label="Wallet balance" value={`$${unitsToUsdc(member.walletBalance)}`} />
                      <Metric label="Approved" value={`$${unitsToUsdc(member.allowance)}`} />
                      <Metric label="Collected total" value={`$${unitsToUsdc(member.totalSettled)}`} />
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Actions" icon={<BadgeDollarSign size={19} />}>
              <Field label="Approval limit" type="number" value={authorizationAmount} onChange={setAuthorizationAmount} />
              <p className="mt-3 text-sm text-[var(--text-muted)]">
                Payers approve the tab as a constrained USDC spender. Funds stay in the wallet until a settlement call is due.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="primary-button" onClick={authorizeActiveTab} type="button">
                  Approve collection
                </button>
                <button className="secondary-button" onClick={revokeActiveTab} type="button">
                  Revoke
                </button>
                <button className="secondary-button" onClick={settleActiveTab} type="button">
                  Settle
                </button>
              </div>
            </Panel>

            {tabEvents.length > 0 ? (
              <Panel title="Events" icon={<CheckCircle2 size={19} />}>
                <div className="space-y-2">
                  {tabEvents.slice(0, 8).map((event) => (
                    <a
                      className="block rounded-md border border-[var(--border)] p-3 text-sm hover:bg-[var(--surface-muted)]"
                      href={`https://testnet.arcscan.app/tx/${event.txHash}`}
                      key={`${event.txHash}-${event.name}-${event.blockNumber.toString()}`}
                    >
                      <span className="font-semibold">{event.name}</span>
                      <span className="ml-2 text-[var(--text-muted)]">{event.summary}</span>
                    </a>
                  ))}
                </div>
              </Panel>
            ) : null}
          </>
        ) : (
          <Panel title="No tab loaded" icon={<Landmark size={19} />}>
            <p className="text-sm text-[var(--text-muted)]">Create a tab or load an existing contract to inspect balances and settlement state.</p>
          </Panel>
        )}
      </div>
    </div>
  );
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
  label: string;
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

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "Unexpected wallet or payment error.";
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
    return "Not set";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(value) * 1000));
}

function getBrowserProvider() {
  const ethereum = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  return ethereum ?? null;
}
