import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { CERC4626, MintableConfidentialFungibleToken } from "../types/contracts";
import { CERC4626__factory, MintableConfidentialFungibleToken__factory } from "../types/factories/contracts";

// Constants for better maintainability
const OPERATOR_EXPIRY_OFFSET = 3600; // 1 hour

// Test amounts as constants for better maintainability
const TEST_AMOUNTS = {
  aliceMint: 1_000_000n,
  bobMint: 2_000_000n,
  aliceDeposit: 400_000n,
  bobDeposit: 1_200_000n,
  yieldToVault: 600_000n,
  aliceWithdraw: 100_000n, // withdraw in assets
} as const;

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

// Helper functions to reduce code duplication and improve performance
class TestHelpers {
  /**
   * Creates encrypted input for minting
   */
  static async createEncryptedMint(contractAddress: string, user: HardhatEthersSigner, amount: bigint) {
    return await fhevm.createEncryptedInput(contractAddress, user.address).add64(amount).encrypt();
  }

  /**
   * Creates encrypted input for deposit/withdraw
   */
  static async createEncryptedDeposit(contractAddress: string, user: HardhatEthersSigner, amount: bigint) {
    return await fhevm.createEncryptedInput(contractAddress, user.address).add64(amount).encrypt();
  }

  /**
   * Mints confidential tokens to a user using the simple mint function
   */
  static async mintToUser(
    underlying: MintableConfidentialFungibleToken,
    mintToAddress: string,
    amount: bigint,
    deployer: HardhatEthersSigner,
    user?: HardhatEthersSigner, //  to get decrypted balance
  ) {
    // Use the simple mint function that takes euint64 directly
    const encrypted = await this.createEncryptedMint(await underlying.getAddress(), deployer, amount);
    await underlying["mint(address,bytes32,bytes)"](mintToAddress, encrypted.handles[0], encrypted.inputProof);

    const balance = await underlying.balanceOf(mintToAddress);

    let clearBalance = undefined;

    if (user) {
      clearBalance = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        balance.toString(),
        await underlying.getAddress(),
        user,
      );
    }
    return { balance, clearBalance };
  }

  /**
   * Sets operator for confidential transfers
   */
  static async setOperator(
    underlying: MintableConfidentialFungibleToken,
    user: HardhatEthersSigner,
    operatorAddress: string,
  ) {
    const expiry = BigInt((await time.latest()) + OPERATOR_EXPIRY_OFFSET);
    await underlying.connect(user).setOperator(operatorAddress, expiry);
  }

  /**
   * Performs a deposit and returns shares
   */
  static async performDeposit(vault: CERC4626, user: HardhatEthersSigner, amount: bigint, vaultAddress: string) {
    const encrypted = await this.createEncryptedDeposit(vaultAddress, user, amount);
    await vault.connect(user).deposit(user.address, encrypted.handles[0], encrypted.inputProof);

    const shares = await vault.balanceOf(user.address);
    const clearShares = await fhevm.userDecryptEuint(FhevmType.euint64, shares.toString(), vaultAddress, user);
    return { shares, clearShares };
  }

  /**
   * Performs a withdrawal and returns withdrawn shares
   */
  static async performWithdraw(vault: CERC4626, user: HardhatEthersSigner, amount: bigint, vaultAddress: string) {
    const encrypted = await this.createEncryptedDeposit(vaultAddress, user, amount);

    // Cast to access withdraw method not in TypeChain
    await vault.connect(user).withdraw(user.address, encrypted.handles[0], encrypted.inputProof);

    const shareLeft = await vault.balanceOf(user.address);
    const shareLeftClear = await fhevm.userDecryptEuint(FhevmType.euint64, shareLeft, vaultAddress, user);

    return { shareLeftClear };
  }

  /**
   * Updates vault ratio via decryption oracle
   */
  static async updateRatio(vault: CERC4626) {
    const prevRatio = await vault.ratio();

    // Cast to access handleRequestUpdateRatio method not in TypeChain
    await vault.handleRequestUpdateRatio();
    await fhevm.awaitDecryptionOracle();

    const newRatio = await vault.ratio();
    return { prevRatio, newRatio };
  }

  /**
   * Gets decrypted balance for a user
   */
  static async getDecryptedBalance(
    contract: MintableConfidentialFungibleToken | CERC4626,
    user: HardhatEthersSigner,
    userAddress: string,
  ) {
    const balance = await contract.balanceOf(userAddress);
    const clearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      balance.toString(),
      await contract.getAddress(),
      user,
    );
    return { balance, clearBalance };
  }

  static async getWithdrawableAssets(vault: CERC4626, user: HardhatEthersSigner) {
    const shares = await vault.balanceOf(user.address);
    const sharesClear = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      shares.toString(),
      await vault.getAddress(),
      user,
    );
    const withdrawableAssets = await vault.withdrawAbleAssets(sharesClear);
    return { withdrawableAssets };
  }
}

describe("cERC4626 deposit/ratio/withdraw flow", function () {
  // Cached variables for better performance
  let signers: Signers;
  let underlying: MintableConfidentialFungibleToken;
  let vault: CERC4626;
  let underlyingAddress: string;
  let vaultAddress: string;
  let initialRatio: bigint;

  /**
   * Optimized setup function with better error handling and performance
   */
  async function setupVault() {
    // Validate FHEVM environment
    if (!fhevm.isMock) {
      throw new Error("This hardhat test suite cannot run on Sepolia Testnet");
    }

    // Deploy underlying confidential token
    underlying = (await (
      await new MintableConfidentialFungibleToken__factory(signers.deployer).deploy(
        "Underlying",
        "uTKN",
        "",
        signers.deployer.address,
      )
    ).waitForDeployment()) as MintableConfidentialFungibleToken;

    // Deploy cERC4626 vault (it is also the share token)
    vault = (await (
      await new CERC4626__factory(signers.deployer).deploy("Vault Share", "vSHARE", "", await underlying.getAddress())
    ).waitForDeployment()) as CERC4626;

    // Cache addresses for better performance
    underlyingAddress = await underlying.getAddress();
    vaultAddress = await vault.getAddress();
    initialRatio = await vault.ratio();

    // Log setup information
    console.table({
      "underlying address": underlyingAddress,
      "vault address": vaultAddress,
      "initial ratio": initialRatio.toString(),
    });
  }

  before(async function () {
    const ethSigners: HardhatEthersSigner[] = await ethers.getSigners();
    signers = {
      deployer: ethSigners[0],
      alice: ethSigners[1],
      bob: ethSigners[2],
    };

    console.table({
      deployer: signers.deployer.address,
      alice: signers.alice.address,
      bob: signers.bob.address,
    });
  });

  describe("Test happy case: deposit, ratio update, withdraw", function () {
    before(async function () {
      await setupVault();
    });

    it("Test mint underlying to Alice", async function () {
      const { clearBalance } = await TestHelpers.mintToUser(
        underlying,
        signers.alice.address,
        TEST_AMOUNTS.aliceMint,
        signers.deployer,
        signers.alice,
      );
      expect(clearBalance).to.eq(TEST_AMOUNTS.aliceMint);
    });

    it("Test mint underlying to Bob", async function () {
      const { clearBalance } = await TestHelpers.mintToUser(
        underlying,
        signers.bob.address,
        TEST_AMOUNTS.bobMint,
        signers.deployer,
        signers.bob,
      );
      expect(clearBalance).to.eq(TEST_AMOUNTS.bobMint);
    });

    it("Test Alice deposits into vault", async function () {
      await TestHelpers.setOperator(underlying, signers.alice, vaultAddress);

      const { clearShares } = await TestHelpers.performDeposit(
        vault,
        signers.alice,
        TEST_AMOUNTS.aliceDeposit,
        vaultAddress,
      );

      console.log("alice shares: ", clearShares);
      expect(clearShares).to.eq(TEST_AMOUNTS.aliceDeposit * initialRatio);
    });

    it("Test Bob deposits into vault", async function () {
      await TestHelpers.setOperator(underlying, signers.bob, vaultAddress);

      const { clearShares } = await TestHelpers.performDeposit(
        vault,
        signers.bob,
        TEST_AMOUNTS.bobDeposit,
        vaultAddress,
      );

      console.log("bob shares: ", clearShares);
      expect(clearShares).to.eq(TEST_AMOUNTS.bobDeposit * initialRatio);
    });

    it("Test mint yield to vault", async function () {
      await TestHelpers.mintToUser(underlying, vaultAddress, TEST_AMOUNTS.yieldToVault, signers.deployer);

      // that's all, we can't check the balance of the vault, because it is confidential
    });

    it("Test update ratio", async function () {
      const { prevRatio, newRatio } = await TestHelpers.updateRatio(vault);

      console.log("prev ratio: ", prevRatio.toString());
      console.log("new ratio: ", newRatio.toString());
    });

    it("Test Alice withdraws assets", async function () {
      const { clearBalance: beforeBalance } = await TestHelpers.getDecryptedBalance(
        underlying,
        signers.alice,
        signers.alice.address,
      );

      const { withdrawableAssets } = await TestHelpers.getWithdrawableAssets(vault, signers.alice);

      console.log("alice withdrawable assets: ", withdrawableAssets);

      const { shareLeftClear } = await TestHelpers.performWithdraw(
        vault,
        signers.alice,
        withdrawableAssets,
        vaultAddress,
      );

      const { clearBalance: afterBalance } = await TestHelpers.getDecryptedBalance(
        underlying,
        signers.alice,
        signers.alice.address,
      );

      console.log("alice before balance: ", beforeBalance);
      console.log("alice after balance: ", afterBalance);
      console.log("alice share left: ", shareLeftClear);

      // Check underlying increased by withdrawn assets
      expect(afterBalance - beforeBalance).to.eq(withdrawableAssets);
    });

    xit("Test Alice share balance decreased", async function () {
      const { clearBalance: aliceShares } = await TestHelpers.getDecryptedBalance(
        vault,
        signers.alice,
        signers.alice.address,
      );

      console.log("alice remaining shares: ", aliceShares);

      // Alice should have fewer shares after withdrawal
      const expectedShares = TEST_AMOUNTS.aliceDeposit * initialRatio;
      expect(aliceShares).to.be.lt(expectedShares);
    });

    xit("Test Bob share balance unchanged", async function () {
      const { clearBalance: bobShares } = await TestHelpers.getDecryptedBalance(
        vault,
        signers.bob,
        signers.bob.address,
      );

      console.log("bob shares: ", bobShares);

      // Bob's shares should be unchanged
      expect(bobShares).to.eq(TEST_AMOUNTS.bobDeposit * initialRatio);
    });
  });
});
