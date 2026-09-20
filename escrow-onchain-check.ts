// Live end-to-end against the freshly deployed HandleEscrow on Arc testnet.
// Uses the app's own helpers (lib/handle-escrow.ts) so this exercises the real
// signing and encoding path, not a second copy of it.
import { createPublicClient, createWalletClient, http, formatUnits, parseAbi, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC } from "./lib/arc-chain.ts";
import {
  HANDLE_ESCROW_ABI,
  handleHash,
  releaseDomain,
  RELEASE_TYPES,
} from "./lib/handle-escrow.ts";

const ESCROW = "0xc29b959868828702c37811deba826da48f0e1a6d" as const;
const RECIPIENT = "0x000000000000000000000000000000000000bEEF" as const;
const AMOUNT = 10_000n; // 0.01 USDC, 6dp

const ERC20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

const key = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
const deployer = privateKeyToAccount(key(process.env.DEPLOYER_PRIVATE_KEY!));
const attester = privateKeyToAccount(key(process.env.ESCROW_ATTESTER_PRIVATE_KEY!));

const transport = http(process.env.ARC_RPC_URL);
const pub = createPublicClient({ chain: ARC.chain, transport });
const wallet = createWalletClient({ account: deployer, chain: ARC.chain, transport });

const usdc = (a: `0x${string}`) => pub.readContract({ address: ARC.usdcAddress, abi: ERC20, functionName: "balanceOf", args: [a] });
const held = (id: bigint) => pub.readContract({ address: ESCROW, abi: HANDLE_ESCROW_ABI, functionName: "deposits", args: [id] });
const u = (n: bigint) => formatUnits(n, 6);

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${actual}, want ${expected})`}`);
}

async function send(hash: `0x${string}`, label: string) {
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${hash} [${r.status}] gas ${r.gasUsed}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
  return r;
}

console.log(`escrow    ${ESCROW}`);
console.log(`chain     ${await pub.getChainId()} (expect ${ARC.chainId})`);
console.log(`attester  ${attester.address}`);
console.log(`recipient ${RECIPIENT} starts at ${u(await usdc(RECIPIENT))} USDC\n`);

// ── 1. approve + deposit ────────────────────────────────────────────────────
console.log("1. deposit");
await send(
  await wallet.writeContract({ address: ARC.usdcAddress, abi: ERC20, functionName: "approve", args: [ESCROW, AMOUNT * 2n] }),
  "approve",
);
const hash = handleHash("email", "onchain-check@splitsy.test");
const depositReceipt = await send(
  await wallet.writeContract({ address: ESCROW, abi: HANDLE_ESCROW_ABI, functionName: "deposit", args: [hash, AMOUNT] }),
  "deposit",
);
const deposited = depositReceipt.logs
  .map((l) => { try { return decodeEventLog({ abi: HANDLE_ESCROW_ABI, ...l }); } catch { return null; } })
  .find((e) => e?.eventName === "Deposited")!;
const id = (deposited.args as { id: bigint }).id;
console.log(`  Deposited event -> id ${id}`);
check("id restarts at 1 on a fresh deployment", id, 1n);
const [depositor, storedHash, amount] = await held(id);
check("deposits(id).depositor", depositor, deployer.address);
check("deposits(id).handleHash", storedHash, hash);
check("deposits(id).amount", amount, AMOUNT);
check("escrow holds the money", await usdc(ESCROW), AMOUNT);

// ── 2. release against a real attester signature ────────────────────────────
console.log("\n2. release (the audited signature path)");
const deadline = BigInt(Math.floor(Date.now() / 1000)) + 600n;
const signature = await attester.signTypedData({
  domain: releaseDomain(ARC.chainId, ESCROW),
  types: RELEASE_TYPES,
  primaryType: "Release",
  message: { id, to: RECIPIENT, deadline },
});
console.log(`  signed (id=${id}, to=${RECIPIENT}, deadline=${deadline})`);
await send(
  await wallet.writeContract({ address: ESCROW, abi: HANDLE_ESCROW_ABI, functionName: "release", args: [id, RECIPIENT, deadline, signature] }),
  "release",
);
check("recipient was paid", await usdc(RECIPIENT), AMOUNT);
check("escrow is empty", await usdc(ESCROW), 0n);
check("deposit struct deleted", (await held(id))[2], 0n);

// ── 3. the same signature must not work twice ───────────────────────────────
console.log("\n3. replay of the spent signature");
try {
  await pub.simulateContract({ account: deployer, address: ESCROW, abi: HANDLE_ESCROW_ABI, functionName: "release", args: [id, RECIPIENT, deadline, signature] });
  check("replay rejected", "accepted", "reverted");
} catch (e) {
  const msg = String((e as Error).message);
  check("replay reverts with NoSuchDeposit", /NoSuchDeposit/.test(msg), true);
}

// ── 4. a signature for a different chain id must not work ───────────────────
console.log("\n4. signature bound to another chain");
const id2 = 2n;
await send(
  await wallet.writeContract({ address: ESCROW, abi: HANDLE_ESCROW_ABI, functionName: "deposit", args: [hash, AMOUNT] }),
  "deposit #2",
);
check("second deposit got id 2", (await held(id2))[2], AMOUNT);
const wrongChainSig = await attester.signTypedData({
  domain: releaseDomain(ARC.chainId + 1, ESCROW),
  types: RELEASE_TYPES,
  primaryType: "Release",
  message: { id: id2, to: RECIPIENT, deadline },
});
try {
  await pub.simulateContract({ account: deployer, address: ESCROW, abi: HANDLE_ESCROW_ABI, functionName: "release", args: [id2, RECIPIENT, deadline, wrongChainSig] });
  check("wrong-chain signature rejected", "accepted", "reverted");
} catch (e) {
  check("wrong-chain signature reverts with BadSignature", /BadSignature/.test(String((e as Error).message)), true);
}

// ── 5. reclaim returns the money ────────────────────────────────────────────
console.log("\n5. reclaim");
const before = await usdc(deployer.address);
await send(
  await wallet.writeContract({ address: ESCROW, abi: HANDLE_ESCROW_ABI, functionName: "reclaim", args: [id2] }),
  "reclaim",
);
check("depositor refunded", (await usdc(deployer.address)) - before, AMOUNT);
check("escrow empty again", await usdc(ESCROW), 0n);
check("deposit struct deleted", (await held(id2))[2], 0n);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
