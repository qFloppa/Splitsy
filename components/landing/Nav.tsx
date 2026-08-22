"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";

import { useTheme } from "@/lib/use-theme";

// The landing's header, in the app's own grammar: .app-nav for where you are,
// .app-tools for what doesn't change where you are, and .bill-toggle's rule
// under whichever word is live. The pill rail, the bordered circle and the
// filled "Launch app" button are all gone — the hero's own .settle-action is
// the page's call, and a header that shouted it twice was the loudest thing on
// a page whose subject is a receipt.
//
// One thing the app's header never has to solve: this one is sticky over
// scrolling content. It earns its ground only once there is something behind it
// (see .lp-masthead[data-stuck]).
export function Nav() {
  const { theme, setTheme } = useTheme();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const header = ref.current;
    if (!header) return;

    // ponytail: a sentinel + IntersectionObserver, not a scroll listener — the
    // browser does the work off the main thread and there is nothing to throttle.
    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText = "position:absolute;top:0;height:1px;width:1px;pointer-events:none";
    document.body.prepend(sentinel);

    const io = new IntersectionObserver(
      ([entry]) => {
        header.dataset.stuck = entry.isIntersecting ? "false" : "true";
      },
      { threshold: 0 },
    );
    io.observe(sentinel);

    return () => {
      io.disconnect();
      sentinel.remove();
    };
  }, []);

  return (
    <header className="lp-masthead" data-stuck="false" ref={ref}>
      <div className="lp-measure flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-3">
        <Link aria-label="Splitsy home" className="brand-lockup" href="/">
          <span className="logo-crop logo-crop-app">
            <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
          </span>
        </Link>

        <nav aria-label="Main" className="app-rails">
          {/* Rooted at "/", not bare "#demo": this header is also the /api page's
              header, where a bare fragment points at a section that isn't on the
              page and the link does nothing. */}
          <div className="bill-views app-nav">
            <Link className="iou-provider bill-toggle" href="/#demo">
              How it works
            </Link>
            <Link className="iou-provider bill-toggle" href="/#agent">
              Agents
            </Link>
            <Link className="iou-provider bill-toggle" href="/#market">
              Market
            </Link>
          </div>
          <div className="app-tools">
            <Link className="iou-provider bill-toggle" href="/docs">
              Docs
            </Link>
            <Link className="iou-provider bill-toggle" href="/api">
              API
            </Link>
            <Link className="iou-provider bill-toggle" href="/app">
              Launch app
            </Link>
            <button
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
              className="iou-provider app-icon"
              onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
              type="button"
            >
              {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
            </button>
          </div>
        </nav>
      </div>
    </header>
  );
}
