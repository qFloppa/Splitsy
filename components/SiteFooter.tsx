import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { ARC_EXPLORER } from "@/lib/arc-explorer";
import { siteContracts } from "@/lib/site-contracts";

// The site's colophon — the block a printed spec sheet ends with, stating what
// the thing is and the details you would need to check it.
//
// It was the last surface still wearing the pre-redesign skin: a --surface-muted
// slab of centred text with blue underlined links, at the foot of a site where
// nothing else draws a box and nothing else centres. So it is rebuilt out of the
// four pieces every section above it is built from — .lp-measure for the column,
// a hairline for a boundary, .settle-label for a caps rail, .bill-toggle for a
// link whose rule draws itself when you reach it — and the only thing the CSS
// adds is the layout those pieces sit in.
//
// Three rows of type, and that ceiling is the design. This block renders under
// every route, so every row it adds is a row the reader pays for on all of them.
// The first draft stacked a wordmark, a display-type signature line, two vertical
// link columns and six contract rows and came to 727px — most of a laptop
// viewport, to say nothing the page had not already said. What went, and why:
//
//   the wordmark        the masthead carries it, and a reader who has scrolled
//                       this far knows what site they are on
//   the signature line  "Split a bill. Settle in USDC." is the hero's job; at the
//                       foot of the page it was a display-sized restatement
//   the link columns    two columns of four links are five rows tall to a rail's
//                       one, plus two headings that only labelled four links each
//   three contracts     a footer is not a deployment manifest; the README is
//   the product nav     How it works / Agents / Market / Launch app / Docs are
//                       the masthead's links; a reader who scrolled past it to
//                       get here did not need them offered again
//
// A server component: no state, and the one animation (the top rule drawing
// itself) is scroll-driven CSS, so there is nothing to hydrate on any route.
//
// The class name is load-bearing. The settle and IOU tabs hide the footer by
// `.site-footer` because those two own the whole viewport; keeping the name keeps
// those rules working untouched.

const LEGAL = [
  { href: "/disclaimer", label: "Disclaimer" },
  { href: "/legal", label: "Terms & Privacy" },
];

export function SiteFooter() {
  const contracts = siteContracts();

  return (
    <footer className="site-footer">
      <div className="lp-measure site-footer-inner">
        <div className="site-footer-top">
          {/* Two links, so they are written out rather than mapped: the array
              they came out of held four the masthead already carries. */}
          <nav aria-label="Developers" className="site-footer-rail">
            <Link className="iou-provider bill-toggle" href="/api">
              API
            </Link>
            <a
              className="iou-provider bill-toggle site-footer-out"
              href={ARC_EXPLORER}
              rel="noopener noreferrer"
              target="_blank"
            >
              Explorer
              <ArrowUpRight aria-hidden className="lp-row-out self-center" size={11} />
            </a>
          </nav>
          <span className="settle-label">Arc Testnet · Test USDC</span>
        </div>

        {/* The one part of this footer that is not boilerplate, so it is only
            here when there is something true to put in it — an unconfigured
            deploy drops the band rather than printing dead links. */}
        {contracts.length > 0 && (
          <section aria-labelledby="footer-chain" className="site-footer-chain">
            <h2 className="settle-label" id="footer-chain">
              On chain
            </h2>
            <ul className="site-footer-ledger">
              {contracts.map((contract) => (
                <li key={contract.label}>
                  <a
                    className="site-footer-row"
                    href={contract.url}
                    rel="noopener noreferrer"
                    target="_blank"
                    title={contract.address}
                  >
                    <span className="site-footer-row-name">{contract.label}</span>
                    <span className="site-footer-row-addr">
                      {contract.short}
                      <ArrowUpRight aria-hidden className="lp-row-out self-center" size={11} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="site-footer-legal">
          {/* One line, not four. The full notice — the brands named one by one,
              the trademark acknowledgment — is on /disclaimer and /legal, both
              linked in the row directly below this paragraph, so printing it in
              full here spent four lines under every route to say what a reader
              who cares is one click from reading properly. What stays is the part
              that has to be read without clicking: it is testnet, and the money
              is not money. */}
          <p className="site-footer-disclaimer">
            Experimental demo on <strong>Arc Testnet</strong> — test USDC only,{" "}
            <strong>no real funds</strong>. An independent project, not affiliated with any brand named
            on this site.
          </p>
          {/* Beside the disclaimer rather than under it: the paragraph leaves the
              right half of the measure empty, which is exactly the width these
              two rows need. */}
          <div className="site-footer-base">
            <nav aria-label="Legal and help" className="site-footer-links">
              {LEGAL.map((item) => (
                <Link className="iou-provider bill-toggle" href={item.href} key={item.href}>
                  {item.label}
                </Link>
              ))}
              <a className="iou-provider bill-toggle" href="mailto:support@splitsy.xyz">
                Contact
              </a>
            </nav>
            <p className="settle-label site-footer-copy">© 2026 Splitsy · Not financial advice</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
