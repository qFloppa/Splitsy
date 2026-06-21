import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnapSplit",
  description: "Bill splitting with USDC payments and onchain recurring tabs on Arc Testnet.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
