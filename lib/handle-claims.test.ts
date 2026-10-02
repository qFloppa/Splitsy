import assert from "node:assert/strict";
import { test } from "node:test";
import { claimAndListHandles, type ClaimDeps } from "./handle-claims.ts";

// Stub deps over an in-memory claim table, keyed the way the real one is.
// `claims` is (provider:handle) -> userId, and claiming never overwrites — the
// property the whole guard rests on, so the stub enforces it rather than
// assuming the caller is careful.
function deps(claims: Record<string, string> = {}) {
  const calls: string[] = [];
  const impl: ClaimDeps = {
    claim: async (provider, handle, userId) => {
      const key = `${provider.toLowerCase()}:${handle.replace(/^@/, "").toLowerCase()}`;
      calls.push(key);
      if (!(key in claims)) claims[key] = userId;
    },
    listForUser: async (userId) =>
      Object.entries(claims)
        .filter(([, owner]) => owner === userId)
        .map(([key]) => key.split(":").slice(1).join(":")),
  };
  return { impl, claims, calls };
}

test("a first login claims its handle and collects under it", async () => {
  const { impl, claims } = deps();
  assert.deepEqual(await claimAndListHandles("user-1", "x", "dani", impl), ["dani"]);
  assert.equal(claims["x:dani"], "user-1");
});

test("after a rename, both handles are collected under", async () => {
  // The old handle is where the money is: an escrow deposit under
  // keccak256("x:alice"), and a slot named by a bill before they signed in.
  const { impl } = deps({ "x:alice": "user-1" });
  assert.deepEqual(await claimAndListHandles("user-1", "x", "bob", impl), ["bob", "alice"]);
});

test("the current handle comes first", async () => {
  // One chain read per handle on a login, so the handle that almost always holds
  // the money is the one asked about first.
  const { impl } = deps({ "x:one": "user-1", "x:two": "user-1" });
  const handles = await claimAndListHandles("user-1", "x", "two", impl);
  assert.equal(handles[0], "two");
  assert.deepEqual([...handles].sort(), ["one", "two"]);
});

test("a re-registered handle collects nothing", async () => {
  // THE GUARD. @alice was renamed away from and somebody else took it on X. They
  // can authenticate as @alice, so without the claim table this login would look
  // exactly like the original owner's — and on the slot path it would bind
  // @alice's refunds to their wallet, write-once and unfixable.
  const { impl, claims } = deps({ "x:alice": "owner" });
  assert.deepEqual(await claimAndListHandles("squatter", "x", "alice", impl), []);
  // And the claim still names the original owner: the attempt changed nothing.
  assert.equal(claims["x:alice"], "owner");
});

test("the original owner keeps a handle they renamed back to", async () => {
  // alice -> bob -> alice. The first claim never moved, so coming back is not a
  // re-registration and is not treated as one.
  const { impl } = deps({ "x:alice": "user-1", "x:bob": "user-1" });
  assert.deepEqual(await claimAndListHandles("user-1", "x", "alice", impl), ["alice", "bob"]);
});

test("the current handle is normalized before it is matched", async () => {
  // X reports "qFloppa" and a bill was tagged "@qfloppa". If these did not land on
  // the same string the handle would look unclaimed, the list would hold both
  // spellings, and the second lookup would be for money that is not there.
  const { impl } = deps({ "x:qfloppa": "user-1" });
  assert.deepEqual(await claimAndListHandles("user-1", "x", "@qFloppa", impl), ["qfloppa"]);
});

test("an email handle keeps its dots and @", async () => {
  // The email namespace's handle IS an address, so the key has a second colon in
  // it. Nothing may split on that — it would claim "example.com".
  const { impl, claims } = deps();
  assert.deepEqual(
    await claimAndListHandles("user-1", "email", "dani@example.com", impl),
    ["dani@example.com"],
  );
  assert.equal(claims["email:dani@example.com"], "user-1");
});
