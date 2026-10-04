// The one definition of "which escrow deposit belongs to which handle".
//
// THREE PLACES COMPUTE THIS AND THEY MUST AGREE: the browser when it deposits,
// the server when it signs a release, and HandleEscrow.sol when it checks. A
// second copy anywhere is a deposit nobody can release — the money would sit
// under a hash no signature ever names.
//
// Pure and framework-free (no "use client", no next/*, no @/ aliases) so it
// stays importable by `node --test`. Same rule as lib/iou.ts.
import { encodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { normalizeHandle } from "./iou.ts";

/// The identifier a deposit is filed under.
///
/// NOT A SECRET. The input is a short, guessable string, so the hash is
/// brute-forceable in seconds — it is a filing key, never a password. Anything
/// that treats knowing this hash as proof of identity is wrong.
///
/// Normalized through the same helper the composer and the resolve route use,
/// because "@Dani" typed on a bill and "dani" reported by an OAuth login have to
/// land on the same string or the money never reaches them.
export function handleHash(provider: string, handle: string): `0x${string}` {
  return keccak256(toHex(`${provider.toLowerCase()}:${normalizeHandle(handle)}`));
}

// EVERY ERROR IS LISTED, and that is not completeness for its own sake. viem
// decodes a revert against this array and nothing else, so an error missing here
// reaches the user as "Execution reverted for an unknown reason" — which is what
// a $2.10 deposit said when it was really AmountExceedsDailyLimit(2100000, 2000)
// against an escrow deployed with its ceiling in whole USDC. A partial list is
// the same bug, waiting on whichever error was left out.
export const HANDLE_ESCROW_ABI = parseAbi([
  "error InvalidAmount()",
  "error AmountExceedsDailyLimit(uint256 amount, uint256 maximum)",
  "error InvalidConfiguration()",
  "error InvalidRecipient()",
  "error NoSuchDeposit(uint256 id)",
  "error DepositExpired(uint256 id, uint64 expiresAt)",
  "error DailyLimitExceeded(uint256 requested, uint256 available)",
  "error NotDepositor(uint256 id, address caller)",
  "error BadSignature()",
  "error SignatureExpired()",
  // NOT declared in HandleEscrow.sol — these come from SafeERC20 and
  // ReentrancyGuard, and the contract throws them all the same. The first is the
  // likeliest failure of a real deposit by a wide margin: safeTransferFrom
  // reverts with it when the depositor's allowance or balance is short, and it
  // names the token rather than the shortfall, so the sentence the user gets has
  // to come from above. Omitting them would leave the commonest deposit failure
  // reading "unknown reason" after the rest of this list was added to stop
  // exactly that.
  "error SafeERC20FailedOperation(address token)",
  "error ReentrancyGuardReentrantCall()",
  "function deposit(bytes32 handleHash, uint256 amount) returns (uint256)",
  "function release(uint256 id, address to, uint256 deadline, bytes signature)",
  "function reclaim(uint256 id)",
  "function deposits(uint256) view returns (address depositor, uint64 expiresAt, bytes32 handleHash, uint256 amount)",
  "function holdWindow() view returns (uint256)",
  "function maxReleasePerDay() view returns (uint128)",
  "function releasableNow() view returns (uint256)",
  "event Deposited(uint256 indexed id, address indexed depositor, bytes32 indexed handleHash, uint256 amount, uint64 expiresAt)",
  "event Released(uint256 indexed id, address indexed to, uint256 amount)",
  "event Reclaimed(uint256 indexed id, address indexed depositor, uint256 amount)",
]);

export const encodeReclaim = (id: bigint) =>
  encodeFunctionData({ abi: HANDLE_ESCROW_ABI, functionName: "reclaim", args: [id] });

export const encodeDeposit = (hash: `0x${string}`, amountUnits: bigint) =>
  encodeFunctionData({ abi: HANDLE_ESCROW_ABI, functionName: "deposit", args: [hash, amountUnits] });

export const encodeRelease = (id: bigint, to: `0x${string}`, deadline: bigint, signature: `0x${string}`) =>
  encodeFunctionData({ abi: HANDLE_ESCROW_ABI, functionName: "release", args: [id, to, deadline, signature] });

// The EIP-712 shape, mirroring RELEASE_TYPEHASH in HandleEscrow.sol. Field names
// and order are part of the hash: rename or reorder one and every signature
// stops verifying.
export const RELEASE_TYPES = {
  Release: [
    { name: "id", type: "uint256" },
    { name: "to", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// Chain id and contract address are in the domain, so a signature made for one
// deployment cannot be replayed against another.
export const releaseDomain = (chainId: number, verifyingContract: `0x${string}`) =>
  ({ name: "Splitsy HandleEscrow", version: "1", chainId, verifyingContract }) as const;
