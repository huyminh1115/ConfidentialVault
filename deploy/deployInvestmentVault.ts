import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers } from "hardhat";

/**
 * Deploy script for InvestmentVault setup
 *
 * This script deploys:
 * - 1 underlying ERC7984MintableBurnable token
 * - 5 Protocol contracts
 * - 1 ConfidentialVault contract with the underlying token as input
 *
 * Following the same logic as the test setup in InvestmentVault.ts
 *
 * Note: This script uses hardhat-deploy's deploy function to ensure
 * deployments are saved and can be used by generateTsAbis.ts to update
 * deployedContracts.ts automatically.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  console.log("Deploying InvestmentVault contracts with deployer:", deployer);

  // Step 1: Deploy underlying confidential token
  // Using the same parameters as in the test: "Underlying", "uTKN"
  console.log("\n1. Deploying underlying ERC7984MintableBurnable token...");
  const underlyingDeployment = await deploy("ERC7984MintableBurnable", {
    contract: "ERC7984MintableBurnable",
    from: deployer,
    args: [
      deployer, // owner
      "Underlying", // name
      "uTKN", // symbol
      "", // uri (empty string)
    ],
    log: true,
  });
  const underlyingAddress = underlyingDeployment.address;
  console.log(`   ✓ Underlying token deployed at: ${underlyingAddress}`);

  // Step 2: Deploy 5 Protocol contracts
  console.log("\n2. Deploying 5 Protocol contracts...");

  const protocol1Deployment = await deploy("Protocol1", {
    contract: "Protocol",
    from: deployer,
    args: [],
    log: true,
  });
  const protocol1Address = protocol1Deployment.address;
  console.log(`   ✓ Protocol 1 deployed at: ${protocol1Address}`);

  const protocol2Deployment = await deploy("Protocol2", {
    contract: "Protocol",
    from: deployer,
    args: [],
    log: true,
  });
  const protocol2Address = protocol2Deployment.address;
  console.log(`   ✓ Protocol 2 deployed at: ${protocol2Address}`);

  const protocol3Deployment = await deploy("Protocol3", {
    contract: "Protocol",
    from: deployer,
    args: [],
    log: true,
  });
  const protocol3Address = protocol3Deployment.address;
  console.log(`   ✓ Protocol 3 deployed at: ${protocol3Address}`);

  const protocol4Deployment = await deploy("Protocol4", {
    contract: "Protocol",
    from: deployer,
    args: [],
    log: true,
  });
  const protocol4Address = protocol4Deployment.address;
  console.log(`   ✓ Protocol 4 deployed at: ${protocol4Address}`);

  const protocol5Deployment = await deploy("Protocol5", {
    contract: "Protocol",
    from: deployer,
    args: [],
    log: true,
  });
  const protocol5Address = protocol5Deployment.address;
  console.log(`   ✓ Protocol 5 deployed at: ${protocol5Address}`);

  // Step 3: Deploy ConfidentialVault with underlying token address
  // Using the same parameters as in the test: "Vault Share", "vSHARE"
  console.log("\n3. Deploying ConfidentialVault...");
  const vaultDeployment = await deploy("ConfidentialVault", {
    contract: "ConfidentialVault",
    from: deployer,
    args: [
      "Vault Share", // name
      "vSHARE", // symbol
      "", // uri (empty string)
      underlyingAddress, // cAsset_ - the underlying token address
    ],
    log: true,
  });
  const vaultAddress = vaultDeployment.address;
  console.log(`   ✓ ConfidentialVault deployed at: ${vaultAddress}`);

  // Get initial ratio for verification using ethers
  const vaultContract = await ethers.getContractAt("ConfidentialVault", vaultAddress);
  const initialRatio = await vaultContract.ratio();
  console.log(`   ✓ Initial vault ratio: ${initialRatio.toString()}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("Deployment Summary:");
  console.log("=".repeat(60));
  console.log(`Underlying Token: ${underlyingAddress}`);
  console.log(`Protocol 1:       ${protocol1Address}`);
  console.log(`Protocol 2:       ${protocol2Address}`);
  console.log(`Protocol 3:       ${protocol3Address}`);
  console.log(`Protocol 4:       ${protocol4Address}`);
  console.log(`Protocol 5:       ${protocol5Address}`);
  console.log(`Vault:            ${vaultAddress}`);
  console.log(`Initial Ratio:   ${initialRatio.toString()}`);
  console.log("=".repeat(60));
};

export default func;
func.id = "deploy_investmentVault"; // id required to prevent reexecution
func.tags = ["InvestmentVault"];
