import type { Metadata } from "next";
import { walletSession } from "@/lib/wallet-session";
import PayClient from "./PayClient";

// A share link is handed to specific people. Keeping it out of search indexes is
// the difference between "unguessable" and "unguessable until Google finds it".
export const metadata: Metadata = {
  title: "Pay a bill",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export default async function PayPage(props: PageProps<"/pay/[token]">) {
  const { token } = await props.params;
  // Same reason as /app: the header's account controls are painted with the page,
  // not fetched after it (lib/wallet-session.ts). A payer who is signed in sees
  // their wallet trigger immediately; a stranger with the link sees sign-in.
  return <PayClient token={token} walletSession={await walletSession()} />;
}
