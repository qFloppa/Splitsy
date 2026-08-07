// Public service registry for Splitsy's x402-paywalled agent API.
//
// FREE to read — this is discovery, not a service. Any agent, dashboard, or
// developer can fetch this to find every paid endpoint, its price, input shape,
// and the payment terms needed to call it.
//
// Terminology note: in the x402 protocol the "facilitator" is the entity that
// VERIFIES and SETTLES payments — that role belongs to Circle Gateway, and its
// address is listed here as `facilitator`. This endpoint is better described as
// a service registry or agent marketplace listing; it is the discovery layer
// that sits in front of the protocol.
//
// Machine-readable JSON is the primary format. A Circle-style skill Markdown
// file for the autopay use-case lives at /api/agents/skill.
import { PRICES, type PaidEndpoint } from "@/lib/x402/pricing";
import {
  ARC_TESTNET_NETWORK,
  ARC_TESTNET_USDC,
  ARC_TESTNET_GATEWAY_WALLET,
} from "@/lib/x402/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One descriptor per paid service. Adding a new entry here (alongside the
// matching PRICES entry and withGateway wrapper) is the full publication step.
const SERVICES: ServiceDescriptor[] = [
  {
    endpoint: "/api/agents/queue",
    method: "GET",
    description:
      "Bill queue for a debtor: the bills a given wallet owes that its " +
      "on-chain mandate would let an agent pay right now. Includes creator " +
      "reputation scores and hash-verification status. The companion to " +
      "/api/agents/skill — read the skill to learn how to act on what this returns.",
    parameters: {
      query: {
        debtor: { type: "string", required: true, description: "0x wallet address of the debtor." },
      },
    },
    example: "GET /api/agents/queue?debtor=0xabc...123",
    useCases: ["Circle Agent Wallet autopay", "debtor-side bill management"],
  },
  {
    endpoint: "/api/reputation",
    method: "GET",
    description:
      "ERC-8004 payment-reputation aggregate for a wallet or social handle. " +
      "Returns a score (0-100 average), payment count, late-payment count, and " +
      "last-paid timestamp. Pass either ?address= or ?provider=&handle=. " +
      "Returns { status: 'none' } when the wallet has no history.",
    parameters: {
      query: {
        address: { type: "string", required: false, description: "0x wallet address." },
        provider: {
          type: "string",
          required: false,
          description: "Identity provider: 'x', 'discord', or 'email'.",
        },
        handle: { type: "string", required: false, description: "Social handle for the given provider." },
      },
    },
    example: "GET /api/reputation?address=0xabc...123",
    useCases: [
      "Counterparty-risk assessment before settling",
      "DeFi lending underwriting",
      "Expense-splitter trust scoring",
    ],
  },
  {
    endpoint: "/api/agents/netting",
    method: "POST",
    description:
      "Debt-netting solver: given a set of members and charges, returns the " +
      "minimum-transfer settlement graph plus each member's net position. " +
      "Pure computation — no Splitsy account or on-chain state required. " +
      "Reduces N charges to the fewest USDC transfers needed to square everyone.",
    parameters: {
      body: {
        members: {
          type: "array",
          required: true,
          description: "Array of { id: string }. Only `id` is used by the solver.",
        },
        charges: {
          type: "array",
          required: true,
          description:
            "Array of { id: string, paid_by_member_id: string, amount_usdc: string, split_among: string[] }.",
        },
      },
    },
    example:
      'POST /api/agents/netting\n{"members":[{"id":"alice"},{"id":"bob"}],' +
      '"charges":[{"id":"c1","paid_by_member_id":"alice","amount_usdc":"10.00","split_among":["alice","bob"]}]}',
    useCases: [
      "Settle a group trip in as few transactions as possible",
      "Produce a USDC payment plan from a shared charge list",
    ],
  },
  {
    endpoint: "/api/agents/dunning/verdict",
    method: "POST",
    description:
      "Dunning decision for one unpaid share: given a bill's due date, " +
      "the debtor's remaining balance, mandate status, and collectible amount, " +
      "returns whether to nudge, escalate, collect, or do nothing. Same logic " +
      "Splitsy's daily creditor sweep uses — buy a verdict before acting.",
    parameters: {
      body: {
        dueDate: { type: "number", required: true, description: "Unix seconds. 0 = no deadline." },
        remaining: {
          type: "string",
          required: true,
          description: "Unpaid USDC base units as decimal string (e.g. \"5000000\" = $5.00).",
        },
        hasMandate: {
          type: "boolean",
          required: true,
          description: "Whether the debtor has an active per-bill collect mandate.",
        },
        collectible: {
          type: "string",
          required: true,
          description: "USDC base units the mandate could pull right now, as decimal string.",
        },
        alreadyLogged: {
          type: "array",
          required: false,
          description: "Actions already taken: array of 'nudge' | 'escalate' | 'collect' | 'none'.",
        },
      },
    },
    example:
      'POST /api/agents/dunning/verdict\n' +
      '{"dueDate":1754000000,"remaining":"5000000","hasMandate":true,' +
      '"collectible":"5000000","alreadyLogged":["nudge"]}',
    useCases: [
      "Creditor agent deciding whether to escalate before acting",
      "Automated dunning pipeline outside Splitsy's own sweep",
    ],
  },
  {
    endpoint: "/api/agents/review",
    method: "POST",
    description:
      "Auditor's bill review: given a bill's plaintext details (merchant, total, " +
      "participant labels), a per-debtor share, and an optional creator reputation " +
      "score, returns approve/refuse plus a one-sentence reason. Uses an LLM to " +
      "judge plausibility. Splitsy's own Settler buys this before every autopay.",
    parameters: {
      body: {
        preimage: {
          type: "object",
          required: true,
          description:
            "{ merchant: string, currency: string, total: number, participantLabels: string[] }",
        },
        shareUsdc: { type: "number", required: true, description: "The debtor's share in USDC." },
        participantCount: {
          type: "number",
          required: true,
          description: "Number of participants on the bill.",
        },
        creatorScore: { type: "number | null", required: false, description: "ERC-8004 average, or null." },
      },
    },
    example:
      'POST /api/agents/review\n' +
      '{"preimage":{"merchant":"Pasta Place","currency":"GBP","total":40.0,' +
      '"participantLabels":["Alice","Bob"]},"shareUsdc":25.0,"participantCount":2,"creatorScore":80}',
    useCases: ["Pre-settlement sanity check", "Fraud detection on bill contents"],
  },
  {
    endpoint: "/api/ocr",
    method: "POST",
    description:
      "Receipt OCR: accepts a base64-encoded receipt image and returns structured " +
      "bill data (merchant, currency, total, line items). Backed by a vision model.",
    parameters: {
      body: {
        imageBase64: { type: "string", required: true, description: "Base64-encoded receipt image." },
      },
    },
    example: 'POST /api/ocr\n{"imageBase64":"<base64>"}',
    useCases: ["Automated bill creation from a photo receipt", "Expense parsing in agentic workflows"],
  },
  {
    endpoint: "/api/fx",
    method: "GET",
    description:
      "FX rate lookup: converts a foreign-currency amount to USDC. " +
      "Pass ?amount=&from= (e.g. ?amount=40&from=GBP).",
    parameters: {
      query: {
        amount: { type: "number", required: true, description: "Amount in the source currency." },
        from: { type: "string", required: true, description: "ISO 4217 currency code, e.g. GBP, EUR." },
      },
    },
    example: "GET /api/fx?amount=40&from=GBP",
    useCases: ["Convert a foreign receipt total to USDC before splitting"],
  },
];

type ServiceDescriptor = {
  endpoint: PaidEndpoint;
  method: "GET" | "POST";
  description: string;
  parameters: {
    query?: Record<string, { type: string; required: boolean; description: string }>;
    body?: Record<string, { type: string; required: boolean; description: string }>;
  };
  example: string;
  useCases: string[];
};

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;

  return Response.json({
    // What Splitsy is in the agentic economy.
    name: "Splitsy Agent API",
    description:
      "x402-paywalled services for the agent economy: bill queues, reputation " +
      "oracles, debt-netting, dunning decisions, receipt OCR, and FX rates. " +
      "Pay per call in USDC over Circle Gateway — no account required.",
    // x402 payment infrastructure.
    payment: {
      // The x402 "facilitator" is the entity that verifies and settles payments.
      // That is Circle Gateway, not this endpoint. This catalog is the discovery
      // layer; Gateway is the settlement layer.
      facilitator: "Circle Gateway",
      facilitatorUrl: "https://gateway-api-testnet.circle.com",
      network: ARC_TESTNET_NETWORK,
      asset: ARC_TESTNET_USDC,
      // The verifying contract for Gateway-batched EIP-3009 authorisations.
      gatewayWallet: ARC_TESTNET_GATEWAY_WALLET,
      // Who receives payment for each call.
      seller: process.env.SELLER_ADDRESS ?? null,
      scheme: "exact",
      // How to pay: sign an EIP-3009 transferWithAuthorization against the
      // GatewayWallet domain and include it as a base64 `payment-signature`
      // header. A 402 response from any endpoint carries the full challenge in
      // the `PAYMENT-REQUIRED` header, which is the authoritative source of the
      // exact amount and domain to sign against.
      instructions:
        "GET or POST the endpoint without a payment-signature header. " +
        "Parse the base64 PAYMENT-REQUIRED response header for the exact challenge. " +
        "Sign an EIP-3009 transferWithAuthorization and retry with the base64 " +
        "payment-signature header set.",
    },
    // Human-readable starting points.
    links: {
      developerPage: `${origin}/developers`,
      autopaySkill: `${origin}/api/agents/skill`,
      agentEconomyStats: `${origin}/api/scout/stats`,
    },
    services: SERVICES.map((s) => ({
      ...s,
      url: `${origin}${s.endpoint}`,
      price: PRICES[s.endpoint],
      priceUsdc: parseFloat(PRICES[s.endpoint].replace("$", "")),
    })),
  });
}
