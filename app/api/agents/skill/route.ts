// The instructions a user's own Circle Agent Wallet follows to settle their
// bills, in the same shape as Circle's own hosted skills
// (https://agents.circle.com/skills/*.md).
//
// Templated rather than a static file in public/ because MANDATE_ADDRESS is
// environment-dependent, and a skill file naming a stale contract is worse than
// no skill file at all.
import { isMandateConfigured, MANDATE_ADDRESS } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isMandateConfigured()) {
    return new Response("No autopay mandate contract is configured.", { status: 503 });
  }
  const origin = new URL(request.url).origin;

  const body = `---
name: splitsy-autopay
description: Settle your share of Splitsy bills from your own Circle Agent Wallet, under an on-chain mandate you signed.
---

# Splitsy autopay

You hold a Circle Agent Wallet. The user has named its address as the agent on
their \`AutopayMandate\` contract, which means you — and only you — may pull their
USDC to settle their share of a bill, up to caps they set on chain.

The contract enforces those caps itself. You cannot exceed them; a call that
would will revert. Your job is the judgment the contract cannot make.

- Mandate contract: \`${MANDATE_ADDRESS}\`
- Chain: \`ARC-TESTNET\`

## 1. Find work

\`\`\`bash
curl -s "${origin}/api/agents/queue?debtor=<theUsersWalletAddress>"
\`\`\`

Returns the live mandate and a \`bills\` array. Every bill listed is one the
contract would pay right now — the feed already accounts for the caps, the daily
budget, the user's USDC approval and their balance. An empty array means there is
nothing to do.

Each bill carries:

| Field | Meaning |
|---|---|
| \`billId\` | Pass this to \`payFor\` |
| \`amountUsdc\` | What would move. You never pass an amount |
| \`creator\` | Who raised the bill |
| \`creatorScore\` | ERC-8004 average, or \`null\` for no history |
| \`verified\` | The published details hash to what the chain committed |
| \`preimage\` | Merchant, currency, total, participant labels |

## 2. Decide

Refuse when the bill does not hold up. Worth checking:

- \`verified\` is \`false\` — the details on display are not the details committed on chain.
- The total does not match what the participants and labels imply.
- The share is far above an even split with nothing in the bill to justify it.
- The creator's score is low **and** the bill is unusual. No history is neutral, never bad on its own.

## 3. Pay

\`\`\`bash
circle wallet execute "payFor(uint256,address)" <billId> <theUsersWalletAddress> \\
  --contract ${MANDATE_ADDRESS} \\
  --chain ARC-TESTNET \\
  --address <yourAgentWalletAddress>
\`\`\`

No amount: the contract reads the full remaining share itself, so you cannot pick
a figure, cannot split one share into several sub-cap pulls, and cannot aim this
at another bill's money.

If the wallet has no gas, run:

\`\`\`bash
circle wallet fund --address <yourAgentWalletAddress> --chain ARC-TESTNET
\`\`\`

## What binds you

\`circle wallet limit\` policies are **mainnet-only**, so on Arc Testnet Circle-side
spend policy is not in play. The mandate contract is the only thing enforcing
your limits — which is the stronger claim anyway: the caps are on chain, public,
and revocable by the user at any moment with \`revokeMandate()\`, whether or not
Splitsy's servers are reachable.
`;

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
