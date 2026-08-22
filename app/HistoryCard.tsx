"use client";

import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { ReactNode, useState } from "react";

// One settled bill, expandable — the paper trail at the foot of the dashboard
// tab, used by both the on-chain (HomeClient) and off-chain (XHistoryPanel)
// records so the two stacks read as one document.
//
// Set as a poster row rather than a card, like everything else on the tab: the
// bill IS the line, the stamp and the chevron close it, whatever qualifies it is
// a footnote underneath, and what the chain says opens under that. See "record
// rows" in globals.css.
//
// `detail` is mounted only when expanded, so any lazy fetch inside it runs on
// open. Without a `detail` the row is static and the toggle is inert.
export function HistoryCard({
  title,
  summary,
  badge,
  detail,
}: {
  title: ReactNode;
  summary: ReactNode;
  badge: ReactNode;
  detail?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(detail);

  return (
    <div className="bill-record" data-open={open}>
      <button
        aria-expanded={expandable ? open : undefined}
        className="bill-record-toggle"
        disabled={!expandable}
        onClick={() => expandable && setOpen((o) => !o)}
        style={expandable ? undefined : { cursor: "default" }}
        type="button"
      >
        <span className="bill-payer-line">
          <span className="bill-payer-target">{title}</span>
          <span className="bill-record-mark">
            {badge}
            {expandable ? <ChevronDown className="bill-items-chevron" size={18} /> : null}
          </span>
        </span>
        <span className="bill-payer-meta">{summary}</span>
      </button>

      {open && detail ? <div className="bill-record-detail">{detail}</div> : null}
    </div>
  );
}

// The paid/claimed rubber stamp. Normally an absolute overlay; inside a record's
// mark it is pinned inline and given its tilt by the .bill-record-mark
// .paid-bill-stamp rule in globals.css.
export function PaidBillStamp({
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
