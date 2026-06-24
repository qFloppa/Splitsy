import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Splitsy",
  description: "A clean way to scan bills, split costs, and collect payments.",
  icons: {
    icon: "/splitsy.png",
    apple: "/splitsy.png",
  },
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
