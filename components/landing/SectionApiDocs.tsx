"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import gsap from "gsap";
import { ArrowUpRight, CheckCircle2 } from "lucide-react";
import { PRICES, type PaidEndpoint } from "@/lib/x402/pricing";

// Token helpers — no syntax-highlight library. Every color is a CSS variable
// so light ↔ dark works without a second pass.
const K = ({ c }: { c: string }) => <span style={{ color: "var(--accent)" }}>{c}</span>;
const S = ({ c }: { c: string }) => <span style={{ color: "var(--settled-green)" }}>{c}</span>;
const Cm = ({ c }: { c: string }) => (
  <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{c}</span>
);
const Cy = ({ c }: { c: string }) => <span style={{ color: "var(--arc-cyan)" }}>{c}</span>;

type CodeLine = React.ReactNode;

// The x402 handshake is identical for every endpoint. Defined once; each
// service appends only the lines specific to its call and response.
const SHARED: CodeLine[] = [
  <Cm key="s0" c="// 1. Probe — no payment header → 402 challenge" />,
  <span key="s1"><K c="const" /> probe = <K c="await" /> <K c="fetch" />(url);</span>,
  <Cm key="s2" c="//    ← PAYMENT-REQUIRED: base64(challenge)" />,
  <span key="s3" />,
  <Cm key="s4" c="// 2. Parse the Circle Gateway payment terms" />,
  <span key="s5"><K c="const" /> {"{ accepts }"} = <K c="JSON" />.parse(atob(</span>,
  <span key="s6">{"  "}probe.headers.get(<S c='"PAYMENT-REQUIRED"' />)));</span>,
  <span key="s7"><K c="const" /> {"{ amount, payTo, maxTimeoutSeconds }"} = accepts[0];</span>,
  <span key="s8" />,
  <Cm key="s9" c="// 3. Sign a gasless EIP-3009 authorisation (no gas)" />,
  <span key="s10"><K c="const" /> sig = <K c="await" /> gateway.authorize({"{"}</span>,
  <span key="s11">{"  "}asset: <Cy c='"0x3600000000000000000000000000000000000000"' />,</span>,
  <span key="s12">{"  "}amount, payTo,</span>,
  <span key="s13">{"  "}validBefore: <K c="Math" />.floor(<K c="Date" />.now() / 1000) + maxTimeoutSeconds,</span>,
  <span key="s14">{"});"}</span>,
  <span key="s15" />,
  <Cm key="s16" c="// 4. Retry — Gateway batches and settles on Arc" />,
  <span key="s17"><K c="const" /> res = <K c="await" /> <K c="fetch" />(url, {"{"}</span>,
  <span key="s18">{"  "}headers: {"{ "}<S c='"payment-signature"' />: btoa(<K c="JSON" />.stringify(sig)) {"},"}</span>,
  <span key="s19">{"});"}</span>,
  <span key="s20" />,
];

type Service = {
  endpoint: PaidEndpoint;
  method: "GET" | "POST";
  label: string;
  description: string;
  params: string;
  response: string;
  useCases: string[];
  suffix: CodeLine[];
};

const SERVICES: Service[] = [
  {
    endpoint: "/api/agents/queue",
    method: "GET",
    label: "Bill queue",
    description:
      "Returns every bill a debtor's on-chain mandate could pay right now — with creator reputation scores and hash-verification status.",
    params: "?debtor=0x… (wallet address)",
    response: "mandate · bills[] · mandateAddress",
    useCases: ["Circle Agent Wallet autopay", "debtor-side bill management"],
    suffix: [
      <Cm key="q0" c="// Response" />,
      <span key="q1"><K c="const" /> {"{ mandate, bills }"} = <K c="await" /> res.json();</span>,
      <span key="q2"><Cm c="// bills[].amountUsdc, bills[].verified, bills[].creatorScore" /></span>,
    ],
  },
  {
    endpoint: "/api/reputation",
    method: "GET",
    label: "Reputation",
    description:
      "ERC-8004 payment-reputation aggregate for a wallet or social handle. Returns avgScore, count, lateCount, lastPaidAt.",
    params: "?address=0x… OR ?provider=x&handle=…",
    response: "status · avgScore · count · lateCount",
    useCases: ["counterparty risk scoring", "DeFi underwriting"],
    suffix: [
      <Cm key="r0" c="// Response" />,
      <span key="r1"><K c="const" /> {"{ status, avgScore, count }"} = <K c="await" /> res.json();</span>,
      <span key="r2"><Cm c='// status: "none" | "scored"' /></span>,
    ],
  },
  {
    endpoint: "/api/agents/netting",
    method: "POST",
    label: "Netting solver",
    description:
      "Minimum-transfer settlement graph for a group. Reduces N charges to the fewest USDC transfers needed to square everyone.",
    params: "{ members: [{id}][], charges: [{id, paid_by_member_id, amount_usdc, split_among}][] }",
    response: "positions[] · transfers[] · naiveTransactionCount · nettedTransactionCount",
    useCases: ["group trip settlement", "USDC payment plan from shared charges"],
    suffix: [
      <Cm key="n0" c="// Response" />,
      <span key="n1"><K c="const" /> {"{ transfers, nettedTransactionCount }"} = <K c="await" /> res.json();</span>,
      <span key="n2"><Cm c="// transfers[].fromMemberId · toMemberId · amountUsdc" /></span>,
    ],
  },
  {
    endpoint: "/api/agents/dunning/verdict",
    method: "POST",
    label: "Dunning verdict",
    description:
      "Given one unpaid share's facts, returns nudge / escalate / collect / none — the same logic Splitsy's daily sweep uses.",
    params: "{ dueDate, remaining: '5000000', hasMandate, collectible: '5000000', alreadyLogged? }",
    response: "action · amountMicros · amountUsdc · reason · evaluatedAt",
    useCases: ["creditor agent decision loop", "automated dunning pipeline"],
    suffix: [
      <Cm key="d0" c="// Response" />,
      <span key="d1"><K c="const" /> {"{ action, amountUsdc, reason }"} = <K c="await" /> res.json();</span>,
      <span key="d2"><Cm c='// action: "nudge" | "escalate" | "collect" | "none"' /></span>,
    ],
  },
  {
    endpoint: "/api/agents/review",
    method: "POST",
    label: "Bill review",
    description:
      "LLM-backed plausibility check on bill contents. Returns approve / refuse + a one-sentence reason. Splitsy's Settler buys this before every autopay.",
    params: "{ preimage: {merchant, currency, total, participantLabels[]}, shareUsdc, participantCount, creatorScore? }",
    response: "approve · reason",
    useCases: ["pre-settlement fraud check", "bill content auditing"],
    suffix: [
      <Cm key="v0" c="// Response" />,
      <span key="v1"><K c="const" /> {"{ approve, reason }"} = <K c="await" /> res.json();</span>,
      <span key="v2"><Cm c="// approve: boolean · reason: string" /></span>,
    ],
  },
  {
    endpoint: "/api/ocr",
    method: "POST",
    label: "Receipt OCR",
    description:
      "Vision-model receipt parser. Send a base64 image, receive structured bill data — merchant, currency, total, line items.",
    params: "{ imageBase64: string }",
    response: "merchant · currency · total · items[]",
    useCases: ["automated bill creation from a photo", "expense parsing"],
    suffix: [
      <Cm key="o0" c="// Response" />,
      <span key="o1"><K c="const" /> {"{ merchant, currency, total, items }"} = <K c="await" /> res.json();</span>,
    ],
  },
  {
    endpoint: "/api/fx",
    method: "GET",
    label: "FX rate",
    description:
      "Converts a foreign-currency amount to USDC. Pass ?amount= and ?from= (ISO 4217 code).",
    params: "?amount=40&from=GBP",
    response: "amountUsdc · rate · source",
    useCases: ["convert a foreign receipt total to USDC before splitting"],
    suffix: [
      <Cm key="f0" c="// Response" />,
      <span key="f1"><K c="const" /> {"{ amountUsdc, rate }"} = <K c="await" /> res.json();</span>,
    ],
  },
];

export function SectionApiDocs() {
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-apidocs-heading]", {
        y: 26, autoAlpha: 0, duration: 0.8, ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 78%" },
      });
      gsap.from("[data-apidocs-step]", {
        y: 18, autoAlpha: 0, duration: 0.6, ease: "expo.out", stagger: 0.07,
        scrollTrigger: { trigger: root, start: "top 64%" },
      });
      gsap.from("[data-apidocs-body]", {
        y: 24, autoAlpha: 0, duration: 0.7, ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 54%" },
      });
    }, root);
    return () => ctx.revert();
  }, []);

  const svc = SERVICES[active];
  const allCode = [...SHARED, ...svc.suffix];

  return (
    <section
      ref={rootRef}
      id="api-docs"
      aria-labelledby="apidocs-heading"
      className="mx-auto w-full max-w-[80rem] scroll-mt-24 px-4 pt-[var(--lp-section-y)] sm:px-6 lg:px-8"
    >
      <p
        data-apidocs-heading
        className="text-[0.62rem] font-extrabold uppercase tracking-[0.08em] text-[var(--text-muted)]"
      >
        Act four · open API
      </p>
      <h2
        data-apidocs-heading
        id="apidocs-heading"
        className="lp-display-lg mt-3 max-w-3xl"
      >
        Any agent.{" "}
        <span className="lp-headline-accent">One signature.</span>
      </h2>
      <p data-apidocs-heading className="lp-lede mt-5 max-w-2xl">
        Every endpoint answers HTTP 402 with a Circle Gateway challenge. Sign one
        offchain EIP-3009 authorisation — no account, no API key, no gas — and the
        same four lines get you into any of the seven services below.
      </p>

      {/* ── four-step flow ─────────────────────────────────────────────── */}
      <ol className="mt-10 flex list-none flex-col gap-2 p-0 sm:flex-row sm:gap-3">
        {[
          { n: "01", label: "Probe", detail: "GET / POST without a header → 402" },
          { n: "02", label: "Parse", detail: "Base64-decode PAYMENT-REQUIRED" },
          { n: "03", label: "Sign", detail: "EIP-3009 auth via gateway.authorize()" },
          { n: "04", label: "Retry", detail: "payment-signature header → 200" },
        ].map((step) => (
          <li
            key={step.n}
            data-apidocs-step
            className="flex flex-1 items-start gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-soft)]"
          >
            <span className="mono shrink-0 text-[0.62rem] font-bold tracking-[0.1em] text-[var(--accent)]">
              {step.n}
            </span>
            <span>
              <span className="block text-sm font-bold text-[var(--text)]">{step.label}</span>
              <span className="block text-xs text-[var(--text-muted)]">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      {/* ── service pill nav ───────────────────────────────────────────── */}
      <div data-apidocs-body className="mt-10 -mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
        <div className="flex gap-2 pb-2" role="tablist" aria-label="API endpoints">
          {SERVICES.map((s, i) => (
            <button
              key={s.endpoint}
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={[
                "mono shrink-0 rounded-full border px-3 py-1.5 text-[0.72rem] font-bold tracking-[0.04em] transition-all",
                "duration-[var(--dur-2)]",
                i === active
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text-soft)]",
              ].join(" ")}
            >
              <span className="hidden sm:inline">
                {s.method}&nbsp;
              </span>
              {s.endpoint}
              <span className="ml-2 font-normal opacity-60">{PRICES[s.endpoint]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── service detail + code block ─────────────────────────────────── */}
      <div data-apidocs-body className="mt-4 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_1.35fr]">

        {/* LEFT — service metadata */}
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            initial={reduced ? undefined : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl sm:p-6"
          >
            {/* method badge + price */}
            <div className="flex items-center gap-2">
              <span
                className="mono inline-flex rounded-[4px] px-2 py-0.5 text-[0.68rem] font-extrabold uppercase tracking-[0.08em]"
                style={{
                  background: svc.method === "GET" ? "var(--success-soft)" : "var(--accent-soft)",
                  color: svc.method === "GET" ? "var(--success)" : "var(--accent)",
                }}
              >
                {svc.method}
              </span>
              <span className="amount-text text-lg font-bold text-[var(--accent)]">
                {PRICES[svc.endpoint]}
              </span>
              <span className="text-xs text-[var(--text-muted)]">USDC per call</span>
            </div>

            {/* endpoint path — big mono display */}
            <p
              className="mono mt-3 break-all text-[clamp(0.9rem,2vw,1.15rem)] font-bold leading-tight text-[var(--text)]"
            >
              {svc.endpoint}
            </p>

            <p className="mt-3 text-sm text-[var(--text-soft)] leading-relaxed">
              {svc.description}
            </p>

            {/* params + response */}
            <dl className="mt-4 grid gap-2 text-xs">
              <div>
                <dt className="mono font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">
                  {svc.method === "GET" ? "Query" : "Body"}
                </dt>
                <dd className="mono mt-0.5 text-[var(--text-soft)] break-all">{svc.params}</dd>
              </div>
              <div className="border-t border-[var(--border)] pt-2">
                <dt className="mono font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">
                  Response
                </dt>
                <dd className="mono mt-0.5 text-[var(--text-soft)]">{svc.response}</dd>
              </div>
            </dl>

            {/* use cases */}
            <ul className="mt-4 list-none space-y-1 p-0">
              {svc.useCases.map((uc) => (
                <li key={uc} className="flex items-start gap-2 text-xs text-[var(--text-muted)]">
                  <CheckCircle2 className="mt-px shrink-0 text-[var(--success)]" size={13} />
                  {uc}
                </li>
              ))}
            </ul>

            {/* catalog link */}
            <a
              href="/api/agents/catalog"
              target="_blank"
              rel="noopener noreferrer"
              className="group mt-auto flex items-center gap-1 pt-5 text-xs font-semibold text-[var(--accent)] no-underline"
            >
              Full catalog (machine-readable JSON)
              <ArrowUpRight
                size={13}
                className="transition-transform duration-[var(--dur-2)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              />
            </a>
          </motion.div>
        </AnimatePresence>

        {/* RIGHT — code block */}
        {/* RIGHT — code block */}
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            initial={reduced ? undefined : { opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? undefined : { opacity: 0, x: -8 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col overflow-hidden rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-soft)]"
          >
            {/* terminal chrome */}
            <div
              className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-2.5"
              style={{ background: "color-mix(in srgb, var(--surface-strong) 72%, transparent)" }}
            >
              <span className="flex gap-1.5">
                {["#ff5f57","#febc2e","#28c840"].map((bg) => (
                  <span key={bg} className="inline-block size-2.5 rounded-full" style={{ background: bg }} />
                ))}
              </span>
              <span
                className="mono ml-2 flex-1 truncate text-center text-[0.72rem] text-[var(--text-muted)]"
              >
                splitsy-agent.ts
              </span>
              <span
                className="mono shrink-0 rounded-[4px] border border-[var(--border)] px-1.5 py-0.5 text-[0.62rem] text-[var(--text-muted)]"
                style={{ borderStyle: "dashed" }}
              >
                TypeScript
              </span>
            </div>

            {/* code lines */}
            <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: "28rem" }}>
              <table className="w-full border-collapse">
                <tbody>
                  {allCode.map((line, i) => (
                    <tr
                      key={i}
                      className="group hover:bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]"
                    >
                      <td
                        className="mono select-none py-0 pl-4 pr-3 text-right text-[0.72rem] leading-[1.7]"
                        style={{ color: "var(--text-muted)", opacity: 0.4, minWidth: "2.4rem" }}
                      >
                        {i + 1}
                      </td>
                      <td
                        className="mono py-0 pr-5 text-[0.78rem] leading-[1.7] text-[var(--text-soft)] whitespace-pre"
                      >
                        {line ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* gradient gradient-fade footer */}
            <div
              aria-hidden
              className="pointer-events-none h-8 shrink-0"
              style={{
                background: "linear-gradient(to bottom, transparent, var(--surface))",
                marginTop: "-2rem",
                position: "relative",
                zIndex: 1,
              }}
            />
          </motion.div>
        </AnimatePresence>

      </div>
    </section>
  );
}
