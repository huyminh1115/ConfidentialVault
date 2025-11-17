// SPDX-License-Identifier: MIT

pragma solidity ^0.8.26;

import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, externalEuint64, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {
    ConfidentialFungibleToken,
    IConfidentialFungibleToken
} from "@openzeppelin/contracts-confidential/token/ConfidentialFungibleToken.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {MintableConfidentialFungibleToken} from "./MintableConfidentialFungibleToken.sol";
import "hardhat/console.sol";

contract cERC4626 is MintableConfidentialFungibleToken {
    uint8 private _underlyingDecimals;
    uint8 private constant PRECISION_DECIMALS = 6;

    address private immutable cAsset;
    uint64 public ratio;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory uri_,
        address cAsset_
    ) MintableConfidentialFungibleToken(name_, symbol_, uri_, msg.sender) {
        (bool success, uint8 assetDecimals) = _tryGetAssetDecimals(IConfidentialFungibleToken(cAsset_));
        _underlyingDecimals = success ? assetDecimals : 6;
        cAsset = cAsset_;

        // init ratio as 10 ** _underlyingDecimals
        ratio = uint64(10 ** (_underlyingDecimals + PRECISION_DECIMALS));
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

    function _handleDepositWithdraw(euint64 amount) internal returns (euint64) {
        euint64 ableToContribute = FHE.sub(maxDeposit(msg.sender), amount);
        ebool isOverMaxContribute = FHE.ge(amount, ableToContribute);
        return FHE.select(isOverMaxContribute, ableToContribute, amount);
    }

    function deposit(
        address receiver,
        externalEuint64 encryptedAssetsAmount,
        bytes calldata inputProof
    ) public virtual returns (euint64) {
        euint64 depositAmount = FHE.fromExternal(encryptedAssetsAmount, inputProof);
        euint64 finalDepositAmount = _handleDepositWithdraw(depositAmount);

        euint64 shares = FHE.mul(finalDepositAmount, ratio);
        _deposit(msg.sender, receiver, finalDepositAmount, shares);

        return shares;
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
    ) public virtual returns (euint64) {
        euint64 withdrawAmount = FHE.fromExternal(_encryptedAssetsAmount, _inputProof);
        euint64 finalWithdrawAmount = _handleDepositWithdraw(withdrawAmount);

        euint64 withdrawShares = FHE.mul(finalWithdrawAmount, ratio);
        _withdraw(msg.sender, _receiver, finalWithdrawAmount, withdrawShares);

        return withdrawShares;
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

    /**
     * @notice Requests finalization of presale state with minimal storage reads
     * @dev Caches pool state and options to reduce storage access
     */
    function handleRequestUpdateRatio() external {
        euint64 _totalAssets = totalAssets();
        euint64 _totalShares = totalShares();

        // Optimize array creation by using fixed size array
        bytes32[] memory cts = new bytes32[](2);
        cts[0] = euint64.unwrap(_totalAssets);
        cts[1] = euint64.unwrap(_totalShares);

        FHE.requestDecryption(cts, cERC4626.finalizeUpdateRatio.selector);
    }

    function finalizeUpdateRatio(
        uint256 requestID,
        uint64 _totalAssets,
        uint64 _totalShares,
        bytes[] memory signatures
    ) external virtual {
        // must be at the top of the function (there in assembly relate to calldata layout int the FHE.sol)
        FHE.checkSignatures(requestID, signatures);

        console.log("totalAssets: ", _totalAssets);
        console.log("totalShares: ", _totalShares);

        // update ratio
        ratio = _totalShares / _totalAssets;
    }

    // case 3
    // admin - TP
    // update ratio to newRatio
    // function finalizeUpdateRatio(uint256 newRatio) external virtual {
    //     euint64 totalShares = totalShares();
    //     euint64 totalAssets = totalAssets();

    //     totalShares = FHE.mul(newRatio, totalAssets);

    //     FHE.requestDecryption(cts, cERC4626.finalizeUpdateRatio.selector);
    // }

    function withdrawAbleAssets(uint64 shares) public view returns (uint64) {
        return shares / ratio;
    }
}

// Deposit: D
// S
// A
// s = (S*D, A)
// S'
// A'
// D'
// s' = (S*D*A' + , A')

// (a*t) ; b
// (c*t') + (a*t) ;  b + d
// s = a/b
//

// confidential token
// wrap eth cho ETH privacy
// => chuan hoa quan trong
// erc20...
// ...
// zether -> 7945, cai dat
// approve...
// vault...
// an danh
//
