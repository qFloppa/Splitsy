import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The bug this guards, in full: `getWalletClient(config, { chainId })` does not
// put the connector on that chain. It asserts. A payer sitting on Sepolia who
// pressed "Pay on Arc" got
//
//   The current chain of the connector (id: 11155111) does not match the
//   connection's chain (id: 5042002)
//
// reported to them as the reason their payment failed. Four call sites remembered
// to switchChain first and two did not, and one of the two was the public /pay
// link — the first button a stranger to Splitsy ever presses.
//
// arcWalletClient() in lib/wagmi.ts is the fix, and this is what keeps it the
// fix: a source-level invariant, because there is no runtime assertion that can
// catch "someone wrote the two-step version again by hand". Same shape as
// lib/site-contracts.test.ts — cheap, and it fails on the exact regression.

const ROOTS = ["app", "lib", "components"];
const SKIP_DIRS = new Set(["node_modules", ".next"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

const files = ROOTS.flatMap((root) => sourceFiles(root)).map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));

test("the repo has sources to check, so a broken walk can't pass as a clean result", () => {
  assert.ok(files.length > 50, `only walked ${files.length} files`);
  assert.ok(
    files.some((f) => f.path.endsWith(join("lib", "wagmi.ts"))),
    "lib/wagmi.ts was not walked",
  );
});

test("nothing asks wagmi for an Arc wallet client without switching to Arc first", () => {
  // Matches getWalletClient(...) whose options mention Arc's chain id — by the
  // arcTestnet.id reference or the literal — across line breaks.
  const pattern = /getWalletClient\s*\([^)]*chainId\s*:\s*(arcTestnet\.id|5042002)/s;
  // lib/wagmi.ts is the one legitimate caller: it is where the switch happens.
  // The next test is what holds it to that.
  const home = join("lib", "wagmi.ts");
  const offenders = files
    .filter((f) => !f.path.endsWith(home) && pattern.test(f.text))
    .map((f) => f.path);

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")} calls getWalletClient for Arc directly. Use arcWalletClient() from lib/wagmi.ts — ` +
      "it switches the connector to Arc first, which is the whole reason it exists.",
  );
});

test("arcWalletClient switches before it reads, not after", () => {
  const source = readFileSync(join("lib", "wagmi.ts"), "utf8");
  const body = source.slice(source.indexOf("export async function arcWalletClient"));

  const switchAt = body.indexOf("switchChain(");
  const readAt = body.indexOf("getWalletClient(");

  assert.ok(switchAt !== -1, "arcWalletClient no longer calls switchChain");
  assert.ok(readAt !== -1, "arcWalletClient no longer calls getWalletClient");
  assert.ok(switchAt < readAt, "arcWalletClient reads the wallet client before switching the chain");
});
