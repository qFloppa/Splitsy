import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  BadgeDollarSign,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Code2,
  FileText,
  Landmark,
  LockKeyhole,
  ReceiptText,
  RefreshCw,
  Route,
  ShieldCheck,
  WalletCards,
} from "lucide-react";

const sections = [
  "Overview",
  "Using Splitsy",
  "Bill Splits",
  "Recurring Tabs",
  "Circle and Arc",
  "Architecture",
  "Contracts",
  "Operations",
  "Security",
  "Configuration",
];

const stack = [
  ["Application interface", "A responsive web experience for receipt upload, bill review, split creation, wallet connection, and recurring payment management."],
  ["Typed transaction layer", "Strongly typed contract reads and writes for USDC payments, approvals, event history, and Arc Testnet wallet interactions."],
  ["Solidity contracts", "Bill registry and recurring tab contracts define the accounting rules that keep payments verifiable onchain."],
  ["Circle AppKit", "Browser-wallet USDC bridging into Arc Testnet through Circle bridge capability."],
  ["CCTP", "Native USDC burn-and-mint movement between supported source chains and Arc."],
  ["Settlement automation", "Protected automation checks recurring tabs on a schedule so payers do not need to press a settle button each cycle."],
];

export const metadata = {
  title: "Splitsy Docs",
  description: "User and technical documentation for Splitsy bill splitting, recurring payments, Circle AppKit bridging, and Arc settlement.",
};

export default function DocsPage() {
  return (
    <main className="docs-shell min-h-screen">
      <header className="docs-hero">
        <nav className="docs-topbar" aria-label="Docs navigation">
          <Link href="/" className="docs-brand">
            <span className="logo-crop logo-crop-docs">
              <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
            </span>
          </Link>
          <div className="docs-toplinks">
            <a href="#configuration">Configuration</a>
            <a href="#contracts">Contracts</a>
            <a href="#operations">Operations</a>
            <Link href="/">Open app</Link>
          </div>
        </nav>

        <div className="docs-hero-grid">
          <div>
            <p className="docs-eyebrow">Product documentation</p>
            <h1>Everything users need to understand Splitsy.</h1>
            <p className="docs-lede">
              Splitsy turns shared bills into trackable USDC payment flows. It scans receipts, calculates who owes what, records
              debts on Arc Testnet, lets payers fund and pay from their wallets, and automates recurring collection when a cycle
              becomes due.
            </p>
            <div className="docs-hero-actions">
              <Link href="/" className="docs-primary-link">
                Launch Splitsy <ArrowRight size={16} />
              </Link>
              <a href="#circle-and-arc" className="docs-secondary-link">
                Circle and Arc details
              </a>
            </div>
          </div>

          <aside className="docs-hero-panel" aria-label="At a glance">
            <div>
              <span>Primary asset</span>
              <strong>USDC</strong>
            </div>
            <div>
              <span>Network</span>
              <strong>Arc Testnet</strong>
            </div>
            <div>
              <span>Payment types</span>
              <strong>One-time bills and recurring tabs</strong>
            </div>
            <div>
              <span>Bridge provider</span>
              <strong>Circle AppKit with CCTP</strong>
            </div>
          </aside>
        </div>
      </header>

      <div className="docs-layout">
        <aside className="docs-sidebar">
          <p>Contents</p>
          {sections.map((section) => (
            <a href={`#${slug(section)}`} key={section}>
              {section}
            </a>
          ))}
        </aside>

        <article className="docs-content">
          <section id="overview" className="docs-section">
            <SectionHeading icon={<BookOpen size={20} />} title="Overview" />
            <p>
              Splitsy is built for groups that need more than a calculator screenshot. A splitter can upload a receipt, review
              the extracted bill, assign payer wallets, and create an onchain record of each participant&apos;s share. Payers can
              connect their wallets later, see only their own debts, pay in full or partially, and bridge USDC into Arc when
              their balance lives on another supported testnet.
            </p>
            <p>
              The application has two product surfaces. <strong>Bills</strong> are one-time debts linked to a receipt or expense.
              <strong>Recurring</strong> tabs are scheduled payment agreements, such as rent, subscriptions, shared services, or
              repeating household costs. Both flows are designed around explicit wallet approval and visible balances.
            </p>
            <div className="docs-card-grid">
              <InfoCard icon={<ReceiptText />} title="Scan and review">
                Upload a bill image, parse merchant totals and line items, convert non-USD totals to USD, and verify the split
                before anything is submitted.
              </InfoCard>
              <InfoCard icon={<WalletCards />} title="Wallet-first payment">
                Browser wallets sign contract transactions. The app uses EIP-1193/EIP-6963 provider discovery and Viem wallet
                clients for Arc Testnet interactions.
              </InfoCard>
              <InfoCard icon={<Route />} title="Bridge when needed">
                If a payer has USDC on another supported source chain, Splitsy can route them through Circle AppKit bridge flows
                into Arc Testnet.
              </InfoCard>
              <InfoCard icon={<CalendarClock />} title="Automated recurring settlement">
                Once a payer has approved a recurring tab, Splitsy checks due cycles automatically so users do not manually press
                a settlement button every cycle.
              </InfoCard>
            </div>
          </section>

          <section id="using-splitsy" className="docs-section">
            <SectionHeading icon={<CheckCircle2 size={20} />} title="Using Splitsy" />
            <div className="docs-steps">
              <Step number="1" title="Connect or upload">
                Start in the Bills tab. Upload a receipt image or review the default bill fields. The scanner reads totals, tax,
                tip, line items, and confidence notes.
              </Step>
              <Step number="2" title="Review the bill">
                Confirm the merchant, currency, subtotal, tax, tip, total, and line items. Non-USD bills are quoted into USD for
                payment calculations.
              </Step>
              <Step number="3" title="Choose a split">
                Use equal split for a quick division or manual split when participants owe different amounts. Each payer needs a
                valid EVM wallet address and a positive amount.
              </Step>
              <Step number="4" title="Submit the bill">
                The splitter creates a bill in the BillSplitRegistry contract. The contract stores a metadata hash, participant
                addresses, and each participant&apos;s owed USDC amount.
              </Step>
              <Step number="5" title="Payers settle">
                Payers connect the matching wallet, approve the registry for the selected USDC amount, and call the payment flow.
                Payments can be partial as long as they do not exceed the remaining debt.
              </Step>
              <Step number="6" title="Splitter claims">
                Paid funds accumulate as claimable balance in the registry. The splitter can claim any amount up to the available
                paid balance.
              </Step>
            </div>
          </section>

          <section id="bill-splits" className="docs-section">
            <SectionHeading icon={<BadgeDollarSign size={20} />} title="Bill Splits" />
            <p>
              The one-time bill flow is anchored by <code>BillSplitRegistry</code>. The registry does not need to know the full
              receipt body; it stores a hash of bill metadata plus the participant list and amounts. This keeps the contract
              focused on debt accounting while leaving rich receipt display to the app.
            </p>
            <div className="docs-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Contract function</th>
                    <th>What happens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Create bill</td>
                    <td><code>createBill(bytes32,address[],uint256[])</code></td>
                    <td>Registers participant debts and emits <code>BillCreated</code>.</td>
                  </tr>
                  <tr>
                    <td>Pay debt</td>
                    <td><code>payDebt(uint256,uint256)</code></td>
                    <td>Transfers USDC from payer to the registry and updates paid totals.</td>
                  </tr>
                  <tr>
                    <td>Claim funds</td>
                    <td><code>claim(uint256,uint256)</code></td>
                    <td>Allows only the splitter to withdraw paid, unclaimed funds.</td>
                  </tr>
                  <tr>
                    <td>Look up debts</td>
                    <td><code>billIdsForParticipant</code>, <code>getParticipant</code></td>
                    <td>Loads debts for the connected payer wallet.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Amounts are represented with 6 decimals to match USDC. User-entered dollar values are converted into USDC base
              units before they are submitted to the contract.
            </p>
            <Callout title="About netting">
              Splitsy includes a netting module for group ledger previews. It calculates each member&apos;s net position from charges,
              splits each charge across unique participants, and computes the minimum debtor-to-creditor transfers. The current
              onchain bill registry stores direct participant debts for a submitted bill; the netting module is available for
              richer group settlement previews and future persistence-backed ledgers.
            </Callout>
          </section>

          <section id="recurring-tabs" className="docs-section">
            <SectionHeading icon={<RefreshCw size={20} />} title="Recurring Tabs" />
            <p>
              Recurring tabs are fixed-share payment schedules. A creator chooses a recipient, interval, maximum number of
              settlement cycles, member wallets, and each member&apos;s fixed USDC share. Members approve the tab contract as a
              constrained USDC spender. Funds remain in member wallets until settlement runs.
            </p>
            <div className="docs-card-grid two">
              <InfoCard icon={<Landmark />} title="Factory deployment">
                <code>RecurringTabFactory</code> deploys one <code>RecurringTab</code> contract per tab. Each tab has immutable
                recipient, interval, max cycle count, member list, and fixed shares.
              </InfoCard>
              <InfoCard icon={<CalendarClock />} title="Scheduled settlement">
                Splitsy checks factory-created tabs on a schedule and calls <code>settleTab()</code> for tabs that have collectible
                balances.
              </InfoCard>
              <InfoCard icon={<ShieldCheck />} title="Shortfall handling">
                If a member has insufficient allowance or balance, the contract emits shortfall events and collects from members
                who are ready. Late underpaid amounts can be collected later after approval or funding.
              </InfoCard>
              <InfoCard icon={<CircleDollarSign />} title="Claimable balance">
                Settlement increases tab-level <code>claimable</code>. The recipient can call <code>claim()</code> to withdraw
                collected funds.
              </InfoCard>
            </div>
            <p>
              The debtor view shows approved amount, wallet balance, paid total, total debt, cycles due, and progress. A paid tab
              uses a paid-bill stamp. The splitter view shows every member&apos;s share, due amount, remaining
              total, wallet balance, allowance, and collected total.
            </p>
          </section>

          <section id="circle-and-arc" className="docs-section">
            <SectionHeading icon={<Route size={20} />} title="Circle and Arc" />
            <p>
              Splitsy uses Circle and Arc technology for USDC movement and settlement. Arc Testnet is the destination network for
              the app&apos;s contracts. Circle AppKit is used when a payer needs to bridge USDC from another supported source chain
              into Arc before paying.
            </p>
            <div className="docs-card-grid">
              <InfoCard icon={<Route />} title="Circle AppKit Bridge">
                The app creates a Viem adapter from the connected browser wallet and calls <code>kit.bridge()</code> with a source
                chain, <code>Arc_Testnet</code> as the destination, recipient address, amount, and token <code>USDC</code>.
              </InfoCard>
              <InfoCard icon={<CircleDollarSign />} title="CCTP">
                Circle&apos;s CCTP moves native USDC by burning on the source chain and minting on the destination chain. Arc&apos;s docs
                describe the bridge lifecycle as approve, burn, fetch attestation, and mint.
              </InfoCard>
              <InfoCard icon={<WalletCards />} title="Browser wallets">
                Splitsy discovers wallets with EIP-6963 announcements, requests accounts through EIP-1193, prefers MetaMask when
                available, and uses the wallet provider for signing.
              </InfoCard>
              <InfoCard icon={<Landmark />} title="Arc properties">
                Arc is EVM-compatible, uses USDC as its gas token in the Arc environment, and supports CCTP-based USDC bridging.
              </InfoCard>
            </div>
            <SourceList />
          </section>

          <section id="architecture" className="docs-section">
            <SectionHeading icon={<Code2 size={20} />} title="Architecture" />
            <div className="docs-architecture">
              <div>
                <h3>Experience layer</h3>
                <p>
                  The Splitsy web app handles receipt upload, bill review, split editing, wallet connection, debt payment,
                  claim flows, recurring tab creation, approval management, tab selection, and event display.
                </p>
              </div>
              <div>
                <h3>Service layer</h3>
                <p>
                  Receipt extraction, currency conversion, and recurring settlement automation are handled outside the payment
                  interface so users only see the actions they need.
                </p>
              </div>
              <div>
                <h3>Contracts</h3>
                <p>
                  <code>BillSplitRegistry</code> stores one-time debts. <code>RecurringTabFactory</code> creates recurring tab
                  contracts. <code>RecurringTab</code> handles fixed-share scheduled collection and claimable balances.
                </p>
              </div>
              <div>
                <h3>Integration layer</h3>
                <p>
                  Wallet, contract, and Circle bridge integrations are separated from the interface so payment flows remain
                  consistent across one-time bills and recurring tabs.
                </p>
              </div>
            </div>
            <div className="docs-stack">
              {stack.map(([name, detail]) => (
                <div key={name}>
                  <strong>{name}</strong>
                  <span>{detail}</span>
                </div>
              ))}
            </div>
          </section>

          <section id="contracts" className="docs-section">
            <SectionHeading icon={<FileText size={20} />} title="Contracts" />
            <p>
              Contracts are intentionally narrow. They store the minimum accounting state needed for payment enforcement and emit
              events for app indexing, explorer review, and user-facing history.
            </p>
            <div className="docs-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Purpose</th>
                    <th>Important events</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>BillSplitRegistry</code></td>
                    <td>Creates bills, records participant debts, accepts partial or full payments, and lets splitters claim paid funds.</td>
                    <td><code>BillCreated</code>, <code>DebtPaid</code>, <code>FundsClaimed</code></td>
                  </tr>
                  <tr>
                    <td><code>RecurringTabFactory</code></td>
                    <td>Deploys isolated recurring tab contracts and forwards scheduled settlement calls by tab id.</td>
                    <td><code>TabCreated</code></td>
                  </tr>
                  <tr>
                    <td><code>RecurringTab</code></td>
                    <td>Calculates accrued member obligations, transfers available USDC, records shortfalls, and exposes claimable funds.</td>
                    <td><code>MemberSettled</code>, <code>SettlementShortfall</code>, <code>TabSettled</code>, <code>FundsClaimed</code></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Callout title="Deployment note">
              Existing recurring tabs keep the bytecode they were created with. Changes to <code>RecurringTab.sol</code> require a
              new factory deployment and newly created tabs to use the updated behavior.
            </Callout>
          </section>

          <section id="operations" className="docs-section">
            <SectionHeading icon={<CalendarClock size={20} />} title="Operations" />
            <p>
              Recurring settlement is designed to be automatic after user approval. Payers maintain enough USDC and allowance for
              the tab, while Splitsy periodically checks whether a cycle is due and collectible.
            </p>
            <p>
              If a payer has insufficient balance or allowance, the contract records a shortfall and Splitsy can collect the
              unpaid portion later after the payer funds or re-approves their wallet. Recipients can claim collected funds when a
              claimable balance is available.
            </p>
          </section>

          <section id="security" className="docs-section">
            <SectionHeading icon={<LockKeyhole size={20} />} title="Security" />
            <ul className="docs-list">
              <li>Users explicitly approve USDC spend before contracts can pull funds.</li>
              <li>Recurring approval is constrained to the tab contract address and can be revoked by setting allowance to zero.</li>
              <li>Recurring settlement is protected by operational controls and is not exposed as a public user action.</li>
              <li>Sensitive operational credentials must never be exposed in browser code, screenshots, public docs, or client logs.</li>
              <li>Contracts use custom errors and explicit checks for invalid amounts, unknown bills, unauthorized claims, and duplicate recurring members.</li>
              <li>Receipt OCR data should be reviewed by the splitter before submission. The scanner is a convenience layer, not an accounting authority.</li>
              <li>Bridge flows depend on the connected wallet signing each step and on Circle attestation for CCTP minting.</li>
            </ul>
          </section>

          <section id="configuration" className="docs-section">
            <SectionHeading icon={<ShieldCheck size={20} />} title="Configuration" />
            <p>
              Splitsy should be connected to the intended Arc Testnet contracts before users create bills or recurring tabs.
              Contract addresses, USDC token settings, bridge support, receipt scanning, and settlement automation are managed by
              the operator during deployment.
            </p>
            <div className="docs-card-grid two">
              <InfoCard icon={<WalletCards />} title="For users">
                Use a compatible browser wallet, switch to the supported Arc Testnet network, keep enough USDC for payments, and
                review every wallet prompt before signing.
              </InfoCard>
              <InfoCard icon={<ShieldCheck />} title="For operators">
                Keep sensitive operational configuration outside public documentation. Publish only user-safe details such as supported
                network, supported asset, verified contract addresses, and contract source links.
              </InfoCard>
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}

function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="docs-heading">
      <span>{icon}</span>
      <h2>{title}</h2>
    </div>
  );
}

function InfoCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="docs-card">
      <span className="docs-card-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Step({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return (
    <div className="docs-step">
      <span>{number}</span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </div>
  );
}

function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="docs-callout">
      <strong>{title}</strong>
      <p>{children}</p>
    </aside>
  );
}

function SourceList() {
  return (
    <div className="docs-sources">
      <strong>External references</strong>
      <a href="https://developers.circle.com/cctp">Circle CCTP documentation</a>
      <a href="https://developers.circle.com/bridge-kit">Circle Bridge Kit / Arc App Kit migration note</a>
      <a href="https://docs.arc.io/app-kit/bridge">Arc App Kit Bridge documentation</a>
      <a href="https://docs.arc.io/integrate/infrastructure/bridges">Arc bridge infrastructure notes</a>
      <a href="https://docs.arc.io/app-kit/references/bridge-error-recovery">Arc bridge lifecycle and recovery reference</a>
    </div>
  );
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
