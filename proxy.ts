import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Per-request Content-Security-Policy with a nonce.
//
// script-src uses a fresh 'nonce-<value>' + 'strict-dynamic' so we can drop
// 'unsafe-inline' entirely from scripts (the directive securityheaders.com
// flags as dangerous). Next.js reads the nonce from the request's CSP header
// during SSR and stamps it onto its framework/runtime/inline scripts; those
// scripts then transitively trust the chunks they load via 'strict-dynamic'.
//
// style-src keeps 'unsafe-inline' on purpose: React renders `style={{}}` as
// inline style attributes and a nonce cannot authorize style attributes, so
// there is no nonce-based path for them. (style-src 'unsafe-inline' is not the
// directive flagged as dangerous.)
//
// Because the nonce is generated per request, pages that render HTML must be
// dynamically rendered (see `export const dynamic = "force-dynamic"` on the
// otherwise-static routes).
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https://pbs.twimg.com https://abs.twimg.com https://unavatar.io",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Run on document requests only. Skip API routes, Next internals, the
    // favicon, and the static trust files — they don't need a per-request CSP
    // and shouldn't be pushed into dynamic rendering. Also skip next/link
    // prefetches so prefetching stays cacheable.
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|site.webmanifest|security.txt|.well-known).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
