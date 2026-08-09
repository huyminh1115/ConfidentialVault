# FHEVM Hardhat Template

A Hardhat-based template for developing Fully Homomorphic Encryption (FHE) enabled Solidity smart contracts using the
FHEVM protocol by Zama.

## Quick Start

For detailed instructions see:
[FHEVM Hardhat Quick Start Tutorial](https://docs.zama.ai/protocol/solidity-guides/getting-started/quick-start-tutorial)

### Prerequisites

- **Node.js**: Version 20 or higher
- **npm or yarn/pnpm**: Package manager

### Installation

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Set up environment variables**

   ```bash
   npx hardhat vars set MNEMONIC

   # Set your Infura API key for network access
   npx hardhat vars set INFURA_API_KEY

   # Optional: Set Etherscan API key for contract verification
   npx hardhat vars set ETHERSCAN_API_KEY
   ```

3. **Compile and test**

   ```bash
   npm run compile
   npm run test
   npm run test:gas   # emits per-function gas + tx size stats
   ```

4. **Deploy to local network**

   ```bash
   # Start a local FHEVM-ready node
   npx hardhat node
   # Deploy to local network
   npx hardhat deploy --network localhost
   ```

5. **Deploy to Sepolia Testnet**

   ```bash
   # Deploy to Sepolia
   npx hardhat deploy --network sepolia
   # Set CONTRACT_ADDRESS to the address printed by deployment.
   : "${CONTRACT_ADDRESS:?Set CONTRACT_ADDRESS to your deployed contract address}"
   npx hardhat verify --network sepolia "$CONTRACT_ADDRESS"
   ```

6. **Test on Sepolia Testnet**

   ```bash
   # Once deployed, you can run a simple test on Sepolia.
   npx hardhat test --network sepolia
   ```

## Reproduce the standalone-paper Table 4 Zama benchmark

This is a **local Hardhat mock-fhEVM** measurement procedure, not a Sepolia test. It uses the checked-in solc 0.8.28,
optimizer 200-run, `viaIR: true` settings in [`hardhat.config.ts`](hardhat.config.ts). Verify those settings by
compiling; do not override compiler settings on the command line.

1. Pin the validated Node.js version and install the lockfile dependencies from this directory:

   ```bash
   export NVM_DIR="$HOME/.nvm"
   . "$NVM_DIR/nvm.sh"
   nvm install 22.16.0
   nvm use 22.16.0
   node --version # v22.16.0
   npm ci
   npx hardhat compile
   ```

2. Create a fresh dated directory for local-only observations. Never write a normal run to the protected attested
   campaign directory:

   ```bash
   RESULTS_ROOT="$HOME/benchmark-results/$(date +%F)-table4-zama"
   mkdir -p "$RESULTS_ROOT"
   ```

   The protected directory is
   `~/.cache/confidential-vault-benchmarks/attested-node-v22.16.0-solc-0.8.28-runs-200-viair`. Its Zama artifact has
   SHA-256 `6a53d7448ffe4a78b00126a8aa2ed107d912327c7c2a7c947598e2bcd90a9903`, which may be used only as an optional
   reference comparison. `BENCHMARK_OVERWRITE=1` is deliberately excluded from this guide: it is destructive and only
   permits intentional replacement of an existing artifact.

3. Run the dedicated benchmark test:

   ```bash
   BENCHMARK_TRIALS=30 BENCHMARK_RESULTS_DIR="$RESULTS_ROOT" npx hardhat test test/BenchmarkGas.ts
   ```

   This is **not** `npm run test:gas`; that script enables the generic gas reporter and does not run the controlled
   Table 4 campaign. The command creates `$RESULTS_ROOT/zama-gas.json` with the raw observations and host manifest.

For each operation, the harness prepares a valid operation-ready fixture, restores the same Hardhat snapshot before
every one of 30 measured transactions, and reports transaction-receipt `gasUsed`. It measures five rows: deposit,
withdraw, `updateSnapshot`, `requestUpdateRatio`, and `finalizeUpdateRatio`. A complete ratio update is the three-step
`updateSnapshot` + `requestUpdateRatio` + `finalizeUpdateRatio` workflow. Decryption-service fees and off-chain
decryption latency are excluded.

### Reference values, not cross-host guarantees

On the attested Apple M1 Pro / macOS arm64 / Node 22.16.0 host, the receipt-gas means were:

| Operation                      | Mean gas |
| ------------------------------ | -------: |
| Deposit                        |  735,261 |
| Withdraw                       |  659,754 |
| `updateSnapshot`               |  200,511 |
| `requestUpdateRatio`           |  283,966 |
| `finalizeUpdateRatio`          |   94,667 |
| Complete ratio-update workflow |  579,144 |

All 30 trials in that controlled campaign had sample SD 0. These figures are references, not a promise of identical
results with another host, dependency set, or fixture. The paper retains its ERC-4626 figures only as a legacy
contextual baseline and makes no percentage-overhead claim from them.

### Known normalized-build limitation

The required solc 0.8.28 / optimizer 200 / `viaIR: true` configuration causes three existing fhEVM functional paths to
fail with internal `@fhevm/hardhat-plugin` assertions. The dedicated benchmark above passes under the same pinned
configuration. This is a known plugin-compatibility limitation; do not change the benchmark compiler settings merely to
make those paths pass.

## 📁 Project Structure

```
fhevm-hardhat-template/
├── contracts/           # Smart contract source files
│   └── FHECounter.sol   # Example FHE counter contract
├── deploy/              # Deployment scripts
├── tasks/               # Hardhat custom tasks
├── test/                # Test files
├── hardhat.config.ts    # Hardhat configuration
└── package.json         # Dependencies and scripts
```

## 📜 Available Scripts

| Script             | Description                  |
| ------------------ | ---------------------------- |
| `npm run compile`  | Compile all contracts        |
| `npm run test`     | Run all tests                |
| `npm run test:gas` | Run tests with gas + tx logs |
| `npm run coverage` | Generate coverage report     |
| `npm run lint`     | Run linting checks           |
| `npm run clean`    | Clean build artifacts        |

## 📚 Documentation

- [FHEVM Documentation](https://docs.zama.ai/fhevm)
- [FHEVM Hardhat Setup Guide](https://docs.zama.ai/protocol/solidity-guides/getting-started/setup)
- [FHEVM Testing Guide](https://docs.zama.ai/protocol/solidity-guides/development-guide/hardhat/write_test)
- [FHEVM Hardhat Plugin](https://docs.zama.ai/protocol/solidity-guides/development-guide/hardhat)

## 📄 License

This project is licensed under the BSD-3-Clause-Clear License. See the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/zama-ai/fhevm/issues)
- **Documentation**: [FHEVM Docs](https://docs.zama.ai)
- **Community**: [Zama Discord](https://discord.gg/zama)

---

**Built with ❤️ by the Zama team**
