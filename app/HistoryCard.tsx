"use client";

import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { ReactNode, useState } from "react";

// Shared expandable history record, used by both the on-chain (HomeClient) and
// off-chain (XHistoryPanel) history so paid/created records look identical.
// `detail` is mounted only when expanded, so any lazy fetch inside it runs on
// open. Without a `detail` the card is a static, non-expandable row.
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
    <div className="history-record" data-open={open}>
      <button
        className="history-record-toggle"
        onClick={() => expandable && setOpen((o) => !o)}
        type="button"
        aria-expanded={open}
        disabled={!expandable}
        style={expandable ? undefined : { cursor: "default" }}
      >
        <span className="min-w-0">
          <span className="block font-semibold">{title}</span>
          <span className="mt-1 block text-sm text-[var(--text-muted)]">{summary}</span>
        </span>
        <span className="history-record-badge">
          {badge}
          {expandable ? <ChevronDown className="history-chevron" size={18} /> : null}
        </span>
      </button>

      {open && detail ? <div className="history-detail">{detail}</div> : null}
    </div>
  );
}

// The paid/claimed rubber stamp. Normally an absolute overlay; inside a history
// card's badge it's pinned inline by the .history-record-badge .paid-bill-stamp
// rule in globals.css.
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
