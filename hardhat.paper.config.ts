import base from "./hardhat.config";
import type { HardhatUserConfig } from "hardhat/config";

// Explicit common settings for the local paper campaign; no public network.
const config: HardhatUserConfig = {
  ...base,
  defaultNetwork: "hardhat",
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      metadata: { bytecodeHash: "ipfs", useLiteralContent: true },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.methodIdentifiers", "metadata", "devdoc", "userdoc", "storageLayout", "evm.gasEstimates"], "": ["ast"] } },
    },
  },
  networks: {
    hardhat: {
      accounts: { mnemonic: "test test test test test test test test test test test junk" },
      chainId: 31337,
      hardfork: "prague",
      initialDate: "2026-10-09T00:00:00Z",
      blockGasLimit: 30000000,
      initialBaseFeePerGas: 1000000000,
      mining: { auto: true, interval: 0 },
    },
  },
  paths: { ...base.paths, artifacts: "./artifacts/paper", cache: "./cache/paper" },
};
export default config;
