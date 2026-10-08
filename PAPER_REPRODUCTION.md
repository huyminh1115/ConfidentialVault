# Matched local campaign

Use Node **22.16.0**, then run `make reproduce-matched` from the repository root. For an installed checkout, `make benchmark-matched` skips dependency installation. The script requires Hardhat **2.26.3** and performs exactly 30 restored-snapshot trials per operation; it creates a new temporary results directory and prints its path. Set `BENCHMARK_RESULTS_DIR` to a fresh directory to keep results elsewhere. Existing observations are never overwritten.

`hardhat.paper.config.ts` explicitly fixes solc 0.8.28, optimizer 200, viaIR, Cancun compiler target, IPFS metadata, Prague Hardhat execution, chain ID 31337, automatic mining, initial base fee 1 gwei, block gas limit 30 million, and a common starting date and public test mnemonic. It leaves the normal deployment configuration unchanged. The new FHE lockfile aligns Hardhat to the ZK repository's version.

All three implementations start with 10,000 raw user asset units, deposit 100 units into an empty vault at one share per asset, or fully withdraw the preceding 100-unit deposit. Rate-update fixtures contain 100 assets and 300 shares, prepared by owner-authorized minting outside measurement. ZK uses ratio precision 0 (encoded initial ratio 1 and new ratio 3); FHE uses six-decimal ratios (1,000,000 and 3,000,000). Token decimals and custody/authorization models differ; equal raw amounts are not a claim of identical token economics or security. No production contract is changed.

Every measured receipt must succeed. The harness checks share/asset outcomes after deposit and withdrawal and verifies the updated ratio after finalization. ZK ciphertext checks include pending settlement; FHE checks decrypt local mock balances. These checks happen outside the measured transaction and do not constitute a general security proof. Off-chain proving, encryption, decryption, deployment and setup are excluded from receipt gas. The same encrypted/proof input is reused after each snapshot restore; zero within-run SD is not zero between-run variance. Fresh cryptographic payload bytes may alter intrinsic gas between campaigns.

Outputs contain all gas and calldata samples, input hashes, sample statistics, exact source commit, source/lock/config SHA-256 hashes, actual compiler build settings, Hardhat/EDR versions and host metadata. Use raw means for the gas/calldata table; FHE rate gas sums the three stage means. The FHE runtime remains **mocked** and excludes coprocessor computation, real relayer/decryption latency and service fees. Matching local conditions does not establish an end-to-end production ZK–FHE performance ranking.

The output is `zama-matched-gas.json`; its calldata lengths are measured from the submitted transactions, not copied from historical values. The three rate stages are `updateSnapshot`, `requestUpdateRatio`, and `finalizeUpdateRatio`.

# Earlier campaign commands

From this repository root, with Node 22.16.0 and npm:

```sh
make reproduce
```

This installs the lockfile dependencies, compiles with the checked-in settings, and runs `test/BenchmarkGas.ts` on the local Hardhat mock network with 30 trials per operation. It does not deploy to a public network or require a funded wallet. `make setup`, `make check`, and `make benchmark` are available separately; `make help` describes them.

## Outputs and table construction

The helper creates a fresh temporary result directory and prints its path. To use a persistent directory:

```sh
BENCHMARK_RESULTS_DIR=/path/to/new-results make benchmark
```

The helper refuses to overwrite an existing `zama-gas.json`. That file contains raw gas observations, means, sample standard deviations, and host metadata. The rate-update row is the sum of the `updateSnapshot`, `requestUpdateRatio`, and `finalizeUpdateRatio` means. The retained historical total is 200511 + 283966 + 94667 = 579144 gas.

This is the dedicated benchmark, not the generic `npm run test:gas` report. It records gas, not calldata sizes, real FHE computation, service fees, or off-chain decryption latency. New measurements do not overwrite or replace the historical campaign. The helper changes no contract, fixture, compiler setting, or measurement method.

The README documents existing plugin assertion failures in other functional paths; a passing benchmark does not establish correctness of every operation.
