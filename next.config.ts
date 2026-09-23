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

// THE ONE ROUTE GLOB THAT MATTERS, and why it is a glob and not the four routes
// that read best. composer lives at lib/agent-nft-image.ts and is pulled in by a
// dynamic import() from lib/erc8004.ts, so every trace that carries erc8004
// carries the composer's dependencies whether or not it ever mints. Scoping this
// to "the routes that mint" means re-deriving that reachability by hand every
// time an agent route is added, and the failure mode of forgetting is a silent
// missing image — not a crash. So the include goes where the dependency goes.
//
// Measured, not guessed: the local .next traces carry sharp's JS and the module
// for every route in app/api — including ten that only READ erc8004. The
// platform file set is fixed (the builder is always linux-x64), and the .so that
// actually has to ship IS in it — only the references the trace has are ones
// sharp does not need at runtime.
const AGENT_IMAGE_ROUTES = "/api/**";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // sharp's libvips binary, which file tracing cannot see.
  //
  // `@img/sharp-libvips-linux-x64` ships its native library at lib/libvips-cpp.so.*
  // and its lib/index.js is the entire body `module.exports = __dirname` — sharp
  // joins that directory to the .so name at RUNTIME. A static tracer cannot
  // follow a path that only exists once code has executed, so the trace shipped
  // index.js, package.json and versions.json and zero .so files, and every agent
  // image compose died with:
  //
  //   ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object file
  //
  // uploadAgentImage catches that and mints metadata with no image (lib/erc8004.ts:278),
  // so the symptom was not a stack trace but a perfectly good NFT with no picture —
  // 21 August onward, every mint, twice per payment while both reputation paths ran.
  // It also went unnoticed for a month because @img/sharp-linux-x64 (the platform
  // module that ONLY fails once libvips is already found) traced fine.
  //
  // The include is the whole @img tree, not `sharp-libvips-linux-x64/lib/*`:
  // next/image already traces @img/sharp-linux-x64, and this is one versioned
  // directory whose entries all ship together or not at all.
  //
  // WHAT THIS DELIBERATELY DOES NOT FIX: it pins linux-x64. If the functions ever
  // move to linux-arm64 (Graviton) the .so is missing again — the same failure,
  // same silence. Fixing that properly means swapping the per-platform packages
  // out for sharp's --cpu=wasm32 build (see sharp.pixelplumbing.com/install);
  // that changes image output to libvips-wasm, so it wants an eyeball on a
  // composed medallion first.
  // ponytail: global-ish glob, 19 MB × ~25 traced routes — narrow it when Next's
  // tracer learns to follow this path, or if function size ever matters
  outputFileTracingIncludes: {
    [AGENT_IMAGE_ROUTES]: ["./node_modules/@img/**/*"],
  },
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
  // Terms and Privacy were merged into a single /legal page. Redirect the old
  // paths (still registered as the X app's Terms/Privacy URLs) so they resolve.
  // /owe became the app's default IOU tab, so its old route resolves there too.
  async redirects() {
    return [
      { source: "/privacy", destination: "/legal", permanent: true },
      { source: "/terms", destination: "/legal", permanent: true },
      { source: "/owe", destination: "/app", permanent: true },
    ];
  },
};

export default nextConfig;
