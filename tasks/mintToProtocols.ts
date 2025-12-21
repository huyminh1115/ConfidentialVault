import { FhevmType } from "@fhevm/hardhat-plugin";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Task to mint underlying tokens to Protocol 1-5
 *
 * This task mints 1_000_000 tokens to each of the 5 Protocol contracts.
 * The underlying token must be deployed first using the InvestmentVault deploy script.
 *
 * Usage:
 *   npx hardhat --network localhost task:mint-to-protocols
 *   npx hardhat --network sepolia task:mint-to-protocols
 *   npx hardhat --network localhost task:mint-to-protocols --amount 2000000
 */
task("task:mint-to-protocols", "Mints underlying tokens to Protocol 1-5")
  .addOptionalParam("amount", "Amount to mint to each protocol (default: 1000000)", "1000000")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments, fhevm } = hre;

    // Parse the amount parameter
    const amount = BigInt(taskArguments.amount || "1000000");
    if (amount <= 0n) {
      throw new Error("Amount must be greater than 0");
    }

    console.log(`\nMinting ${amount.toString()} tokens to each protocol...\n`);

    // Initialize FHEVM for CLI operations
    // Handle initialization errors that may occur if contracts are already deployed
    await fhevm.initializeCLIApi();

    // Get the deployer signer (who is the owner of the underlying token)
    const signers = await ethers.getSigners();
    const deployer = signers[0];

    // Get the underlying token deployment
    let underlyingDeployment;
    try {
      underlyingDeployment = await deployments.get("ERC7984MintableBurnable");
    } catch (error) {
      throw new Error(
        "ERC7984MintableBurnable not found. Please deploy it first using: pnpm hardhat deploy --tags InvestmentVault",
      );
    }

    const underlyingAddress = underlyingDeployment.address;
    console.log(`Underlying Token: ${underlyingAddress}`);

    // Get the underlying token contract
    const underlyingContract = await ethers.getContractAt("ERC7984MintableBurnable", underlyingAddress);

    // Get all protocol addresses
    const protocolNames = ["Protocol1", "Protocol2", "Protocol3", "Protocol4", "Protocol5"];
    const protocolAddresses: string[] = [];

    for (const protocolName of protocolNames) {
      try {
        const protocolDeployment = await deployments.get(protocolName);
        protocolAddresses.push(protocolDeployment.address);
        console.log(`${protocolName}: ${protocolDeployment.address}`);
      } catch (error) {
        throw new Error(
          `${protocolName} not found. Please deploy protocols first using: pnpm hardhat deploy --tags InvestmentVault`,
        );
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("Starting minting process...");
    console.log("=".repeat(60));

    // Mint tokens to each protocol
    for (let i = 0; i < protocolAddresses.length; i++) {
      const protocolAddress = protocolAddresses[i];
      const protocolName = protocolNames[i];

      try {
        console.log(`\n[${i + 1}/5] Minting ${amount.toString()} tokens to ${protocolName}...`);

        // Create encrypted input for minting
        // The encrypted input is created for the deployer's address (the caller)
        const encrypted = await fhevm.createEncryptedInput(underlyingAddress, deployer.address).add64(amount).encrypt();

        // Mint tokens to the protocol address
        // The deployer (owner) calls the mint function
        const tx = await underlyingContract
          .connect(deployer)
          .mint(protocolAddress, encrypted.handles[0], encrypted.inputProof);

        console.log(`   Transaction hash: ${tx.hash}`);
        console.log(`   Waiting for confirmation...`);

        const receipt = await tx.wait();
        if (!receipt) {
          throw new Error("Transaction receipt is null");
        }

        console.log(`   ✓ Transaction confirmed (block: ${receipt.blockNumber}, status: ${receipt.status})`);

        // Verify the balance by getting the encrypted balance
        const balance = await underlyingContract.confidentialBalanceOf(protocolAddress);
        console.log(`   ✓ Encrypted balance: ${balance}`);

        // Try to decrypt the balance (only works in mock mode)
        if (fhevm.isMock) {
          try {
            // Get a signer for the protocol (we'll use deployer for decryption)
            const clearBalance = await fhevm.userDecryptEuint(
              FhevmType.euint64,
              balance.toString(),
              underlyingAddress,
              deployer,
            );
            console.log(`   ✓ Decrypted balance: ${clearBalance.toString()}`);
          } catch (decryptError) {
            console.log(`   ⚠ Could not decrypt balance (this is normal on non-mock networks)`);
          }
        }
      } catch (error: any) {
        console.error(`   ✗ Failed to mint to ${protocolName}:`, error.message);
        throw error;
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("Minting Summary:");
    console.log("=".repeat(60));
    console.log(`Underlying Token: ${underlyingAddress}`);
    for (let i = 0; i < protocolAddresses.length; i++) {
      console.log(`${protocolNames[i]}: ${protocolAddresses[i]} - ${amount.toString()} tokens minted`);
    }
    console.log("=".repeat(60));
    console.log("\n✓ All minting operations completed successfully!");
  });
