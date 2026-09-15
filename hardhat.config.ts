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
    arcTestnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("ARC_TESTNET_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
  // Arc is not in hardhat-verify's built-in chain list, so the explorer has to be
  // named here or `hardhat verify` has nowhere to send the source. Arcscan is
  // Blockscout, which takes no API key.
  chainDescriptors: {
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
