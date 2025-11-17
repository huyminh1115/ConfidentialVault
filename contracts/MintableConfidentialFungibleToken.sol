// SPDX-License-Identifier: MIT

pragma solidity ^0.8.26;

import {FHE, externalEuint64, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ConfidentialFungibleToken} from "@openzeppelin/contracts-confidential/token/ConfidentialFungibleToken.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

contract MintableConfidentialFungibleToken is ConfidentialFungibleToken, Ownable, SepoliaConfig {
    constructor(
        string memory _name,
        string memory _symbol,
        string memory _uri,
        address _minter
    ) ConfidentialFungibleToken(_name, _symbol, _uri) Ownable(_minter) {}

    function mint(address to, euint64 amount) external onlyOwner {
        _mint(to, amount);
    }

    function mint(address to, externalEuint64 encryptedAmount, bytes calldata inputProof) external onlyOwner {
        euint64 mintAmount = FHE.fromExternal(encryptedAmount, inputProof);
        _mint(to, mintAmount);
    }

    function burn(address from, euint64 amount) external onlyOwner {
        _burn(from, amount);
    }

    function burn(address from, externalEuint64 encryptedAmount, bytes calldata inputProof) external onlyOwner {
        euint64 burnAmount = FHE.fromExternal(encryptedAmount, inputProof);
        _burn(from, burnAmount);
    }
}
