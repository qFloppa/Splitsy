import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewVerdict, reviewBill, REVIEW_UNAVAILABLE, type ReviewInput } from "./autopay-review.ts";

test("an approval passes through with its reason", () => {
  const verdict = parseReviewVerdict('{"approve":true,"reason":"Share matches the two items listed."}');
  assert.equal(verdict.approve, true);
  assert.equal(verdict.reason, "Share matches the two items listed.");
});

test("a refusal carries the model's sentence", () => {
  const verdict = parseReviewVerdict(
    '{"approve":false,"reason":"The receipt lists two mains but you are charged for four."}',
  );
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, "The receipt lists two mains but you are charged for four.");
});

test("unparseable output fails closed", () => {
  const verdict = parseReviewVerdict("not json at all");
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("a null response fails closed", () => {
  const verdict = parseReviewVerdict(null);
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("valid JSON of the wrong shape fails closed", () => {
  // A model that answers in prose inside JSON must not be read as approval.
  const verdict = parseReviewVerdict('{"verdict":"looks fine"}');
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("an approval with no reason still approves, with a stand-in sentence", () => {
  const verdict = parseReviewVerdict('{"approve":true}');
  assert.equal(verdict.approve, true);
  assert.ok(verdict.reason.length > 0);
});

// Gemini fences its JSON even in JSON mode often enough that ocr-core.ts strips
// it. Unstripped, a fence would fail closed forever on a healthy deployment.
test("fenced JSON is still read, not failed closed", () => {
  const verdict = parseReviewVerdict('```json\n{"approve":true,"reason":"Totals line up."}\n```');
  assert.equal(verdict.approve, true);
  assert.equal(verdict.reason, "Totals line up.");
});

test("stripping fences does not let a non-boolean approve through", () => {
  const verdict = parseReviewVerdict('```json\n{"approve":"yes"}\n```');
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

// --- reviewBill: every failure direction must RETURN a refusal, never throw ---

const INPUT: ReviewInput = {
  preimage: {
    merchant: "Trattoria",
    currency: "USD",
    total: 120,
    participantLabels: ["ana", "ben"],
    receiptHash: "",
  },
  shareUsdc: 60,
  participantCount: 2,
  creatorScore: null,
};

// reviewBill logs on every failure by design; keep the run readable and prove it spoke.
async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: number }> {
  const original = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

async function withEnv<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.RECEIPT_SCANNER_API_KEY;
  if (key === undefined) delete process.env.RECEIPT_SCANNER_API_KEY;
  else process.env.RECEIPT_SCANNER_API_KEY = key;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.RECEIPT_SCANNER_API_KEY;
    else process.env.RECEIPT_SCANNER_API_KEY = previous;
  }
}

// Stubs global fetch, so nothing here touches the network.
async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

const candidate = (...texts: string[]) => ({
  candidates: [{ content: { parts: texts.map((text) => ({ text })) } }],
});

test("a missing API key refuses, and never reaches the network", async () => {
  const { result, warnings } = await captureWarnings(() =>
    withEnv(undefined, () =>
      withFetch(
        () => {
          throw new Error("reviewBill must not call fetch without an API key");
        },
        () => reviewBill(INPUT),
      ),
    ),
  );
  assert.equal(result.approve, false);
  assert.equal(result.reason, REVIEW_UNAVAILABLE);
  assert.equal(warnings, 1);
});

// The prompt build sits inside the try precisely so this returns instead of rejecting.
// preimage arrives as `BillPreimage | null` off a nullable Supabase column.
test("a malformed preimage returns a refusal instead of throwing", async () => {
  const broken = { ...INPUT, preimage: { ...INPUT.preimage, participantLabels: undefined } } as unknown as ReviewInput;
  const { result } = await captureWarnings(() =>
    withEnv("test-key", () =>
      withFetch(
        () => {
          throw new Error("must not reach fetch: the prompt build throws first");
        },
        () => reviewBill(broken),
      ),
    ),
  );
  assert.equal(result.approve, false);
  assert.equal(result.reason, REVIEW_UNAVAILABLE);
});

test("a null preimage returns a refusal instead of throwing", async () => {
  const broken = { ...INPUT, preimage: null } as unknown as ReviewInput;
  const { result } = await captureWarnings(() =>
    withEnv("test-key", () => withFetch(() => jsonResponse(candidate('{"approve":true}')), () => reviewBill(broken))),
  );
  assert.equal(result.approve, false);
  assert.equal(result.reason, REVIEW_UNAVAILABLE);
});

test("a non-2xx response refuses and says so", async () => {
  const { result, warnings } = await captureWarnings(() =>
    withEnv("test-key", () => withFetch(() => jsonResponse({ error: "quota" }, 429), () => reviewBill(INPUT))),
  );
  assert.equal(result.approve, false);
  assert.equal(result.reason, REVIEW_UNAVAILABLE);
  assert.equal(warnings, 1);
});

test("a thrown fetch refuses and says so", async () => {
  const { result, warnings } = await captureWarnings(() =>
    withEnv("test-key", () =>
      withFetch(
        () => Promise.reject(new Error("socket hang up")),
        () => reviewBill(INPUT),
      ),
    ),
  );
  assert.equal(result.approve, false);
  assert.equal(result.reason, REVIEW_UNAVAILABLE);
  assert.equal(warnings, 1);
});

// A thought part plus the answer part, as ocr-core.ts already handles.
test("a response split across parts is joined, not truncated", async () => {
  const { result } = await captureWarnings(() =>
    withEnv("test-key", () =>
      withFetch(
        () => jsonResponse(candidate('{"approve":true,', '"reason":"Split across two parts."}')),
        () => reviewBill(INPUT),
      ),
    ),
  );
  assert.equal(result.approve, true);
  assert.equal(result.reason, "Split across two parts.");
});

test("a fenced response over the wire is still read", async () => {
  const { result } = await captureWarnings(() =>
    withEnv("test-key", () =>
      withFetch(
        () => jsonResponse(candidate('```json\n{"approve":false,"reason":"Total is implausible."}\n```')),
        () => reviewBill(INPUT),
      ),
    ),
  );
  assert.equal(result.approve, false);
  assert.equal(result.reason, "Total is implausible.");
});

test("a candidate with no parts refuses", async () => {
  const { result } = await captureWarnings(() =>
    withEnv("test-key", () => withFetch(() => jsonResponse({ candidates: [{}] }), () => reviewBill(INPUT))),
  );
  assert.equal(result.approve, false);
  assert.equal(result.reason, REVIEW_UNAVAILABLE);
});

test("the prompt states the units and asks for no line items", async () => {
  let body = "";
  await captureWarnings(() =>
    withEnv("test-key", () =>
      withFetch(
        (_url, init) => {
          body = String((init as RequestInit).body);
          return jsonResponse(candidate('{"approve":true,"reason":"ok"}'));
        },
        () => reviewBill(INPUT),
      ),
    ),
  );
  const prompt = JSON.parse(body).contents[0].parts[0].text as string;
  assert.match(prompt, /in USDC/);
  assert.match(prompt, /There are no line items/);
  // An uneven share is the point of the app; the prompt must not treat it as suspect on its own.
  assert.match(prompt, /NOT by itself a reason to refuse/);
  assert.doesNotMatch(prompt, /does not match the line items/);
});
