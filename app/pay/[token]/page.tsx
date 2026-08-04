import type { Metadata } from "next";
import PayClient from "./PayClient";

// A share link is handed to specific people. Keeping it out of search indexes is
// the difference between "unguessable" and "unguessable until Google finds it".
export const metadata: Metadata = {
  title: "Pay a bill",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export default async function PayPage(props: PageProps<"/pay/[token]">) {
  const { token } = await props.params;
  return <PayClient token={token} />;
}
