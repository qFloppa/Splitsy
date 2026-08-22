"use client";

import { Mail, WalletCards } from "lucide-react";

import { DiscordIcon, XIcon } from "./ProviderIcons";
import { useReveal } from "./useReveal";

const PROVIDERS = [
  { key: "x", label: "@SplitsyApp", kind: "X handle", icon: <XIcon size={15} /> },
  { key: "discord", label: "Splitsy", kind: "Discord username", icon: <DiscordIcon size={15} /> },
  { key: "email", label: "info@splitsy.xyz", kind: "Email address", icon: <Mail size={15} /> },
  { key: "wallet", label: "0xEE42…70AC", kind: "Wallet address", icon: <WalletCards size={15} /> },
];

// "Anyone" made concrete: the same four identities the demo just used, set the
// way the app sets a payer — the target in poster type, its namespace on the caps
// rail beneath. No chips, because a chip is a box and the app stopped drawing
// them.
export function SectionAnyone() {
  const ref = useReveal<HTMLElement>("top 76%");

  return (
    <section aria-labelledby="anyone-heading" className="bill-poster" ref={ref}>
      <div className="lp-measure">
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">06</span> Identity
          </span>
          <span className="bill-poster-fact" data-reveal="item">
            escrowed on Arc until they claim it
          </span>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="anyone-heading">
          No wallet? <span className="lp-headline-accent">No problem.</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          Tag people where they already are. Splitsy holds their share until they claim it with a handle,
          an inbox, or an address.
        </p>

        <ul className="lp-rows bill-poster-body list-none p-0">
          {PROVIDERS.map((provider) => (
            <li className="lp-row grid-cols-[minmax(0,1fr)_auto]" data-reveal="item" key={provider.key}>
              <span className="bill-payer-target flex min-w-0 items-baseline">
                <span className={`bill-payer-mark self-center ${provider.key === "discord" ? "" : "text-[var(--pay-poster-dim)]"}`} data-provider={provider.key}>
                  {provider.icon}
                </span>
                <span className={`truncate ${provider.key === "wallet" ? "mono text-[0.6em]" : ""}`}>
                  {provider.label}
                </span>
              </span>
              <span className="settle-label self-center">{provider.kind}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
