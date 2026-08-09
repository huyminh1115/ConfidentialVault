import fs from "fs";
import os from "os";
import path from "path";
import { runBenchmark } from "../scripts/benchmark-gas";

describe("local 30-trial gas benchmark", function () {
  this.timeout(30 * 60 * 1000);

  it("restores an operation-ready snapshot before every measured transaction", async function () {
    const outputDir =
      process.env.BENCHMARK_RESULTS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "confidential-vault-benchmark-test-"));
    await runBenchmark(outputDir);
  });
});
