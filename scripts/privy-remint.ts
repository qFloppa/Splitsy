// One-off: replace the pay wallets minted before export ownership existed.
//
// walletSpec() used to set additional_signers and no owner, and ownership cannot
// be retrofitted — an additional signer can spend but can never export or take
// ownership. So every wallet minted before that change is permanently
// non-exportable and the only repair is a new wallet plus a sweep. Cheap today
// (Preview, testnet, one funded wallet); impossible after a production flip.
//
// SCOPE: pay wallets only. Agent wallets are deferred (spec section 1) and are
// left alone deliberately — re-minting one would orphan its ERC-8004 identity,
// which is registered on chain against its address, and would need
// PRIVY_AGENT_POLICY_ID, whose setup script is currently missing from HEAD.
//
//   npm run privy:remint -- --dry-run     (default: prints the plan, changes nothing)
//   npm run privy:remint -- --commit
import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";
import { arcTestnet } from "viem/chains";
import { backend } from "../lib/privy-wallet.ts";
import { createSupabaseServerClient } from "../lib/supabase.ts";
import { ARC_TESTNET_RPC, ARC_TESTNET_USDC } from "../lib/x402/constants.ts";

const commit = process.argv.includes("--commit");
const PAY_NAMESPACES = ["x", "discord", "email", "wallet"];
// Arc charges gas in USDC, so a wallet cannot send its entire balance — the
// transfer itself has to be paid for. Left behind as dust in an abandoned wallet.
const GAS_RESERVE_USDC = 0.05;

const supabase = createSupabaseServerClient();
if (!supabase) throw new Error("Supabase is not configured");
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

const balanceOf = async (address: string) =>
  Number(
    formatUnits(
      await publicClient.readContract({
        address: ARC_TESTNET_USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [getAddress(address)],
      }),
      6,
    ),
  );

// 1. The dead probe rows: keys no real login will ever produce, left by the spikes.
//    Deleted so a future login cannot adopt one, and so the table says what is real.
const { data: rows, error } = await supabase.from("privy_wallets").select("namespace, key, wallet_id, address");
if (error) throw new Error(error.message);

const { data: users, error: usersError } = await supabase
  .from("users")
  .select("id, handle, wallet_address, circle_wallet_id")
  .not("wallet_address", "is", null);
if (usersError) throw new Error(usersError.message);

const liveWalletIds = new Set(users.map((u) => u.circle_wallet_id));
const orphans = rows.filter((r) => !liveWalletIds.has(r.wallet_id) && r.namespace !== "agent" && r.namespace !== "splitsy");
console.log(`orphan rows to delete: ${orphans.length}`);
for (const row of orphans) console.log(`  ${row.namespace}:${row.key}  ${row.address}`);

// 2. The live pay wallets.
const payUsers = users.filter((u) => rows.some((r) => r.wallet_id === u.circle_wallet_id && PAY_NAMESPACES.includes(r.namespace)));
console.log(`\npay wallets to re-mint: ${payUsers.length}`);

for (const user of payUsers) {
  const row = rows.find((r) => r.wallet_id === user.circle_wallet_id)!;
  const balance = await balanceOf(row.address);
  console.log(`  ${user.handle}  ${row.namespace}:${row.key}  ${row.address}  ${balance} USDC`);

  if (!commit) continue;

  // Mint the replacement FIRST — the sweep needs somewhere to go. A distinct key
  // so getOrCreateWallet does not return the old row; the real row is repointed
  // below and this scratch row is removed.
  const mintKey = `${row.key}-export-remint`;
  const fresh = await backend.getOrCreateWallet(row.namespace, mintKey);
  if (!fresh) throw new Error(`Could not mint a replacement for ${row.namespace}:${row.key}`);
  console.log(`    new wallet ${fresh.walletId} ${fresh.address}`);

  // Sweep, leaving gas behind. Arc charges gas in USDC, so the full balance can
  // never move.
  const sweep = Math.max(0, balance - GAS_RESERVE_USDC);
  if (sweep > 0) {
    const tx = await backend.transferUsdc(row.wallet_id, fresh.address, sweep.toFixed(6));
    console.log(`    swept ${sweep.toFixed(6)} USDC — ${tx.state} ${tx.txHash ?? tx.id}`);
  } else {
    console.log("    nothing to sweep");
  }

  // Repoint the real row at the new wallet, then drop the scratch row.
  const updated = await supabase
    .from("privy_wallets")
    .update({ wallet_id: fresh.walletId, address: fresh.address, export_owner_key: null })
    .eq("namespace", row.namespace)
    .eq("key", row.key);
  if (updated.error) throw new Error(updated.error.message);
  await supabase.from("privy_wallets").delete().eq("namespace", row.namespace).eq("key", mintKey);

  // Lowercased on the way in: setUserWallet stores Privy's checksummed address
  // verbatim while getUsersByWallets matches lowercase, so a checksummed row never
  // resolves to a handle.
  const swapped = await supabase
    .from("users")
    .update({ wallet_address: fresh.address.toLowerCase(), circle_wallet_id: fresh.walletId })
    .eq("id", user.id);
  if (swapped.error) throw new Error(swapped.error.message);

  const after = await balanceOf(fresh.address);
  console.log(`    new balance ${after} USDC`);
}

if (commit) {
  for (const row of orphans) {
    await supabase.from("privy_wallets").delete().eq("namespace", row.namespace).eq("key", row.key);
  }
  console.log(`\ndeleted ${orphans.length} orphan rows`);
} else {
  console.log("\nDRY RUN — nothing changed. Re-run with --commit to apply.");
}
