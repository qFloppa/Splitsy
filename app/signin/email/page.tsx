import EmailSignInForm from "./EmailSignInForm";

// Render at request time so the nonce-based CSP (see proxy.ts) is applied to
// this page's framework scripts, matching the other standalone pages.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in with email",
  description: "Sign in to Splitsy with a one-time code sent to your email.",
  alternates: { canonical: "/signin/email" },
  robots: { index: false, follow: false },
};

export default function EmailSignInPage() {
  return <EmailSignInForm />;
}
