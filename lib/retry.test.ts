import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, isTransientUpstream } from "./retry.ts";

const init: RequestInit = { method: "POST", body: "{}" };

// A fetch is swapped in rather than mocked at the network layer: the retry has
// to be exercised against the real Response/throw shapes it will meet.
function stubFetch(script: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, requestInit: unknown) => {
    calls.push({ url: String(url), init: requestInit as RequestInit });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("only 429 and 5xx are transient", () => {
  assert.equal(isTransientUpstream(429), true);
  assert.equal(isTransientUpstream(500), true);
  assert.equal(isTransientUpstream(503), true);
  assert.equal(isTransientUpstream(400), false);
  assert.equal(isTransientUpstream(402), false);
  assert.equal(isTransientUpstream(404), false);
});

// The exact failure this exists for: Gemini answers 503 "high demand", and
// without a retry that is a failed scan for the human.
test("a 503 is retried and the succeeding attempt is returned", async () => {
  const { calls, restore } = stubFetch([
    json(503, { error: { message: "This model is currently experiencing high demand." } }),
    json(200, { candidates: [] }),
  ]);
  try {
    const response = await fetchWithRetry("https://example.test/x", init);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

// The discarded attempt's body is the only place the upstream's reason lives,
// so it must be drained before the retry replaces the response.
test("the failed attempt's body is read and reported", async () => {
  const seen: string[] = [];
  const { calls, restore } = stubFetch([json(503, { error: { message: "high demand" } }), json(200, {})]);
  try {
    await fetchWithRetry("https://example.test/x", init, {
      attempts: 2,
      onRetryError: (message) => seen.push(message),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], "HTTP 503");
    // Drained, so the caller is not handed a body it cannot read.
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test("a transient failure that never clears surfaces the last response", async () => {
  const { calls, restore } = stubFetch([json(503, { error: { message: "high demand" } })]);
  try {
    const response = await fetchWithRetry("https://example.test/x", init, { attempts: 3 });
    assert.equal(response.status, 503);
    assert.equal(calls.length, 3);
  } finally {
    restore();
  }
});

// 402 is what a paywalled call answers without a signature. Retrying it would
// re-send a request the server already refused on purpose.
test("a non-transient status is returned on the first attempt", async () => {
  const { calls, restore } = stubFetch([json(402, { error: "Payment required." })]);
  try {
    const response = await fetchWithRetry("https://example.test/x", init);
    assert.equal(response.status, 402);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("a thrown fetch is retried and the error surfaces once attempts run out", async () => {
  const { calls, restore } = stubFetch([new Error("ECONNRESET")]);
  try {
    await assert.rejects(() => fetchWithRetry("https://example.test/x", init, { attempts: 3 }), /ECONNRESET/);
    assert.equal(calls.length, 3);
  } finally {
    restore();
  }
});

test("a thrown fetch that clears on the retry returns the response", async () => {
  const { calls, restore } = stubFetch([new Error("ECONNRESET"), json(200, { ok: true })]);
  try {
    assert.equal((await fetchWithRetry("https://example.test/x", init)).status, 200);
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

// A stream is consumed by the first attempt, so attempt two would send nothing.
// Every real caller passes a string; this refuses rather than sending an empty
// body to a paid endpoint.
test("an unreplayable stream body is refused instead of re-sent empty", async () => {
  const { calls, restore } = stubFetch([json(503, {}), json(200, {})]);
  try {
    await assert.rejects(
      () => fetchWithRetry("https://example.test/x", { method: "POST", body: new ReadableStream() }),
      /string body/,
    );
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});