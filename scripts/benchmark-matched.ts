/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { FhevmType } from "@fhevm/hardhat-plugin";
import hre from "hardhat";
const provenance = require("./paper-provenance.cjs");
import os from "os";
import path from "path";
import process from "process";
import { ethers, fhevm } from "hardhat";

const TRIALS = Number(process.env.BENCHMARK_TRIALS ?? 30);
const BASE_RATE = 1_000_000n;
const defaultCliOutputDir = path.join(os.homedir(), ".cache", "confidential-vault-benchmarks");

type GasResult = { gasUsed: string[]; calldataBytes: number[]; transactionInputSha256: string[]; statistics: { meanGas: number; sampleStddevGas: number; meanCalldataBytes: number; sampleStddevCalldataBytes: number } };

type VaultFixture = {
  deployer: any;
  alice: any;
  bob: any;
  underlying: any;
  vault: any;
};

function mean(values: bigint[]) {
  return values.reduce((total, value) => total + Number(value), 0) / values.length;
}

function sampleStddev(values: bigint[]) {
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (Number(value) - average) ** 2, 0) / (values.length - 1));
}

async function snapshot() {
  return ethers.provider.send("evm_snapshot", []);
}

async function revert(snapshotId: string) {
  const restored = await ethers.provider.send("evm_revert", [snapshotId]);
  if (!restored) throw new Error(`Unable to restore snapshot ${snapshotId}`);
}

async function createEncryptedInput(contractAddress: string, signer: any, amount: bigint) {
  return fhevm.createEncryptedInput(contractAddress, signer.address).add64(amount).encrypt();
}

async function deployVault(): Promise<VaultFixture> {
  if (!fhevm.isMock) throw new Error("The local benchmark requires the fhEVM mock network");

  const [deployer, alice, bob] = await ethers.getSigners();
  const tokenFactory = await ethers.getContractFactory("ERC7984MintableBurnable", deployer);
  const underlying = await tokenFactory.deploy(deployer.address, "Underlying", "uTKN", "");
  await underlying.waitForDeployment();

  const vaultFactory = await ethers.getContractFactory("ConfidentialVault", deployer);
  const vault = await vaultFactory.deploy("Vault Share", "vSHARE", "", await underlying.getAddress());
  await vault.waitForDeployment();

  return { deployer, alice, bob, underlying, vault };
}

async function mintToUser(fixture: VaultFixture, user: any, amount: bigint) {
  const encrypted = await createEncryptedInput(await fixture.underlying.getAddress(), fixture.deployer, amount);
  await (
    await fixture.underlying.connect(fixture.deployer).mint(user.address, encrypted.handles[0], encrypted.inputProof)
  ).wait();
}

async function setOperator(fixture: VaultFixture, user: any) {
  const latestBlock = await ethers.provider.getBlock("latest");
  const expiry = BigInt(latestBlock!.timestamp + 3600);
  await (await fixture.underlying.connect(user).setOperator(await fixture.vault.getAddress(), expiry)).wait();
}

async function deposit(fixture: VaultFixture, user: any, amount: bigint) {
  const encrypted = await createEncryptedInput(await fixture.vault.getAddress(), user, amount);
  return fixture.vault.connect(user).confidentialDeposit(user.address, encrypted.handles[0], encrypted.inputProof);
}

async function clearBalance(contract: any, signer: any) {
  const handle = await contract.confidentialBalanceOf(signer.address);
  return fhevm.userDecryptEuint(FhevmType.euint64, handle.toString(), await contract.getAddress(), signer);
}

async function createDepositFixture() {
  const fixture = await deployVault();
  await mintToUser(fixture, fixture.alice, 10_000n);
  await setOperator(fixture, fixture.alice);
  const encrypted = await createEncryptedInput(await fixture.vault.getAddress(), fixture.alice, 100n);
  const operationSnapshot = await snapshot();

  return {
    snapshot: operationSnapshot,
    async measure() {
      const receipt = await (
        await fixture.vault
          .connect(fixture.alice)
          .confidentialDeposit(fixture.alice.address, encrypted.handles[0], encrypted.inputProof)
      ).wait();
      assert.equal(await clearBalance(fixture.vault, fixture.alice), 100n);
      assert.equal(await clearBalance(fixture.underlying, fixture.alice), 9_900n);
      return receipt!;
    },
  };
}

async function createWithdrawFixture() {
  const fixture = await deployVault();
  await mintToUser(fixture, fixture.alice, 10_000n);
  await setOperator(fixture, fixture.alice);
  await (await deposit(fixture, fixture.alice, 100n)).wait();
  const encrypted = await createEncryptedInput(await fixture.vault.getAddress(), fixture.alice, 100n);
  const operationSnapshot = await snapshot();

  return {
    snapshot: operationSnapshot,
    async measure() {
      const receipt = await (
        await fixture.vault
          .connect(fixture.alice)
          .confidentialWithdraw(fixture.alice.address, encrypted.handles[0], encrypted.inputProof)
      ).wait();
      assert.equal(await clearBalance(fixture.vault, fixture.alice), 0n);
      assert.equal(await clearBalance(fixture.underlying, fixture.alice), 10_000n);
      return receipt!;
    },
  };
}

async function createRateReadyFixture() {
  const fixture = await deployVault();
  // Match the ZK rate fixture: owner-prepared 100 assets and 300 shares.
  // These setup transactions are excluded from the measured operation.
  await mintToUser(fixture, { address: await fixture.vault.getAddress() }, 100n);
  const shares = await createEncryptedInput(await fixture.vault.getAddress(), fixture.deployer, 300n);
  await (await fixture.vault.connect(fixture.deployer).mint(fixture.deployer.address, shares.handles[0], shares.inputProof)).wait();
  assert.equal(await clearBalance(fixture.vault, fixture.deployer), 300n);
  const newRatio = 3n * BASE_RATE;
  const residualInput = await createEncryptedInput(await fixture.vault.getAddress(), fixture.deployer, 0n);
  return { fixture, newRatio, residualInput };
}

async function validateSnapshots(fixture: VaultFixture) {
  for (const [getter, expected] of [["snapshotTotalAssets", 100n], ["snapshotTotalShares", 300n]] as const) {
    const handle = await fixture.vault[getter]();
    assert.equal(await fhevm.userDecryptEuint(FhevmType.euint64, handle.toString(), await fixture.vault.getAddress(), fixture.deployer), expected);
  }
}

async function createSnapshotFixture() {
  const rateReady = await createRateReadyFixture();
  const operationSnapshot = await snapshot();
  return {
    snapshot: operationSnapshot,
    async measure() {
      const receipt = await (await rateReady.fixture.vault.connect(rateReady.fixture.deployer).updateSnapshot()).wait();
      await validateSnapshots(rateReady.fixture);
      return receipt!;
    },
  };
}

async function createRequestFixture() {
  const rateReady = await createRateReadyFixture();
  await (await rateReady.fixture.vault.connect(rateReady.fixture.deployer).updateSnapshot()).wait();
  await validateSnapshots(rateReady.fixture);
  const operationSnapshot = await snapshot();
  return {
    snapshot: operationSnapshot,
    async measure() {
      const receipt = await (
        await rateReady.fixture.vault
          .connect(rateReady.fixture.deployer)
          .requestUpdateRatio(
            rateReady.newRatio,
            rateReady.residualInput.handles[0],
            rateReady.residualInput.inputProof,
          )
      ).wait();
      return receipt!;
    },
  };
}

async function createFinalizeFixture() {
  const rateReady = await createRateReadyFixture();
  await (await rateReady.fixture.vault.connect(rateReady.fixture.deployer).updateSnapshot()).wait();
  await validateSnapshots(rateReady.fixture);
  await (
    await rateReady.fixture.vault
      .connect(rateReady.fixture.deployer)
      .requestUpdateRatio(rateReady.newRatio, rateReady.residualInput.handles[0], rateReady.residualInput.inputProof)
  ).wait();
  const requestId = await rateReady.fixture.vault.requestCounter();
  const encryptedResult = (await rateReady.fixture.vault.requests(requestId)).isCorrect;
  const publicDecryptResult = await fhevm.publicDecrypt([encryptedResult]);
  assert.equal(ethers.AbiCoder.defaultAbiCoder().decode(["bool"], publicDecryptResult.abiEncodedClearValues)[0], true, "rate request must be accepted");
  const operationSnapshot = await snapshot();

  return {
    snapshot: operationSnapshot,
    async measure() {
      const receipt = await (
        await rateReady.fixture.vault
          .connect(rateReady.fixture.deployer)
          .finalizeUpdateRatio(
            requestId,
            publicDecryptResult.abiEncodedClearValues,
            publicDecryptResult.decryptionProof,
          )
      ).wait();
      assert.equal(await rateReady.fixture.vault.ratio(), rateReady.newRatio);
      return receipt!;
    },
  };
}

async function runTrials(
  name: string,
  createFixture: () => Promise<{ snapshot: string; measure: () => Promise<any> }>,
): Promise<GasResult> {
  console.log(`Preparing ${name} operation-ready fixture`);
  const fixture = await createFixture();
  let fixtureSnapshot = fixture.snapshot;
  const gasUsed: bigint[] = [];
  const calldataBytes: number[] = [];
  const transactionInputSha256: string[] = [];

  console.log(`Measuring ${name} across ${TRIALS} restored snapshots`);
  for (let trial = 0; trial < TRIALS; trial += 1) {
    await revert(fixtureSnapshot);
    fixtureSnapshot = await snapshot();
    const receipt = await fixture.measure();
    assert.equal(receipt.status, 1, `${name}: transaction failed`);
    const tx = await ethers.provider.getTransaction(receipt.hash);
    assert(tx, "measured transaction is missing");
    gasUsed.push(receipt.gasUsed);
    calldataBytes.push((tx.data.length - 2) / 2);
    transactionInputSha256.push(crypto.createHash("sha256").update(Buffer.from(tx.data.slice(2), "hex")).digest("hex"));
  }

  return {
    gasUsed: gasUsed.map(String), calldataBytes, transactionInputSha256,
    statistics: { meanGas: mean(gasUsed), sampleStddevGas: sampleStddev(gasUsed),
      meanCalldataBytes: mean(calldataBytes.map(BigInt)), sampleStddevCalldataBytes: sampleStddev(calldataBytes.map(BigInt)) },
  };
}

export async function runBenchmark(
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "confidential-vault-benchmark-test-")),
) {
  if (!Number.isInteger(TRIALS) || TRIALS < 2) throw new Error("BENCHMARK_TRIALS must be an integer of at least 2");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "zama-matched-gas.json");
  if (fs.existsSync(outputPath) && process.env.BENCHMARK_OVERWRITE !== "1") {
    throw new Error(
      `Refusing to overwrite existing benchmark artifact: ${outputPath}. Set BENCHMARK_OVERWRITE=1 for an intentional replacement.`,
    );
  }

  const operations = {
    deposit: await runTrials("deposit", createDepositFixture),
    withdraw: await runTrials("withdraw", createWithdrawFixture),
    updateSnapshot: await runTrials("updateSnapshot", createSnapshotFixture),
    requestUpdateRatio: await runTrials("requestUpdateRatio", createRequestFixture),
    finalizeUpdateRatio: await runTrials("finalizeUpdateRatio", createFinalizeFixture),
  };
  const output = {
    schemaVersion: 2,
    campaign: "local-matched-2026-10-09",
    provenance: provenance(hre),
    workloads: { initialUserAssets: "10000", depositAssets: "100", withdrawAssets: "100", assetDecimals: 6, initialEncodedRatio: "1000000",
      rateAssets: "100", rateShares: "300", note: "Deposit/withdraw use 100 raw asset units at one share per asset; rate fixtures use 300 shares and 100 assets. Token units, custody and rate encoding remain implementation-specific." },
    generatedAt: new Date().toISOString(),
    methodology: {
      trials: TRIALS,
      metric: "transaction receipt gasUsed and submitted transaction input bytes",
      reset: "Each trial restores its operation-ready Hardhat snapshot before the measured transaction.",
      standardDeviation: "sample (n - 1)",
      compiler: "solc 0.8.28; optimizer enabled with 200 runs; viaIR true",
      runtime: "local Hardhat fhEVM mock",
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus(),
      totalMemoryBytes: os.totalmem(),
    },
    operations,
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Wrote Zama gas observations to ${outputPath}`);
  for (const [name, result] of Object.entries(operations)) {
    console.log(
      `${name}: ${result.statistics.meanGas.toFixed(0)} gas (sample sd ${result.statistics.sampleStddevGas.toFixed(2)})`,
    );
  }
}

async function main() {
  await fhevm.initializeCLIApi();
  await runBenchmark(process.env.BENCHMARK_RESULTS_DIR ?? defaultCliOutputDir);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
