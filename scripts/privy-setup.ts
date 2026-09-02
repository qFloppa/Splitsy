// Proof that a Privy wallet can hold and move USDC on Arc Testnet, and the
// record of the exact calls lib/privy-wallet.ts is built from. Copy the Privy
// calls from HERE. Checked against @privy-io/node@0.34.0's own type definitions
// (node_modules/@privy-io/node/public-api/, resources/), which is the only
// authority that cannot be out of date. Against the plan's code block:
//
//   new PrivyClient({appId, appSecret})            object, as the plan had it
//   privy.users().create({linked_accounts, wallets})   as the plan had it
//   privy.wallets().ethereum().signTransaction(walletId, {params: {transaction}})
//        NOT sendTransaction. Privy will not broadcast on Arc: sendTransaction
//        takes a caip2 and answers 401 "App is not authorized to transact on
//        chain eip155:5042002". eth_signTransaction takes no caip2 at all — the
//        chain id rides inside the transaction — so it is outside that gate.
//        Privy signs, we broadcast with viem. The wallet id is a POSITIONAL first
//        argument, and the transaction sits under params.transaction.
//
// Signing rather than sending means WE own the nonce and the fee estimate, which
// Privy owned before. This script is single-threaded so one pending-nonce read per
// run is all it needs; lib/privy-wallet.ts serves concurrent requests and carries
// the nonce handling for both of Arc's answers to a same-nonce race — a retry on
// "nonce too low", and a dropped-not-indeterminate verdict for the racing loser
// Arc accepts and then discards.
//
// Bodies are snake_case all the way down (chain_type, additional_signers,
// signer_id, custom_user_id, chain_id, gas_limit). No wallet_index input exists:
// the plan's `wallet_index` is not a field on either wallet-creation type. The
// linked-account type string for a custom JWT is "custom_auth", not the plan's
// "custom_jwt". policy_ids is optional here, so it is left off.
//
// Everything lives on https://api.privy.io now — POST /v1/users to create,
// POST /v1/users/custom_auth/id to look up, POST /v1/wallets/<id>/rpc to sign.
// There is no auth.privy.io host in this SDK.
//
// A 404 THROWS `NotFoundError` rather than returning null, which is why the
// lookup below is wrapped in try/catch.
//
// Open question 2 — can a social handle be a pregenerated linked account? YES,
// but not from the handle alone. linked_accounts accepts "twitter_oauth" and
// "discord_oauth", and in this SDK `username` is a REQUIRED field on both (X also
// requires `name`) — but so is `subject`, the provider's `sub` claim, so the
// identity Privy keys on is the provider's account id, not the @handle. Splitsy
// already captures that id at sign-in (`providerUserId` in
// app/api/auth/twitter/callback/route.ts), so pregenerating against an X or
// Discord account works; pregenerating against a typed-in handle does not.
//
// Requires a Node build with TypeScript stripping (amaro), same as
// scout:setup and settler:setup. Without it this dies on ERR_NO_TYPESCRIPT.
//
// Run: npm run privy:setup
// Then fund the printed address from https://faucet.circle.com and run again
// with an amount to send:  npm run privy:setup -- 0.01 0xRecipient
import { NotFoundError, PrivyClient, isEmbeddedWalletLinkedAccount, type User } from "@privy-io/node";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  numberToHex,
  parseUnits,
  recoverTransactionAddress,
} from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET_RPC, ARC_TESTNET_USDC } from "../lib/x402/constants.ts";

const appId = process.env.PRIVY_APP_ID ?? "";
const appSecret = process.env.PRIVY_APP_SECRET ?? "";
const quorumId = process.env.PRIVY_KEY_QUORUM_ID ?? "";
if (!appId || !appSecret || !quorumId) {
  throw new Error("Set PRIVY_APP_ID, PRIVY_APP_SECRET and PRIVY_KEY_QUORUM_ID in .env.local");
}

// A key quorum is made of authorization keys, and the server has to sign each
// wallet RPC with one of them. In this SDK that is PER REQUEST — an
// `authorization_context` on the call, not a client option — and it is optional,
// so an unset key still creates wallets and only fails at the send. Paste the
// dashboard value verbatim: the SDK strips the `wallet-auth:` prefix itself.
const authorizationKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
const authorizationContext = authorizationKey ? { authorization_private_keys: [authorizationKey] } : undefined;

const privy = new PrivyClient({ appId, appSecret });
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// Validate the money arguments before touching the network, and never let a typo
// arrive as a bare BigInt SyntaxError. getAddress rejects anything that is not 20
// hex bytes and returns the checksummed form — but note it does NOT reject a
// well-formed address with a WRONG checksum, it silently re-checksums it, so this
// catches malformed input and not a transposed character. Nothing downstream may
// treat a value that passed through here as checksum-verified.
const [amount, recipientArg] = process.argv.slice(2);
if (amount !== undefined && !/^\d+(\.\d+)?$/.test(amount)) {
  throw new Error(`Amount must be a plain decimal number of USDC, got "${amount}"`);
}
const recipient = recipientArg === undefined ? undefined : getAddress(recipientArg);

// A stable test identity so re-runs reuse the same wallet instead of minting one
// per invocation — the same idempotency lib/privy-wallet.ts needs. create() is
// not idempotent, so the lookup has to come FIRST: the second run spends the
// funding the first run's address received, and a fresh wallet would orphan it.
const TEST_KEY = "spike:arc-testnet-proof";

// The key quorum rides along as an additional signer. That is what lets the
// server transact later with no user present.
const WALLET_SPEC = [{ chain_type: "ethereum" as const, additional_signers: [{ signer_id: quorumId }] }];

// An account can be an external wallet, or a Solana embedded one; this picks the
// Privy-held Ethereum wallet, which is the only kind the send path can use.
const ethereumWallet = (u: User) =>
  u.linked_accounts.filter(isEmbeddedWalletLinkedAccount).find((account) => account.chain_type === "ethereum");

let user: User;
try {
  user = await privy.users().getByCustomAuthID({ custom_user_id: TEST_KEY });
} catch (caught) {
  if (!(caught instanceof NotFoundError)) throw caught;
  user = await privy.users().create({
    linked_accounts: [{ type: "custom_auth", custom_user_id: TEST_KEY }],
    wallets: WALLET_SPEC,
  });
}
console.log(`privy user  ${user.id}`);

// The identity can outlive a run whose wallet creation failed (a bad quorum id,
// say). Without this the test key is a dead end no re-run can get past.
let wallet = ethereumWallet(user);
if (!wallet) wallet = ethereumWallet(await privy.users().pregenerateWallets(user.id, { wallets: WALLET_SPEC }));
if (!wallet) throw new Error("Privy returned no Ethereum wallet");
console.log(`wallet      ${wallet.address}  (id ${wallet.id ?? "none"})`);

// Without a wallet id the server cannot sign, so stop here rather than after
// somebody has funded an address that can never spend. Two things land here: a
// wallet created without a server-side signer (check PRIVY_KEY_QUORUM_ID names a
// key quorum on THIS app), or a lookup response that simply carried no id for a
// wallet that does have one (check the wallet on the Privy dashboard, and that
// the app id matches the app that owns it).
if (!wallet.id) {
  throw new Error(
    "That wallet has no server wallet id, so the server cannot sign for it. Either it was created " +
      "without a key quorum (check PRIVY_KEY_QUORUM_ID) or this lookup did not return one (check the " +
      "wallet in the Privy dashboard under this PRIVY_APP_ID).",
  );
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
console.log(`balance     ${formatUnits(usdc, 6)} USDC (ERC-20), ${formatUnits(gas, 18)} native (gas)`);

if (!amount || !recipient) {
  console.log("\nFund that address at https://faucet.circle.com, then re-run with:");
  console.log("  npm run privy:setup -- 0.01 0xYourOtherAddress");
  process.exit(0);
}

// Because we broadcast, the transaction has to be complete before Privy sees it:
// Privy signs exactly what it is given and cannot fill in a nonce or a fee for a
// chain it does not serve. prepareTransactionRequest is viem's one call for all of
// it — pending nonce, gas limit, EIP-1559 fees. `to` and `data` are passed from
// here rather than read back off `prepared`, where both are optional: a `to` that
// came back empty would sign a CONTRACT CREATION instead of a transfer.
const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, parseUnits(amount, 6)] });
const prepared = await publicClient.prepareTransactionRequest({
  account: getAddress(wallet.address),
  to: ARC_TESTNET_USDC,
  data,
  type: "eip1559",
});

const { signed_transaction } = await privy
  .wallets()
  .ethereum()
  .signTransaction(wallet.id, {
    params: {
      transaction: {
        to: ARC_TESTNET_USDC,
        data,
        nonce: numberToHex(prepared.nonce),
        chain_id: arcTestnet.id,
        type: 2,
        gas_limit: numberToHex(prepared.gas),
        max_fee_per_gas: numberToHex(prepared.maxFeePerGas),
        max_priority_fee_per_gas: numberToHex(prepared.maxPriorityFeePerGas),
      },
    },
    authorization_context: authorizationContext,
  });

// Recover the signer from the RLP Privy handed back and refuse to broadcast unless
// it is this wallet. A signature over the wrong payload, or one carrying the wrong
// recovery parity, resolves to a DIFFERENT address — which either burns gas on a
// revert or, worse, spends from an account we did not mean to touch. The prefix
// check is what makes the cast below honest rather than assumed: we asked for a
// type-2 transaction, so confirm the RLP really is one.
if (!signed_transaction.startsWith("0x02")) {
  throw new Error(`Expected an EIP-1559 (type 2) signed transaction, got one starting ${signed_transaction.slice(0, 4)}`);
}
const serializedTransaction = signed_transaction as `0x02${string}`;
const signer = await recoverTransactionAddress({ serializedTransaction });
if (signer !== getAddress(wallet.address)) {
  throw new Error(`Signature recovers to ${signer}, not ${getAddress(wallet.address)} — refusing to broadcast`);
}

const hash = await publicClient.sendRawTransaction({ serializedTransaction });
console.log(`sent        https://testnet.arcscan.app/tx/${hash}`);
// sendRawTransaction returns once the node ACCEPTED the transaction, not once it
// is in a block, so the receipt is still the only thing that proves USDC moved.
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
console.log(`status      ${receipt.status}`);
