import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, WALLET_PROOF_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/app", request.nextUrl.origin), 303);
  response.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  // The second identity goes with the first. It is tied to a WALLET rather than
  // to the session that was holding it, so leaving it behind would hand the next
  // person to sign in on this browser the previous one's agent, balance and
  // decision log — for as long as that wallet stayed connected.
  response.cookies.set(WALLET_PROOF_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
