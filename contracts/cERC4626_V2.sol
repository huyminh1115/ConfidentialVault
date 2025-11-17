// SPDX-License-Identifier: MIT

pragma solidity ^0.8.26;

import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, externalEuint64, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {
    ConfidentialFungibleToken,
    IConfidentialFungibleToken
} from "@openzeppelin/contracts-confidential/token/ConfidentialFungibleToken.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {MintableConfidentialFungibleToken} from "./MintableConfidentialFungibleToken.sol";
import "hardhat/console.sol";

contract cERC4626V2 is MintableConfidentialFungibleToken {
    uint8 private _underlyingDecimals;
    uint8 private constant PRECISION_DECIMALS = 6;
    uint64 private constant BASE_RATE = uint64(10 ** PRECISION_DECIMALS);

    address private immutable cAsset;
    address public vaultManager;
    uint64 public ratio;
    bool public isOpen;

    euint64 public snapshotTotalAssets;
    euint64 public snapshotTotalShares;

    mapping(uint256 requestId => uint64 ratio) public requestRatio;

    error NotOpen();

    constructor(
        string memory name_,
        string memory symbol_,
        string memory uri_,
        address cAsset_
    ) MintableConfidentialFungibleToken(name_, symbol_, uri_, msg.sender) {
        (bool success, uint8 assetDecimals) = _tryGetAssetDecimals(IConfidentialFungibleToken(cAsset_));
        _underlyingDecimals = success ? assetDecimals : 6;
        cAsset = cAsset_;

        // init ratio as 10 ** BASE_RATE
        ratio = BASE_RATE;

        isOpen = true;

        vaultManager = msg.sender;
    }

    modifier onlyOpen() {
        if (!isOpen) {
            revert NotOpen();
        }
        _;
    }

    function setIsOpen(bool _isOpen) external onlyOwner {
        isOpen = _isOpen;
    }

    /**
     * @dev Attempts to fetch the asset decimals. A return value of false indicates that the attempt failed in some way.
     */
    function _tryGetAssetDecimals(
        IConfidentialFungibleToken cAsset_
    ) private view returns (bool ok, uint8 assetDecimals) {
        (bool success, bytes memory encodedDecimals) = address(cAsset_).staticcall(
            abi.encodeCall(IConfidentialFungibleToken.decimals, ())
        );
        if (success && encodedDecimals.length >= 32) {
            uint64 returnedDecimals = abi.decode(encodedDecimals, (uint64));
            if (returnedDecimals <= type(uint8).max) {
                return (true, uint8(returnedDecimals));
            }
        }
        return (false, 0);
    }

    function decimals() public view virtual override(ConfidentialFungibleToken) returns (uint8) {
        return _underlyingDecimals;
    }

    function asset() public view virtual returns (address) {
        return address(cAsset);
    }

    function totalAssets() public view virtual returns (euint64) {
        return IConfidentialFungibleToken(cAsset).balanceOf(address(this));
    }

    function totalShares() public view virtual returns (euint64) {
        return totalSupply();
    }

    function maxDeposit(address receiver) public view virtual returns (uint64) {
        return type(uint64).max;
    }

    function _handleDeposit(euint64 depositAmount) internal returns (euint64) {
        euint64 ableToContribute = FHE.sub(maxDeposit(msg.sender), depositAmount);
        ebool isOverMaxContribute = FHE.ge(depositAmount, ableToContribute);
        return FHE.select(isOverMaxContribute, ableToContribute, depositAmount);
    }

    function deposit(
        address receiver,
        externalEuint64 encryptedAssetsAmount,
        bytes calldata inputProof
    ) public virtual onlyOpen returns (euint64) {
        euint64 depositAmount = FHE.fromExternal(encryptedAssetsAmount, inputProof);
        euint64 finalDepositAmount = _handleDeposit(depositAmount);

        euint64 shares = FHE.div(FHE.mul(finalDepositAmount, ratio), BASE_RATE);
        _deposit(msg.sender, receiver, finalDepositAmount, shares);

        return shares;
    }

    function mintShares(
        address receiver,
        externalEuint64 encryptedSharesAmount,
        bytes calldata inputProof
    ) public virtual onlyOpen returns (euint64) {
        euint64 shares = FHE.fromExternal(encryptedSharesAmount, inputProof);

        euint64 depositAmount = FHE.div(FHE.mul(shares, BASE_RATE), ratio);

        euint64 finalDepositAmount = _handleDeposit(depositAmount);

        euint64 finalShares = FHE.div(FHE.mul(finalDepositAmount, ratio), BASE_RATE);
        _deposit(msg.sender, receiver, finalDepositAmount, finalShares);

        return finalShares;
    }

    function _deposit(address caller, address receiver, euint64 finalDepositAmount, euint64 shares) internal virtual {
        FHE.allowTransient(finalDepositAmount, address(cAsset));

        // Perform confidential transfer
        euint64 transferred = IConfidentialFungibleToken(cAsset).confidentialTransferFrom(
            msg.sender,
            address(this),
            finalDepositAmount
        );

        ebool isTransferred = FHE.eq(transferred, finalDepositAmount);

        euint64 mintAmount = FHE.select(isTransferred, shares, FHE.asEuint64(0));

        _mint(receiver, mintAmount);
    }

    function withdraw(
        address _receiver,
        externalEuint64 _encryptedAssetsAmount,
        bytes calldata _inputProof
    ) public virtual onlyOpen returns (euint64) {
        euint64 withdrawAmount = FHE.fromExternal(_encryptedAssetsAmount, _inputProof);

        euint64 withdrawShares = FHE.div(FHE.mul(withdrawAmount, ratio), BASE_RATE);
        _withdraw(msg.sender, _receiver, withdrawAmount, withdrawShares);

        return withdrawShares;
    }

    function redeem(
        address _receiver,
        externalEuint64 _encryptedSharesAmount,
        bytes calldata _inputProof
    ) public virtual onlyOpen returns (euint64) {
        euint64 redeemAmount = FHE.fromExternal(_encryptedSharesAmount, _inputProof);

        euint64 withdrawAmount = FHE.div(FHE.mul(redeemAmount, BASE_RATE), ratio);
        _withdraw(msg.sender, _receiver, withdrawAmount, redeemAmount);

        return withdrawAmount;
    }

    function _withdraw(
        address _caller,
        address _receiver,
        euint64 _finalWithdrawAmount,
        euint64 _withdrawShares
    ) internal virtual {
        FHE.allowTransient(_finalWithdrawAmount, address(cAsset));

        // Perform confidential transfer
        euint64 transferred = IConfidentialFungibleToken(cAsset).confidentialTransferFrom(
            address(this),
            _receiver,
            _finalWithdrawAmount
        );

        ebool isTransferred = FHE.eq(transferred, _finalWithdrawAmount);

        euint64 burnAmount = FHE.select(isTransferred, _withdrawShares, FHE.asEuint64(0));

        _burn(_caller, burnAmount);
    }

    function updateSnapshot() external {
        snapshotTotalAssets = totalAssets();
        snapshotTotalShares = totalShares();

        FHE.allow(snapshotTotalAssets, vaultManager);
        FHE.allow(snapshotTotalShares, vaultManager);
    }

    function finalizeUpdateRatio(uint256 requestID, bool isCorrect, bytes[] memory signatures) external virtual {
        // must be at the top of the function (there in assembly relate to calldata layout int the FHE.sol)
        FHE.checkSignatures(requestID, signatures);

        if (isCorrect) {
            ratio = requestRatio[requestID];
        }
    }

    // rate = Share / Assets
    function requestUpdateRatio(
        uint64 newRatio,
        externalEuint64 inputResidual,
        bytes calldata inputProof
    ) external virtual {
        euint64 residual = FHE.fromExternal(inputResidual, inputProof);

        euint64 _totalShares = snapshotTotalShares;
        euint64 _totalAssets = snapshotTotalAssets;

        euint64 calTotalShares = FHE.div(FHE.mul(_totalAssets, newRatio), BASE_RATE);
        calTotalShares = FHE.add(calTotalShares, residual);

        ebool firstCondition = FHE.lt(residual, _totalAssets);
        ebool secondCondition = FHE.eq(calTotalShares, _totalShares);

        // Optimize array creation by using fixed size array
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = ebool.unwrap(FHE.and(firstCondition, secondCondition));

        // request decryption if both conditions are true
        uint256 requestID = FHE.requestDecryption(cts, cERC4626V2.finalizeUpdateRatio.selector);
        requestRatio[requestID] = newRatio;
    }
}
