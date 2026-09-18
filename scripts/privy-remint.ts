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
// DELETES REFUSE VALUE, AND THERE IS NO OVERRIDE. The delete phase reads each
// orphan's on-chain balance and skips any row whose address still holds USDC, so a
// dead probe row holding even dust is permanently undeletable BY THIS SCRIPT. That
// is the deliberate trade — the alternative is erasing the record of a wallet that
// turns out to hold money. Such a row announces itself on stdout as
// `KEPT … delete refused`; remove it by hand in Supabase once you have satisfied
// yourself the address is really dead.
//
//   npm run privy:remint -- --dry-run     (default: prints the plan, changes nothing)
//   npm run privy:remint -- --commit
import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";
import { arcTestnet } from "viem/chains";
import { backend, getWalletOwnerId } from "../lib/privy-wallet.ts";
import { createSupabaseServerClient } from "../lib/supabase.ts";
import { ARC_RPC, ARC_USDC } from "../lib/x402/constants.ts";

const commit = process.argv.includes("--commit");
// --dry-run is the documented default, so it has to mean something when it is
// typed. Without this, `--dry-run --commit` moves money.
if (commit && process.argv.includes("--dry-run")) throw new Error("--dry-run and --commit are mutually exclusive");

const PAY_NAMESPACES = ["x", "discord", "email", "wallet"];
// Enumerated on purpose — NOT `namespace !== "agent"`. A blocklist puts every
// namespace invented later, or mistyped, into the delete range by default, and
// "agent"/"splitsy" were never the only ones that must survive: an UNCLAIMED
// "prem" pre-mint keeps its wallet id in pending_wallets, not users, so it can
// never look live by the test below — and it is fundable before its recipient
// ever logs in. Widening this list is a deliberate act; forgetting to widen a
// blocklist is an accident. "spike" is the dead probe namespace of the spikes.
const DELETABLE_NAMESPACES = [...PAY_NAMESPACES, "spike"];
// Arc charges gas in USDC, so a wallet cannot send its entire balance — the
// transfer itself has to be paid for. Left behind as dust in an abandoned wallet.
const GAS_RESERVE_USDC = 0.05;
// The temporary key the replacement is minted under. No real login produces a key
// ending in this: x/discord keys are numeric ids, wallet keys are hex addresses,
// and email keys are addresses that had to receive an OTP. Note EMAIL_RE
// (lib/email-otp.ts:10) would ACCEPT `user@example.com-export-remint` — hyphens
// are legal in a final label — so it is delivery, not the regex, that rules it
// out: that domain cannot resolve, so the code is never received and the row is
// never created. Google's path only ever supplies a verified address.
const SCRATCH_SUFFIX = "-export-remint";

const supabase = createSupabaseServerClient();
if (!supabase) throw new Error("Supabase is not configured");
// Demanded here, not read inline: the skip guard below compares Privy's owner_id
// against this, and an unset value would match nothing and silently re-mint a
// wallet that is already done. Same fail-closed reasoning as
// app/api/wallet/export/route.ts:141.
const quorum = process.env.PRIVY_KEY_QUORUM_ID?.trim();
if (!quorum) throw new Error("PRIVY_KEY_QUORUM_ID is not set");
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });

// Raw integer micros. The zero/nonzero test guarding the deletes has to be exact,
// so it reads this directly rather than balanceOf's display float.
const microsOf = (address: string) =>
  publicClient.readContract({
    address: ARC_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
  });

const balanceOf = async (address: string) => Number(formatUnits(await microsOf(address), 6));

// 1. The dead probe rows: keys no real login will ever produce, left by the spikes.
//    Deleted so a future login cannot adopt one, and so the table says what is real.
const { data: rows, error } = await supabase
  .from("privy_wallets")
  .select("namespace, key, wallet_id, address, export_owner_key");
if (error) throw new Error(error.message);

const { data: users, error: usersError } = await supabase
  .from("users")
  .select("id, handle, wallet_address, circle_wallet_id")
  .not("wallet_address", "is", null);
if (usersError) throw new Error(usersError.message);

const liveWalletIds = new Set(users.map((u) => u.circle_wallet_id));
// A scratch row is ALWAYS a candidate, live wallet id or not. Liveness is read
// from users.circle_wallet_id, which the pay loop overwrites with the new wallet
// id — so a crash between that write and the scratch delete below leaves the
// scratch row pointing at a LIVE id, invisible to a liveness test, and no re-run
// of this script could ever see it again. It is not harmless: two rows sharing a
// wallet_id make getPrivyWalletByWalletId's .maybeSingle() error PGRST116, and
// lib/privy-wallets-repo.ts:56 turns that into a throw from gate(). gate() now
// catches it and answers 502 rather than crashing the route, so the user gets a
// retryable error instead of a broken page — but their export stays broken until
// someone repairs the table by hand, which is why the row still surfaces here. The value guard still
// has the last word on the delete itself; this only puts the row back in front of
// the operator.
const orphans = rows.filter(
  (r) =>
    (!liveWalletIds.has(r.wallet_id) || r.key.endsWith(SCRATCH_SUFFIX)) && DELETABLE_NAMESPACES.includes(r.namespace),
);
console.log(`orphan rows to delete: ${orphans.length}`);
for (const row of orphans) {
  // Its OWN read, for display only — the operator reads this list to decide
  // whether to type --commit, and an unfiltered one advertises deletions the
  // value guard will refuse. The guard below is NOT hoisted up here and must not
  // be: taken at this point it would see a scratch address at zero, BEFORE the
  // pay loop sweeps funds into it, and then delete a row that is funded by the
  // time the delete runs. Two reads per orphan; the list is tiny.
  const micros = await microsOf(row.address);
  const held = micros > 0n ? `  holds ${formatUnits(micros, 6)} USDC — WILL BE KEPT, delete refused` : "";
  console.log(`  ${row.namespace}:${row.key}  ${row.address}${held}`);
}

// 2. The live pay wallets. One lookup, used both to select the user and to fetch
// the row, so the two can never disagree — the old code selected on
// PAY_NAMESPACES and then re-found the row without it, under a non-null assertion.
const payRowFor = (walletId: string | null) =>
  rows.find((r) => r.wallet_id === walletId && PAY_NAMESPACES.includes(r.namespace));
const payUsers = users.filter((u) => payRowFor(u.circle_wallet_id));
console.log(`\npay wallets to re-mint: ${payUsers.length}`);

// Scratch rows the pay loop deleted itself. `orphans` is a pre-loop snapshot, so a
// scratch row left by a crashed earlier run is in it AND is legitimately consumed
// below; without this the delete loop would read its now-funded address and print
// a KEPT line for a row that is already gone.
const consumed = new Set<string>();

for (const user of payUsers) {
  const row = payRowFor(user.circle_wallet_id);
  if (!row) throw new Error(`No pay wallet row for ${user.handle} (${user.circle_wallet_id})`);
  const balance = await balanceOf(row.address);
  console.log(`  ${user.handle}  ${row.namespace}:${row.key}  ${row.address}  ${balance} USDC`);

  // This loop is NOT idempotent, and a re-run is the natural remedy for any throw
  // in the delete phase below. After a completed run the repointed row carries the
  // new wallet id and users.circle_wallet_id matches it, so payRowFor selects the
  // user AGAIN — and without these two skips the script would mint a second
  // scratch wallet, sweep again, and null export_owner_key. Both reads run in dry
  // run too: they are reads, and the preview has to say what --commit will do.
  //
  // KNOWN AMBIGUITY, RULED 2026-09-11, STILL DO NOT BUILD MACHINERY FOR IT: a
  // foreign owner_id with a null export_owner_key is either a legacy wallet minted
  // before ownership existed (re-mint is correct) or one whose ownership the user
  // took while our record was lost (re-mint is destructive). The server cannot
  // tell them apart, and never will — see the ruling at
  // app/api/wallet/export/route.ts:resolveState for why no signal separates them.
  // Re-minting stays the right default, and the cost of being wrong is bounded:
  // the sweep below moves the funds to the replacement, so the user loses an
  // export ownership they can simply establish again on the new wallet, not money.
  // The unbuilt cheap check, if this ever runs against a population that might
  // hold state (a): keyQuorums.get(owner) returns the owner quorum's
  // authorization_keys, and a key there that the user can prove is theirs is the
  // one signal that would refuse this re-mint.
  const owner = await getWalletOwnerId(row.wallet_id);
  if (owner === quorum) {
    console.log("    SKIPPED — Privy says our key quorum owns this wallet, so it was already minted exportable");
    continue;
  }
  if (row.export_owner_key !== null) {
    console.log("    SKIPPED — export ownership already belongs to the user; re-minting would destroy it");
    continue;
  }

  if (!commit) continue;

  // Mint the replacement FIRST — the sweep needs somewhere to go. A distinct key
  // so getOrCreateWallet does not return the old row; the real row is repointed
  // below and this scratch row is removed.
  const mintKey = `${row.key}${SCRATCH_SUFFIX}`;
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

  // Repoint the real row at the new wallet.
  const updated = await supabase
    .from("privy_wallets")
    .update({ wallet_id: fresh.walletId, address: fresh.address, export_owner_key: null })
    .eq("namespace", row.namespace)
    .eq("key", row.key);
  if (updated.error) throw new Error(updated.error.message);

  // Lowercased on the way in: setUserWallet stores Privy's checksummed address
  // verbatim while getUsersByWallets matches lowercase, so a checksummed row never
  // resolves to a handle.
  const swapped = await supabase
    .from("users")
    .update({ wallet_address: fresh.address.toLowerCase(), circle_wallet_id: fresh.walletId })
    .eq("id", user.id);
  if (swapped.error) throw new Error(swapped.error.message);

  // Drop the scratch row LAST. Nothing above needs it gone — the two updates key
  // on (namespace, key) and on users.id, and neither reads privy_wallets — and
  // sitting between the two repoints it put its own throw inside the window that
  // leaves the two tables disagreeing. Checked like every other write here: a
  // silent failure leaves two rows sharing one wallet_id, which is not cosmetic —
  // it breaks that user's export route outright (see the orphan filter above).
  // Crashing here is survivable BECAUSE the filter catches scratch keys on their
  // own; without that clause this write would be the last chance to see the row.
  const scratched = await supabase.from("privy_wallets").delete().eq("namespace", row.namespace).eq("key", mintKey);
  if (scratched.error) throw new Error(scratched.error.message);
  consumed.add(`${row.namespace}:${mintKey}`);

  const after = await balanceOf(fresh.address);
  console.log(`    new balance ${after} USDC`);
}

if (commit) {
  let deleted = 0;
  for (const row of orphans) {
    // Already deleted by the pay loop, as its own scratch row. Reading its address
    // now would find the funds just swept INTO it and print `delete refused` for a
    // row that no longer exists — a lie told on exactly the recovery run where the
    // operator most needs this output to be true. Counted as deleted, because it is.
    if (consumed.has(`${row.namespace}:${row.key}`)) {
      deleted += 1;
      continue;
    }
    // Liveness above is read from users.circle_wallet_id — the very column the
    // loop overwrites. A crash between the two writes, or any drift between the
    // two tables, leaves a real funded row looking like an orphan. So value, not
    // bookkeeping, has the last word: money on the address means the operator's
    // assumptions are wrong, and it is louder than a delete is useful.
    //
    // STAYS HERE, immediately before the delete. Read any earlier and it sees a
    // scratch address at zero before the sweep funds it.
    const micros = await microsOf(row.address);
    if (micros > 0n) {
      console.log(`  KEPT ${row.namespace}:${row.key}  ${row.address}  holds ${formatUnits(micros, 6)} USDC — NOT an orphan, delete refused`);
      continue;
    }
    const dropped = await supabase.from("privy_wallets").delete().eq("namespace", row.namespace).eq("key", row.key);
    if (dropped.error) throw new Error(dropped.error.message);
    deleted += 1;
  }
  console.log(`\ndeleted ${deleted} orphan rows${deleted === orphans.length ? "" : ` (${orphans.length - deleted} kept for holding value)`}`);
} else {
  console.log("\nDRY RUN — nothing changed. Re-run with --commit to apply.");
}
