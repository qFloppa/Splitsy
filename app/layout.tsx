import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import WagmiProviders from "./WagmiProviders";

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
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
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/docs">Docs</Link>
            <a href="mailto:support@splitsy.xyz">Contact</a>
          </nav>
          <p className="site-footer-copy">© 2026 Splitsy · Not financial advice.</p>
        </footer>
      </body>
    </html>
  );
}
