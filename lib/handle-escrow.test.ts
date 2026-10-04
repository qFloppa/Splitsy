import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeErrorResult, decodeFunctionData, domainSeparator, encodeAbiParameters, keccak256, toHex } from "viem";
import {
  encodeDeposit,
  encodeRelease,
  handleHash,
  HANDLE_ESCROW_ABI,
  releaseDomain,
  RELEASE_TYPES,
} from "./handle-escrow.ts";

test("the hash is keccak256 of '<provider>:<handle>'", () => {
  assert.equal(handleHash("email", "dani@example.com"), keccak256(toHex("email:dani@example.com")));
});

test("handles are normalized the same way the rest of the app does", () => {
  // A leading @ is stripped and case is folded, so @Dani, Dani and dani are one
  // person. Without this, tagging @Dani and signing in as dani are two escrows.
  assert.equal(handleHash("x", "@Dani"), handleHash("x", "dani"));
  assert.equal(handleHash("email", "OK@Splitsy.xyz"), handleHash("email", "ok@splitsy.xyz"));
  // The namespace is folded too. A provider reaches here from an OAuth callback
  // as often as from a literal, and "X" is how one of them spells it.
  assert.equal(handleHash("X", "dani"), handleHash("x", "dani"));
});

test("the same handle in two namespaces is two different hashes", () => {
  assert.notEqual(handleHash("x", "dani"), handleHash("discord", "dani"));
});

test("the typed-data domain binds the chain and the contract", () => {
  const a = releaseDomain(5042002, "0x1111111111111111111111111111111111111111");
  const b = releaseDomain(5042002, "0x2222222222222222222222222222222222222222");
  assert.notDeepEqual(a, b);
  assert.equal(a.name, "Splitsy HandleEscrow");
  assert.equal(a.version, "1");
  assert.equal(a.chainId, 5042002);
});

test("the Release type matches the contract's typehash", () => {
  // keccak256("Release(uint256 id,address to,uint256 deadline)") — the same
  // string RELEASE_TYPEHASH is built from in HandleEscrow.sol. If the field
  // names or their order ever drift, every release reverts with BadSignature.
  const encoded = `Release(${RELEASE_TYPES.Release.map((f) => `${f.type} ${f.name}`).join(",")})`;
  assert.equal(encoded, "Release(uint256 id,address to,uint256 deadline)");
});

test("the domain separator is the one HandleEscrow.sol's constructor builds", () => {
  // THE PIN THE SOLIDITY SIDE DOES NOT HAVE. HandleEscrow.t.sol reads
  // RELEASE_TYPEHASH() and DOMAIN_SEPARATOR() back off the contract to build its
  // digest, so that suite passes just as happily with "Splitsy Handle Escrow" or
  // version "2" — it compares the contract to itself. Nothing else checks these
  // two strings against anything.
  //
  // So the literals are SPELLED OUT HERE rather than imported from
  // ./handle-escrow.ts: a check that imports the value it is checking cannot
  // notice an edit to it. Compare with the abi.encode in the constructor —
  // typehash, name, version, chainId, address, in that order.
  //
  // Drift here is silent everywhere it is cheap to catch and fatal where it is
  // not: the browser deposits fine, the server signs fine, and every release
  // reverts with BadSignature against real money on Arc.
  const verifyingContract = "0x3333333333333333333333333333333333333333";
  const expected = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(toHex("Splitsy HandleEscrow")),
        keccak256(toHex("1")),
        5042002n,
        verifyingContract,
      ],
    ),
  );
  // viem's domainSeparator is hashDomain with the field list derived from the
  // domain itself, so dropping or adding a field changes this too.
  assert.equal(domainSeparator({ domain: releaseDomain(5042002, verifyingContract) }), expected);
});

test("the ABI names the contract's reverts instead of 'unknown reason'", () => {
  // CAPTURED FROM ARC, not constructed here: this is the exact revert data an
  // eth_call to a HandleEscrow deployed with maxReleasePerDay = 2000 base units
  // returned for a $2.10 deposit. Without the error entries in HANDLE_ESCROW_ABI
  // viem cannot decode it and the user is told "Execution reverted for an
  // unknown reason", which names neither the number that was wrong nor the limit
  // it broke. The deposit route, the browser rail and the release signer all
  // decode against this one array, so this check covers all three.
  const onChainRevert =
    "0x0ea9df32" +
    "0000000000000000000000000000000000000000000000000000000000200b20" +
    "00000000000000000000000000000000000000000000000000000000000007d0";
  const decoded = decodeErrorResult({ abi: HANDLE_ESCROW_ABI, data: onChainRevert as `0x${string}` });
  assert.equal(decoded.errorName, "AmountExceedsDailyLimit");
  assert.deepEqual(decoded.args, [2_100_000n, 2_000n]);

  // Every error the contract can throw, so the one left out is not discovered in
  // production. Compare with the `error` list in HandleEscrow.sol.
  const named = HANDLE_ESCROW_ABI.filter((i) => i.type === "error").map((i) => i.name).sort();
  assert.deepEqual(named, [
    "AmountExceedsDailyLimit",
    "BadSignature",
    "DailyLimitExceeded",
    "DepositExpired",
    "InvalidAmount",
    "InvalidConfiguration",
    "InvalidRecipient",
    "NoSuchDeposit",
    "NotDepositor",
    "SignatureExpired",
  ]);
});

test("every argument the encoders take lands in its own slot", () => {
  // THE TYPE CHECKER CANNOT GUARD THIS. encodeRelease takes `id` and `deadline`
  // as two bigints and `to` and `signature` as two `0x${string}`s, so swapping
  // either pair compiles clean — and a release signed over the wrong (id,
  // deadline) reverts BadSignature on Arc, against real money, in production
  // and nowhere else. These are the only two functions here that build
  // money-moving calldata, so they get the one check that fails if an argument
  // ever moves.
  //
  // The values are deliberately all different from each other: matching ones
  // would survive a swap and prove nothing.
  const hash = handleHash("x", "dani");
  assert.deepEqual(decodeFunctionData({ abi: HANDLE_ESCROW_ABI, data: encodeDeposit(hash, 4_200_000n) }), {
    functionName: "deposit",
    args: [hash, 4_200_000n], // 4_200_000 units is $4.20 — USDC carries 6 decimals
  });

  // A digits-only address on purpose: viem checksums an address on the way back
  // out, so 0xaaaa… would decode as 0xaAaA… and fail on case alone.
  const to = "0x1234567890123456789012345678901234567890";
  const signature: `0x${string}` = `0x${"bb".repeat(65)}`;
  assert.deepEqual(
    decodeFunctionData({ abi: HANDLE_ESCROW_ABI, data: encodeRelease(7n, to, 1_800_000_000n, signature) }),
    { functionName: "release", args: [7n, to, 1_800_000_000n, signature] },
  );
});
