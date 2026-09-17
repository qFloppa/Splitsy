import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.36",
        // Pinned: Arc runs the Cancun instruction set. 0.8.30+ defaults to
        // `prague`, which would emit opcodes the chain may not accept.
        settings: {
          evmVersion: "cancun",
        },
      },
      production: {
        version: "0.8.36",
        // Pinned: Arc runs the Cancun instruction set. 0.8.30+ defaults to
        // `prague`, which would emit opcodes the chain may not accept.
        settings: {
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Both Arc networks read the SAME ARC_RPC_URL, because a deployment's
    // .env.local describes one deployment — the app reads it the same way
    // (lib/arc-chain.ts). The consequence, said plainly: `--network arcMainnet`
    // with a testnet ARC_RPC_URL deploys to testnet under a mainnet name.
    // Nothing here checks that; point the variable at the chain you named.
    arcTestnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("ARC_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    arcMainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("ARC_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
  // Arc is not in hardhat-verify's built-in chain list, so the explorer has to be
  // named here or `hardhat verify` has nowhere to send the source. Arcscan is
  // Blockscout, which takes no API key.
  chainDescriptors: {
    5042: {
      name: "Arc",
      blockExplorers: {
        blockscout: {
          name: "Arc Explorer",
          url: "https://explorer.arc.io",
          apiUrl: "https://explorer.arc.io/api",
        },
      },
    },
    5042002: {
      name: "Arc Testnet",
      blockExplorers: {
        blockscout: {
          name: "Arcscan",
          url: "https://testnet.arcscan.app",
          apiUrl: "https://testnet.arcscan.app/api",
        },
      },
    },
  },
  verify: {
    blockscout: { enabled: true },
  },
});
