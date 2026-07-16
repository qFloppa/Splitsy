import type { Metadata, Viewport } from "next";
import { Inter, Roboto_Mono } from "next/font/google";
import { headers } from "next/headers";
import Link from "next/link";
import "./globals.css";
import WagmiProviders from "./WagmiProviders";
import { HeroBackground } from "@/components/ui/hero-background";

// Self-hosted via next/font: no external requests, no layout shift. The CSS
// font stacks in globals.css lead with these variables and keep the old
// system fallbacks.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const robotoMono = Roboto_Mono({ subsets: ["latin"], variable: "--font-roboto-mono", display: "swap" });

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
    <html lang="en" className={`${inter.variable} ${robotoMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Resolve the theme before first paint (stored choice → OS preference)
            so neither the landing page nor the app flashes the wrong theme.
            Must stay inline: any async load reintroduces the flash. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=sessionStorage.getItem("splitsy-theme");if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){}})();',
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <HeroBackground />
        <WagmiProviders>{children}</WagmiProviders>
        <footer className="site-footer">
          <p className="site-footer-disclaimer">
            Splitsy is an experimental demo on <strong>Arc Testnet</strong> — it uses test USDC only and
            involves <strong>no real funds</strong>. It is an independent project and is not affiliated with,
            endorsed by, or sponsored by Circle, Arc, USDC, MetaMask, or any other referenced brand. All
            trademarks belong to their respective owners.
          </p>
          <nav className="site-footer-links" aria-label="Legal and help">
            <Link href="/disclaimer">Disclaimer &amp; acknowledgments</Link>
            <Link href="/legal">Terms &amp; Privacy</Link>
            <Link href="/docs">Docs</Link>
            <a href="mailto:support@splitsy.xyz">Contact</a>
          </nav>
          <p className="site-footer-copy">© 2026 Splitsy · Not financial advice.</p>
        </footer>
      </body>
    </html>
  );
}
