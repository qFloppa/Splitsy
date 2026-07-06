import { getSessionUser } from "@/lib/session";
import { createBill, listDebtsIOwe, listBillsICreated, type NewDebt } from "@/lib/bills-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const [iOwe, owedToMe] = await Promise.all([listDebtsIOwe(user.id), listBillsICreated(user.id)]);
  return Response.json({ iOwe, owedToMe });
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    merchant?: unknown;
    currency?: unknown;
    debts?: unknown;
  } | null;
  if (!body) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const debtsInput = Array.isArray(body.debts) ? body.debts : [];
  const debts: NewDebt[] = [];
  const ownHandle = user.x_handle.toLowerCase();
  for (const raw of debtsInput) {
    const handle = String((raw as { handle?: unknown }).handle ?? "").trim().replace(/^@/, "");
    const amount = Number((raw as { amount?: unknown }).amount);
    if (!handle || !Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "Each debt needs a @handle and a positive amount." }, { status: 400 });
    }
    if (handle.toLowerCase() === ownHandle) {
      return Response.json({ error: "You can't split a bill with yourself." }, { status: 400 });
    }
    debts.push({ handle, amountUsdc: amount.toFixed(6) });
  }
  if (debts.length === 0) {
    return Response.json({ error: "Add at least one person to split with." }, { status: 400 });
  }

  const total = debts.reduce((sum, d) => sum + Number(d.amountUsdc), 0);
  const merchant = body.merchant ? String(body.merchant).slice(0, 200) : null;
  const currency = body.currency ? String(body.currency).slice(0, 8) : "USD";

  const bill = await createBill({
    creatorUserId: user.id,
    merchant,
    currency,
    totalUsdc: total.toFixed(6),
    debts,
  });
  return Response.json({ bill });
}
