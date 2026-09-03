import type { Metadata, Viewport } from "next";
import { Geist_Mono, Hanken_Grotesk } from "next/font/google";
import localFont from "next/font/local";
import { headers } from "next/headers";
import "./globals.css";
import WagmiProviders from "./WagmiProviders";
import { HeroBackground } from "@/components/ui/hero-background";
import { SiteFooter } from "@/components/SiteFooter";

// Self-hosted via next/font: no external requests, no layout shift. The CSS
// font stacks in globals.css lead with these variables and keep the old
// system fallbacks. Clash Display (Fontshare EULA, see app/fonts/) is the
// display face for hero/headings only — its variable range tops out at 700,
// so display rules in globals.css must not ask for heavier weights.
const hankenGrotesk = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
const clashDisplay = localFont({
  src: "./fonts/ClashDisplay-Variable.woff2",
  weight: "200 700",
  variable: "--font-clash",
  display: "swap",
});

const siteUrl = "https://splitsy.xyz";
const siteDescription =
  "Experimental demo for scanning receipts, splitting shared costs, and settling test USDC payments on Arc Testnet. Test network only — no real funds.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Splitsy — split bills on Arc Testnet",
    template: "%s · Splitsy",
  },
  description: siteDescription,
  applicationName: "Splitsy",
  authors: [{ name: "Splitsy" }],
  generator: "Next.js",
  category: "finance",
  keywords: [
    "Splitsy",
    "split bills",
    "receipt scanner",
    "USDC",
    "Arc Testnet",
    "testnet",
    "expense splitting",
    "web3 demo",
  ],
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: "website",
    siteName: "Splitsy",
    title: "Splitsy — split bills on Arc Testnet",
    description: siteDescription,
    url: siteUrl,
    images: [{ url: "/splitsy.png", alt: "Splitsy" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Splitsy — split bills on Arc Testnet",
    description: siteDescription,
    images: ["/splitsy.png"],
  },
  icons: {
    icon: [
      { url: "/favicon-96x96.png", type: "image/png", sizes: "96x96" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    shortcut: "/favicon.ico",
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef3f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1b2a" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // proxy.ts issues a per-request CSP nonce (x-nonce); without it the inline
  // theme script below is blocked by script-src.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      className={`${hankenGrotesk.variable} ${geistMono.variable} ${clashDisplay.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Resolve the theme before first paint (stored choice, else light — see
            resolveInitialTheme in lib/use-theme.ts) so neither the landing page
            nor the app flashes the wrong theme. Must stay inline: any async load
            reintroduces the flash. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{document.documentElement.dataset.theme=sessionStorage.getItem("splitsy-theme")==="dark"?"dark":"light";}catch(e){}})();',
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Which wallet stack this deployment runs, for a visitor who cannot tell
            two hostnames apart. Set in Vercel's Preview environment and unset in
            Production, where this renders nothing — so forgetting it can only
            under-warn a preview visitor, never mislabel the live site. What the
            variable's scope does and does not protect: docs/deployments.md.

            role="note", not "status": a live region announces CHANGES after it
            registers, so content present at first paint is generally not read out
            at all, and a client-side navigation can announce it spuriously. This
            never changes after paint, so its whole job is done by being plain text
            first in reading order. No data-tone either — every [data-tone] rule in
            globals.css is scoped inside .lp-paper / .bill-poster / .pay-note /
            .bill-verify, so on <body> the attribute would style nothing while
            looking like it did.

            In normal flow rather than fixed: a fixed bar would have to outrank
            .lp-masthead (sticky, z-index 40) and would then cover it, and the
            settle deck's header, on every route. A row instead costs only the
            settle/iou tabs — whose shells are 100dvh — one short page scroll. */}
        {process.env.NEXT_PUBLIC_STACK_LABEL ? (
          <div className="settle-label" role="note" style={{ textAlign: "center", padding: "0.4rem" }}>
            {process.env.NEXT_PUBLIC_STACK_LABEL}
          </div>
        ) : null}
        <HeroBackground />
        <WagmiProviders>{children}</WagmiProviders>
        <SiteFooter />
      </body>
    </html>
  );
}
