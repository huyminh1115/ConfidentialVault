#!/bin/sh
# Run from any working directory; keep generated results outside tracked evidence.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
case "${1:-}" in
  ''|--check) ;;
  *) echo "Usage: sh scripts/reproduce-paper.sh [--check]" >&2; exit 2 ;;
esac
if [ ! -x node_modules/.bin/hardhat ]; then
  echo "Dependencies missing. Run make setup first (Node 22.16.0 recommended)." >&2
  exit 1
fi
if [ "${1:-}" = --check ]; then
  echo "Required files are present. This check does not validate proofs or run benchmarks."
  exit 0
fi
BENCHMARK_RESULTS_DIR="${BENCHMARK_RESULTS_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/fisat-fhe.XXXXXX")}"
mkdir -p "$BENCHMARK_RESULTS_DIR"
for output in zama-gas.json; do
  if [ -e "$BENCHMARK_RESULTS_DIR/$output" ]; then
    echo "Refusing to overwrite $BENCHMARK_RESULTS_DIR/$output. Choose a fresh directory." >&2
    exit 1
  fi
done
export BENCHMARK_RESULTS_DIR
export BENCHMARK_TRIALS=30
printf 'Writing new observations to %s\n' "$BENCHMARK_RESULTS_DIR"
npm run compile
node_modules/.bin/hardhat test test/BenchmarkGas.ts --network hardhat
printf 'Results saved in %s\n' "$BENCHMARK_RESULTS_DIR"
