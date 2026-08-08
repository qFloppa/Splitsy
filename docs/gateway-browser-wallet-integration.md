# Gateway Browser Wallet Integration

## Overview

Gateway allows users to pay USDC from **any supported testnet chain** (Polygon, Avalanche, Base, Ethereum) and settle on **Arc Testnet** — all from their browser wallet.

This replaces the previous DCW-only Gateway implementation with a proper client-side flow using Circle's official Gateway contracts.

## How It Works

### Two-Step Flow

1. **Sign burn intent on source chain** — User signs an EIP-712 message authorizing Gateway to burn USDC on their source chain (e.g., Avalanche Fuji)
2. **Mint on destination chain** — Circle's API returns an attestation; user switches to Arc Testnet and executes the mint transaction

### Key Files

- **`lib/gateway-contracts.ts`** — Contract addresses and chain configs for all supported testnets (Arc, Avalanche, Base, Ethereum)
- **`lib/gateway-browser.ts`** — Client-side Gateway logic: EIP-712 signing, API attestation, mint transaction preparation
- **`app/pay/[token]/PayClient.tsx`** — UI integration: chain picker dropdown, two-step payment flow with network switching

## User Experience

1. User selects debts to pay on the pay-link page
2. Clicks "Pay via Gateway" button
3. Selects source chain from dropdown (Polygon, Avalanche, Base, Ethereum)
4. Wallet prompts for EIP-712 signature on source chain (gas-free)
5. Wallet prompts to switch to Arc Testnet
6. Wallet prompts to execute mint transaction on Arc (pays gas in ETH)
7. Payment settles on-chain on Arc Testnet

## API Flow

```typescript
// Step 1: Sign burn intent
const burnIntent = {
  maxBlockHeight: maxUint64,
  maxFee: 2_010000n, // 2.01 USDC
  spec: {
    sourceDomain: 1, // Avalanche
    destinationDomain: 26, // Arc
    sourceContract: "0x0077777d...", // GatewayWallet on Avalanche
    destinationContract: "0x0022222A...", // GatewayMinter on Arc
    value: parseUnits("10.00", 6), // 10 USDC
    // ... other fields
  }
};

const signature = await walletClient.signTypedData({
  domain: { name: "GatewayWallet", version: "1" },
  primaryType: "BurnIntent",
  types: EIP712_TYPES,
  message: burnIntent,
});

// Step 2: Submit to Gateway API
const response = await fetch("https://gateway-api-testnet.circle.com/v1/transfer", {
  method: "POST",
  body: JSON.stringify([{ burnIntent, signature }]),
});

const { attestation, signature: apiSignature } = await response.json();

// Step 3: Execute mint on Arc
await writeContract(wagmiConfig, {
  address: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B", // GatewayMinter on Arc
  abi: gatewayMinterAbi,
  functionName: "gatewayMint",
  args: [attestation, apiSignature],
});
```

## Supported Chains (Testnet)

| Chain | Domain | USDC Address | Gateway Wallet | Gateway Minter |
|-------|--------|--------------|----------------|----------------|
| Arc Testnet | 26 | `0x3600...0000` | `0x0077...19B9` | `0x0022...475B` |
| Avalanche Fuji | 1 | `0x5425...Bc65` | `0x0077...19B9` | `0x0022...475B` |
| Base Sepolia | 6 | `0x036C...CF7e` | `0x0077...19B9` | `0x0022...475B` |
| Ethereum Sepolia | 0 | `0x1c7D...7238` | `0x0077...19B9` | `0x0022...475B` |

## Design Changes

### Clash Display Light

The merchant name and amount on `/pay` pages now use **Clash Display Light** (`font-weight: 300`) for a refined, elegant look.

### Gateway Button Tooltip

Updated to clarify:
- **"Pay with Splitsy wallet"** → "Arc Testnet only"
- **"Pay via Gateway"** → "Cross-chain payment (requires any supported chain wallet)"

## Configuration

No API keys needed — Gateway is **permissionless infrastructure**. The testnet endpoint is public.

Optional: Set `NEXT_PUBLIC_CIRCLE_GATEWAY_API_KEY` in `.env` for rate limit increases (not required for basic usage).

## Testing

1. Fund a wallet with test USDC on any supported testnet:
   - [Avalanche Fuji Faucet](https://core.app/tools/testnet-faucet/)
   - [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet)
   - [Ethereum Sepolia Faucet](https://www.alchemy.com/faucets/ethereum-sepolia)

2. Create a bill on Arc Testnet

3. Navigate to the pay-link, select Gateway payment, choose your funded chain

4. Sign and mint — the payment settles on Arc within seconds

## References

- [Circle Gateway Docs](https://developers.circle.com/gateway)
- [Gateway Testnet API](https://gateway-api-testnet.circle.com/v1)
- [Supported Blockchains](https://developers.circle.com/gateway/references/supported-blockchains)
