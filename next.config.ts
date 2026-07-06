import type { NextConfig } from "next";

// Static security headers applied to every route. The Content-Security-Policy
// is intentionally NOT set here — it carries a per-request nonce and is set in
// `proxy.ts` instead (see that file for the rationale).
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Circle DCW SDK uses Node-native crypto (node-forge) that the dev
  // bundler's worker can't process — bundling it crashes route compilation
  // ("Jest worker child process exceptions"). Opt it out so it's require()'d.
  serverExternalPackages: ["@circle-fin/developer-controlled-wallets"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
