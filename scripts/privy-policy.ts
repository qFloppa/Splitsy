// The enclave-enforced ceiling on the agent wallet, created in code so the cap
// is reviewable here rather than remembered from a dashboard session.
//
// WHY THE AGENT AND NOTHING ELSE: it is the one wallet this server spends from
// with no user in the loop. Every other wallet signs on a request somebody just
// made. In funded money mode lib/autopay.ts's decideAutopay is the ONLY thing
// between the agent and its balance, and that is our own code — this policy is
// evaluated inside Privy's enclave instead, so a bug here cannot sign a payment
// over the cap however confidently it decides to.
//
// eth_signTransaction, NOT eth_sendTransaction. Privy will not broadcast on Arc
// (scripts/privy-setup.ts explains why), so this stack signs and broadcasts
// itself and never calls sendTransaction. A rule written against
// eth_sendTransaction would never fire and the cap would silently be
// decideAutopay again — passing every test by allowing everything.
//
// DENY-BY-DEFAULT, and that is what shapes the rules: a request matching no
// ALLOW rule is refused, and a DENY beats any ALLOW. So rule 1 has to exist —
// without it the agent could not sign at all and autopay would be dead rather
// than capped — and the caps have to be DENY rules, because two ALLOW rules on
// one method are OR'd and the looser one would simply win.
//
// The two caps are the two ways the agent can part with USDC in a single
// transaction: a bare transfer, and payDebtFor, which is how it settles a share
// in funded mode. approve() is deliberately NOT capped — ensureAgentAllowance
// approves 100x the amount in hand (lib/user-agent.ts:103), so a cap there would
// refuse the approval every settlement depends on.
//
// The ABIs are the repo's own, not hand-written JSON, so the enclave decodes
// calldata with the very ABI that encoded it and the two cannot drift.
//
// Each run creates a NEW policy; nothing here edits or deletes an old one.
//
// ONE POLICY PER NETWORK, and the deny-by-default is what makes that strict: the
// chain id is a condition on the only ALLOW rule, so a policy built for testnet
// refuses EVERY signature on mainnet and the agent wallet can sign nothing at all.
// Which network a run builds for comes from NEXT_PUBLIC_ARC_NETWORK — the same
// switch the app reads (lib/arc-chain.ts) — and is printed above the id, because
// the two policies are otherwise indistinguishable in the dashboard and the wrong
// one fails closed on the money path rather than loudly at the paste.
//
// Run: npm run privy:policy           (the default cap, testnet)
//      npm run privy:policy -- 10     (10 USDC per transaction)
//      NEXT_PUBLIC_ARC_NETWORK=mainnet npm run privy:policy -- 25
// A variable set on the command line wins over --env-file, so the last form needs
// no edit to .env.local.
// Then paste the printed id into .env.local as PRIVY_AGENT_POLICY_ID.
import { PrivyClient } from "@privy-io/node";
import { erc20Abi, numberToHex, parseUnits } from "viem";
import { ARC } from "../lib/arc-chain.ts";
import { REGISTRY_CALL_ABI } from "../lib/registry-calldata.ts";
import { ARC_USDC } from "../lib/x402/constants.ts";

const appId = process.env.PRIVY_APP_ID ?? "";
const appSecret = process.env.PRIVY_APP_SECRET ?? "";
if (!appId || !appSecret) {
  throw new Error("Set PRIVY_APP_ID and PRIVY_APP_SECRET in .env.local");
}

// One person's share of one bill is what this has to clear, so the default is a
// bill and not a budget. The user's own per-bill cap is usually far lower; this
// is the ceiling their settings panel cannot raise.
const DEFAULT_CAP_USDC = "25";

// Validated before the network call so a typo cannot arrive as a bare BigInt
// SyntaxError, same as scripts/privy-setup.ts's amount check.
const [capArg] = process.argv.slice(2);
const capUsdc = capArg ?? DEFAULT_CAP_USDC;
if (!/^\d+(\.\d+)?$/.test(capUsdc)) {
  throw new Error(`The cap must be a plain decimal number of USDC, got "${capUsdc}"`);
}
// Hex, because a policy `value` is always a string and the docs' own amount
// examples are hex. 6 decimals: these are USDC base units, as on chain.
const cap = numberToHex(parseUnits(capUsdc, 6));

const privy = new PrivyClient({ appId, appSecret });

const policy = await privy.policies().create({
  chain_type: "ethereum",
  version: "1.0",
  // Privy refuses a name of 50 characters or more, so this is abbreviated rather
  // than descriptive: "Splitsy agent wallet (mainnet) — 50 USDC per transaction"
  // is 56 and answers 400 invalid_policy_format. The rules below carry the detail.
  name: `Splitsy agent (${ARC.network}) — ${capUsdc} USDC per tx`,
  rules: [
    {
      name: `Sign only Arc ${ARC.network} transactions`,
      method: "eth_signTransaction",
      action: "ALLOW",
      conditions: [
        {
          field_source: "ethereum_transaction",
          field: "chain_id",
          operator: "eq",
          value: String(ARC.chainId),
        },
      ],
    },
    {
      name: `Refuse a USDC transfer over ${capUsdc} USDC`,
      method: "eth_signTransaction",
      action: "DENY",
      conditions: [
        // Pinned to the USDC contract because the cap is denominated in USDC's 6
        // decimals: an 18-decimal token's transfer would be measured against a
        // ceiling that is not its own.
        { field_source: "ethereum_transaction", field: "to", operator: "eq", value: ARC_USDC },
        { field_source: "ethereum_calldata", field: "transfer.amount", operator: "gt", value: cap, abi: erc20Abi },
      ],
    },
    {
      name: `Refuse a payDebtFor over ${capUsdc} USDC`,
      method: "eth_signTransaction",
      action: "DENY",
      // No `to` condition here, unlike the rule above: the registry address is a
      // redeployable env var, and a DENY that quietly stopped matching after a
      // redeploy would fail OPEN. The decoded call is what identifies it.
      conditions: [
        {
          field_source: "ethereum_calldata",
          field: "payDebtFor.amount",
          operator: "gt",
          value: cap,
          abi: REGISTRY_CALL_ABI,
        },
      ],
    },
  ],
});

console.log(`network     ${ARC.network} (chain ${ARC.chainId})`);
console.log(`policy      ${policy.id}`);
console.log(`cap         ${capUsdc} USDC per transaction (${cap} base units)`);
for (const rule of policy.rules) {
  console.log(`rule        ${rule.action.padEnd(5)} ${rule.method}  ${rule.name}`);
}
// Named per network, because the generic advice is wrong half the time: a mainnet
// policy in a local .env.local pins every agent wallet this machine mints to chain
// 5042, and they then refuse to sign on testnet — the same failure as a testnet
// policy on mainnet, pointing the other way.
console.log(`\nPaste this into ${ARC.network === "mainnet" ? "Vercel → Production" : ".env.local"}:`);
console.log(`  PRIVY_AGENT_POLICY_ID=${policy.id}`);
console.log("\nIt is attached at wallet creation, so agent wallets that already exist carry no policy.");
