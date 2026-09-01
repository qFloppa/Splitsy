// Proof that a Privy wallet can hold and move USDC on Arc Testnet, and the
// record of the exact calls lib/privy-wallet.ts is built from. Copy the Privy
// calls from HERE, not from the docs pages: the installed SDK disagrees with
// them. Checked against @privy-io/server-auth@1.32.5's own type definitions
// (node_modules/@privy-io/server-auth/dist/dts/), which is the only authority
// that cannot be out of date:
//
//   new PrivyClient(appId, appSecret)             positional, not ({appId, appSecret})
//   privy.importUser({linkedAccounts, wallets})   there is no privy.users().create()
//   privy.walletApi.ethereum.sendTransaction()    there is no privy.wallets().ethereum()
//
// Everything is camelCase (chainType, additionalSigners, signerId, customUserId);
// the snake_case in the docs is the wire format this SDK converts to on the way
// out. A wallet to create is {chainType, policyIds, additionalSigners:[{signerId,
// policyIds}]} — there is no wallet_index going in (it comes back as
// hdWalletIndex). importUser does POST /api/v1/users on auth.privy.io, so the
// endpoint the plan named was right even where the method name was not; the send
// is POST /api/v1/wallets/<id>/rpc on api.privy.io with an eth_sendTransaction
// body, so the plan's second assumption holds too.
//
// NOTE: @privy-io/server-auth is deprecated in favour of @privy-io/node, which
// is the SDK those docs pages describe. This script deliberately uses the
// package the plan pinned; if the stack moves to @privy-io/node, every call
// below changes shape.
//
// Open question 2 — can a social handle be a pregenerated linked account? YES,
// but not from the handle alone. linkedAccounts accepts type "twitter_oauth" and
// "discord_oauth", and both carry `username` — but `username` is nullable and
// `subject` (the provider's `sub` claim) is required, so the pregeneration key
// is the provider's account id, not the @handle. Splitsy already captures that
// id at sign-in (`providerUserId` in app/api/auth/twitter/callback/route.ts), so
// pregenerating against an X or Discord account works; pregenerating against a
// handle somebody typed in does not.
//
// Run: npm run privy:setup
// Then fund the printed address from https://faucet.circle.com and run again
// with an amount to send:  npm run privy:setup -- 0.01 0xRecipient
import { PrivyClient } from "@privy-io/server-auth";
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, parseUnits } from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_RPC, ARC_TESTNET_USDC } from "../lib/x402/constants.ts";

const appId = process.env.PRIVY_APP_ID ?? "";
const appSecret = process.env.PRIVY_APP_SECRET ?? "";
const quorumId = process.env.PRIVY_KEY_QUORUM_ID ?? "";
if (!appId || !appSecret || !quorumId) {
  throw new Error("Set PRIVY_APP_ID, PRIVY_APP_SECRET and PRIVY_KEY_QUORUM_ID in .env.local");
}

// A key quorum is made of authorization keys, and the SDK signs every wallet RPC
// with the matching private key ("If your app has an authorization keypair
// registered in the Privy Dashboard, you must pass the corresponding private key
// here, otherwise wallet RPC requests will fail" — PrivyClient's own types). The
// plan did not name this variable; sendTransaction below 401s without it whenever
// the quorum has a key. Paste the dashboard value verbatim, wallet-auth: and all.
const privy = new PrivyClient(appId, appSecret, {
  walletApi: { authorizationPrivateKey: process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY },
});
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

const [amount, recipient] = process.argv.slice(2);

// A stable test identity so re-runs reuse the same wallet instead of minting one
// per invocation — the same idempotency lib/privy-wallet.ts needs. importUser is
// not idempotent, so the lookup has to come FIRST: the second run spends the
// funding the first run's address received, and a fresh wallet would orphan it.
const TEST_KEY = "spike:arc-testnet-proof";

// The key quorum rides along as an additional signer. That is what lets the
// server transact later with no user present.
const WALLET_SPEC = [
  { chainType: "ethereum" as const, policyIds: [], additionalSigners: [{ signerId: quorumId, policyIds: [] }] },
];

let user = await privy.getUserByCustomAuthId(TEST_KEY);
if (!user) {
  user = await privy.importUser({
    linkedAccounts: [{ type: "custom_auth", customUserId: TEST_KEY }],
    wallets: WALLET_SPEC,
  });
} else if (!user.wallet) {
  // The identity outlived a run whose wallet creation failed (a bad quorum id,
  // say). Without this the test key is a dead end no re-run can get past.
  user = await privy.createWallets({ userId: user.id, wallets: WALLET_SPEC });
}

console.log(`privy user  ${user.id}`);
const wallet = user.wallet;
if (!wallet) throw new Error("Privy returned no wallet");
console.log(`wallet      ${wallet.address}  (id ${wallet.id ?? "none"})`);
// No server wallet id means no server-side signing, so fail here rather than
// after somebody has funded an address that can never spend.
if (!wallet.id) {
  throw new Error("That wallet has no server wallet id. Check PRIVY_KEY_QUORUM_ID names a key quorum on this app.");
}

// Arc charges gas in USDC, and the faucet's USDC may land as one balance and not
// the other. The ERC-20 read alone cannot say whether the transfer below can pay
// for itself, so print both.
const [gas, usdc] = await Promise.all([
  publicClient.getBalance({ address: wallet.address as `0x${string}` }),
  publicClient.readContract({
    address: ARC_TESTNET_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.address as `0x${string}`],
  }),
]);
console.log(`balance     ${usdc} atomic USDC (ERC-20), ${formatUnits(gas, 18)} native (gas)`);

if (!amount || !recipient) {
  console.log("\nFund that address at https://faucet.circle.com, then re-run with:");
  console.log("  npm run privy:setup -- 0.01 0xYourOtherAddress");
  process.exit(0);
}

const { hash } = await privy.walletApi.ethereum.sendTransaction({
  walletId: wallet.id,
  caip2: ARC_TESTNET_NETWORK,
  transaction: {
    to: ARC_TESTNET_USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient as `0x${string}`, parseUnits(amount, 6)],
    }),
  },
});
console.log(`sent        https://testnet.arcscan.app/tx/${hash}`);
// That call returns when Privy has BROADCAST, not when Arc accepted it, so the
// receipt is the only thing that proves the USDC moved.
const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 60_000 });
console.log(`status      ${receipt.status}`);
