import { randomBytes } from "crypto";
import {
  initiateDeveloperControlledWalletsClient,
  registerEntitySecretCiphertext,
} from "@circle-fin/developer-controlled-wallets";

// One-shot setup for developer-controlled wallets. Run once:
//   node --env-file=.env.local --experimental-strip-types scripts/circle-dcw-setup.ts
// Prints CIRCLE_ENTITY_SECRET (first run) and CIRCLE_WALLET_SET_ID to paste into
// .env.local. Registering the entity secret also writes a recovery file to
// ./recovery — store it securely; Circle cannot recover it for you.

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey || apiKey.includes("your_circle_api_key")) {
  throw new Error("Set a real CIRCLE_API_KEY in .env.local first.");
}

let entitySecret = process.env.CIRCLE_ENTITY_SECRET;
if (!entitySecret) {
  entitySecret = randomBytes(32).toString("hex");
  await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: "./recovery" });
  console.log("\nRegistered a NEW entity secret. Save both of these:");
  console.log(`CIRCLE_ENTITY_SECRET=${entitySecret}`);
  console.log("Recovery file written under ./recovery — store it securely (Circle can't recover it).");
} else {
  console.log("Using existing CIRCLE_ENTITY_SECRET from env.");
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const res = await client.createWalletSet({ name: "Splitsy wallet set" });
const walletSetId = res.data?.walletSet?.id;
if (!walletSetId) {
  throw new Error("Wallet set creation failed: no ID returned");
}

console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);
console.log("\nAdd the CIRCLE_* line(s) above to .env.local, then restart the dev server.");
