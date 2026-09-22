// Retrying a transient upstream failure, in one place.
//
// Every outside model call this app makes (the receipt scanner, the second
// opinion, the FX quote) goes out over a public API that answers 503 "high
// demand" under load. That answer is temporary by definition, and without a
// retry a single unlucky request becomes a failed scan for the human.
//
// Two failures hidden behind one retry, and the reason this is shared rather
// than open-coded per caller: parseReceipt is reached twice for the same scan —
// once over HTTP as a paid x402 buy, and again directly as the free fallback —
// so a caller-level retry would fail both paths and report "Receipt scan failed."
// for a blip that a second attempt clears.

// Both are worth retrying for the same reason: the source is up, just busy or
// briefly unreachable. 429 and 5xx.
export function isTransientUpstream(status: number): boolean {
  return status === 429 || status >= 500;
}

// ponytail: fixed backoff, no jitter. Two attempts inside one request is sized
// for a blip, not an outage — the caller's own fallback covers the rest.
const BACKOFF_MS = [250, 750];

export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  opts?: { attempts?: number; onRetryError?: (message: string) => void },
): Promise<Response> {
  const attempts = opts?.attempts ?? 3;
  for (let attempt = 0; ; attempt++) {
    // A retried body must be replayable. Every caller here passes a string, so
    // a stream would silently send an empty second request — refuse instead.
    if (attempt > 0 && typeof init.body !== "string") {
      throw new Error("fetchWithRetry needs a string body to retry.");
    }
    // A thrown fetch (DNS, TLS, reset) is as transient as a 503, so it retries
    // the same way; only the final attempt's error escapes.
    let response: Response | null = null;
    let thrown: unknown = null;
    try {
      response = await fetch(input, init);
    } catch (error) {
      thrown = error;
    }

    const retrying = thrown !== null || (response !== null && isTransientUpstream(response.status));
    if (!retrying || attempt >= attempts - 1) {
      if (thrown) throw thrown;
      return response as Response;
    }

    // The body of the attempt being discarded carries the upstream's own reason
    // ("This model is currently experiencing high demand"). Read it here or lose
    // it, since the retry replaces it — the returned response is a 200 with
    // nothing left to say about what happened.
    await response?.text().catch(() => "");
    opts?.onRetryError?.(
      response ? `HTTP ${response.status}` : (thrown as Error)?.message ?? String(thrown),
    );
    await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt] ?? 750));
  }
}