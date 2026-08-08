import { getSessionUser } from "@/lib/session";
import { listAutopayLog } from "@/lib/agents-repo";

export const runtime = "nodejs";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const log = await listAutopayLog(user.id, 10);
    return Response.json({ log });
  } catch (err) {
    console.error("[autopay-log] failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to load log" },
      { status: 500 },
    );
  }
}
