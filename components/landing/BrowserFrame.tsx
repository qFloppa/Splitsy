import type { ReactNode } from "react";
import { Lock } from "lucide-react";

// Realistic browser chrome so the demo reads as "the real product running",
// not a mockup. Traffic lights tint on hover — a small nod that everything
// on this page is live.
export function BrowserFrame({ children }: { children: ReactNode }) {
  return (
    <div className="lp-browser">
      <div aria-hidden="true" className="lp-browser-bar">
        <span className="lp-browser-dots">
          <span />
          <span />
          <span />
        </span>
        <span className="lp-browser-url">
          <Lock size={11} />
          splitsy.xyz
        </span>
        <span aria-hidden="true" className="w-[3.2rem]" />
      </div>
      {children}
    </div>
  );
}
