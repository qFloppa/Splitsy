import assert from "node:assert/strict";
import { test } from "node:test";
import { domainSeparator, encodeAbiParameters, keccak256, toHex } from "viem";
import { handleHash, releaseDomain, RELEASE_TYPES } from "./handle-escrow.ts";

test("the hash is keccak256 of '<provider>:<handle>'", () => {
  assert.equal(handleHash("email", "dani@example.com"), keccak256(toHex("email:dani@example.com")));
});

test("handles are normalized the same way the rest of the app does", () => {
  // A leading @ is stripped and case is folded, so @Dani, Dani and dani are one
  // person. Without this, tagging @Dani and signing in as dani are two escrows.
  assert.equal(handleHash("x", "@Dani"), handleHash("x", "dani"));
  assert.equal(handleHash("email", "OK@Splitsy.xyz"), handleHash("email", "ok@splitsy.xyz"));
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
  // domain itself, so dropping or reordering a field changes this too.
  assert.equal(domainSeparator({ domain: releaseDomain(5042002, verifyingContract) }), expected);
});
