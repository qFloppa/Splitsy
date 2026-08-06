import type { Metadata } from "next";
import OweClient from "./OweClient";

export const metadata: Metadata = {
  title: "I owe you",
  description: "Say who owes what in one line — no receipt required.",
  alternates: { canonical: "/owe" },
};

export default function OwePage() {
  return <OweClient />;
}
