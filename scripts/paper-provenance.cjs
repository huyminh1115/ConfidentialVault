const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
module.exports = function provenance(hre) {
  const files = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[file] = sha(file);
    }
  }
  walk("contracts");
  for (const f of ["package.json", "package-lock.json", "hardhat.config.ts", "hardhat.paper.config.ts", "scripts/paper-provenance.cjs",
    "scripts/benchmark-matched.mjs", "scripts/benchmark-matched.ts", "test/BenchmarkMatched.ts"]) {
    if (fs.existsSync(f)) files[f] = sha(f);
  }
  const builds = fs.readdirSync(path.join(hre.config.paths.artifacts, "build-info")).filter(f => f.endsWith(".json")).map(f => {
    const file = path.join(hre.config.paths.artifacts, "build-info", f);
    const b = JSON.parse(fs.readFileSync(file));
    return { file: f, sha256: sha(file), solcLongVersion: b.solcLongVersion, settings: b.input.settings };
  });
  return {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim() !== "",
    files, builds,
    hardhat: require("hardhat/package.json").version,
    edr: require("@nomicfoundation/edr/package.json").version,
    network: { chainId: hre.network.config.chainId, hardfork: hre.network.config.hardfork,
      blockGasLimit: hre.network.config.blockGasLimit, initialBaseFeePerGas: hre.network.config.initialBaseFeePerGas,
      initialDate: hre.network.config.initialDate, mining: hre.network.config.mining },
    compiler: hre.config.solidity.compilers,
  };
};
