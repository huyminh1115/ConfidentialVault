import { FhevmType } from "@fhevm/hardhat-plugin";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Task to read the public state of a ConfidentialVault
 *
 * This helper pulls all publicly accessible state variables for a vault:
 *   - isOpen
 *   - ratio
 *   - vaultManager
 *   - asset (underlying address)
 *   - decimals (underlying decimals)
 *   - snapshotTotalAssets (encrypted)
 *   - snapshotTotalShares (encrypted)
 *   - requestCounter
 *   - strategyCounter
 *   - currentStrategyId
 *
 * Usage:
 *   npx hardhat --network localhost task:vault-state --vault 0xYourVault
 *   npx hardhat --network sepolia   task:vault-state --vault 0xYourVault
 *
 * If running against the mock FHEVM, add --decrypt to try decrypting the
 * snapshot totals (only works in mock mode).
 */
task("task:vault-state", "Reads the current public state of a ConfidentialVault")
  .addParam("vault", "Vault contract address to inspect")
  .addFlag("decrypt", "Attempt to decrypt encrypted snapshot fields (mock only)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, fhevm } = hre;

    // Validate the provided vault address early to avoid wasting time.
    const vaultAddress = String(taskArguments.vault || "").trim();
    if (!ethers.isAddress(vaultAddress)) {
      throw new Error(`Invalid vault address provided via --vault: "${vaultAddress}"`);
    }

    // Initialize FHEVM CLI API so we can decrypt in mock mode if requested.
    await fhevm.initializeCLIApi();

    // Grab a signer for potential decryption; caller is only used for mock decrypts.
    const [caller] = await ethers.getSigners();

    // Bind to the ConfidentialVault contract at the provided address.
    const vault = await ethers.getContractAt("ConfidentialVault", vaultAddress);

    // Fetch all public state in one shot. Keep the list close to the contract's
    // public variables so it is easy to maintain if fields change.
    const [
      isOpen,
      ratio,
      vaultManager,
      assetAddress,
      decimals,
      snapshotTotalAssets,
      snapshotTotalShares,
      requestCounter,
      strategyCounter,
      currentStrategyId,
    ] = await Promise.all([
      vault.isOpen(),
      vault.ratio(),
      vault.vaultManager(),
      vault.asset(),
      vault.decimals(),
      vault.snapshotTotalAssets(),
      vault.snapshotTotalShares(),
      vault.requestCounter(),
      vault.strategyCounter(),
      vault.currentStrategyId(),
    ]);

    console.log("\n" + "=".repeat(60));
    console.log("ConfidentialVault state");
    console.log("=".repeat(60));
    console.log(`Vault:             ${vaultAddress}`);
    console.log(`isOpen:            ${isOpen}`);
    console.log(`ratio:             ${ratio.toString()}`);
    console.log(`vaultManager:      ${vaultManager}`);
    console.log(`asset (underlying):${assetAddress}`);
    console.log(`decimals:          ${decimals}`);
    console.log(`snapshotAssets:    ${snapshotTotalAssets.toString()}`);
    console.log(`snapshotShares:    ${snapshotTotalShares.toString()}`);
    console.log(`requestCounter:    ${requestCounter.toString()}`);
    console.log(`strategyCounter:   ${strategyCounter.toString()}`);
    console.log(`currentStrategyId: ${currentStrategyId.toString()}`);

    // Optional decryption flow for snapshot totals in mock mode.
    if (taskArguments.decrypt) {
      if (!fhevm.isMock) {
        console.log("\nDecrypt requested but network is not mock; skipping decryption.");
      } else {
        console.log("\nAttempting mock decryption of snapshot totals...");
        try {
          const clearAssets = await fhevm.userDecryptEuint(
            FhevmType.euint64,
            snapshotTotalAssets.toString(),
            vaultAddress,
            caller,
          );
          const clearShares = await fhevm.userDecryptEuint(
            FhevmType.euint64,
            snapshotTotalShares.toString(),
            vaultAddress,
            caller,
          );
          console.log(`Decrypted snapshot assets: ${clearAssets.toString()}`);
          console.log(`Decrypted snapshot shares: ${clearShares.toString()}`);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`⚠️  Could not decrypt snapshot totals (mock only): ${message}`);
        }
      }
    }

    console.log("=".repeat(60));
    console.log("✓ Vault state read complete");
  });
