# Paper reproduction

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
