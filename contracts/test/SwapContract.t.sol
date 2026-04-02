// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {SwapContract} from "../src/SwapContract.sol";

contract SwapContractTest is Test {
    SwapContract public swap;
    address public owner = address(this);
    address public litActionAddr = address(0x1234567890AbcdEF1234567890aBcdef12345678);
    address public alice = address(0xA11CE);
    address public usdc = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);

    function setUp() public {
        swap = new SwapContract();
    }

    function _createTestSwap() internal returns (uint256) {
        return swap.createSwap(
            "base-sepolia",
            "bitcoin-signet",
            1 ether,
            100000,
            "0xRefundSource",
            "tb1qRefundDest",
            "0xDepositSource",
            "tb1qDepositDest",
            1,
            block.timestamp + 1 hours,
            50,
            "QmTestCid123",
            litActionAddr,
            address(0),  // native token source
            address(0)   // native token dest
        );
    }

    function _createErc20Swap() internal returns (uint256) {
        return swap.createSwap(
            "base-sepolia",
            "ethereum-sepolia",
            1000000,     // 1 USDC (6 decimals)
            1000000,
            "0xRefundSource",
            "0xRefundDest",
            "0xDepositSource",
            "0xDepositDest",
            1,
            block.timestamp + 1 hours,
            50,
            "QmErc20Cid",
            litActionAddr,
            usdc,        // USDC on source
            usdc         // USDC on dest
        );
    }

    function test_createSwap() public {
        uint256 swapId = _createTestSwap();
        assertEq(swapId, 0);
        assertEq(swap.swapCount(), 1);

        (
            SwapContract.SwapState state,
            address creator,
            address litAddr,
            uint256 sourceAmount,
            uint256 destAmount,
            uint16 feeBps,
            uint256 expirationTimestamp,
            string memory litActionCid
        ) = swap.getSwapState(swapId);

        (
            string memory sourceChain,
            string memory destChain,
            ,,,, uint256 confirmationBlocks
        ) = swap.getSwapAddresses(swapId);

        assertEq(sourceChain, "base-sepolia");
        assertEq(destChain, "bitcoin-signet");
        assertEq(sourceAmount, 1 ether);
        assertEq(destAmount, 100000);
        assertEq(confirmationBlocks, 1);
        assertEq(feeBps, 50);
        assertEq(litActionCid, "QmTestCid123");
        assertEq(uint8(state), uint8(SwapContract.SwapState.Created));
        assertEq(creator, owner);
        assertEq(litAddr, litActionAddr);
        assertTrue(expirationTimestamp > block.timestamp);
    }

    function test_createSwap_nativeTokens() public {
        uint256 swapId = _createTestSwap();
        (address tokenSrc, address tokenDst) = swap.getSwapTokens(swapId);
        assertEq(tokenSrc, address(0));
        assertEq(tokenDst, address(0));
    }

    function test_createSwap_erc20Tokens() public {
        uint256 swapId = _createErc20Swap();
        (address tokenSrc, address tokenDst) = swap.getSwapTokens(swapId);
        assertEq(tokenSrc, usdc);
        assertEq(tokenDst, usdc);
    }

    function test_createSwap_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit SwapContract.SwapCreated(
            0,
            "base-sepolia",
            "bitcoin-signet",
            1 ether,
            100000,
            "QmTestCid123",
            owner
        );
        _createTestSwap();
    }

    function test_createSwap_incrementsId() public {
        uint256 id0 = _createTestSwap();
        uint256 id1 = _createTestSwap();
        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(swap.swapCount(), 2);
    }

    function test_createSwap_revert_zeroSourceAmount() public {
        vm.expectRevert("source amount zero");
        swap.createSwap("a", "b", 0, 1, "", "", "", "", 1, block.timestamp + 1, 50, "cid", litActionAddr, address(0), address(0));
    }

    function test_createSwap_revert_zeroDestAmount() public {
        vm.expectRevert("dest amount zero");
        swap.createSwap("a", "b", 1, 0, "", "", "", "", 1, block.timestamp + 1, 50, "cid", litActionAddr, address(0), address(0));
    }

    function test_createSwap_revert_expired() public {
        vm.expectRevert("already expired");
        swap.createSwap("a", "b", 1, 1, "", "", "", "", 1, block.timestamp - 1, 50, "cid", litActionAddr, address(0), address(0));
    }

    function test_createSwap_revert_feeTooHigh() public {
        vm.expectRevert("fee too high");
        swap.createSwap("a", "b", 1, 1, "", "", "", "", 1, block.timestamp + 1, 10001, "cid", litActionAddr, address(0), address(0));
    }

    function test_createSwap_revert_zeroLitAddr() public {
        vm.expectRevert("zero lit action address");
        swap.createSwap("a", "b", 1, 1, "", "", "", "", 1, block.timestamp + 1, 50, "cid", address(0), address(0), address(0));
    }

    function test_markExecuted() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
        (SwapContract.SwapState state,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state), uint8(SwapContract.SwapState.Executed));
    }

    function test_markExecuted_emitsEvent() public {
        uint256 swapId = _createTestSwap();
        vm.expectEmit(true, false, false, false);
        emit SwapContract.SwapExecuted(swapId);
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_wrongState() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
        vm.prank(litActionAddr);
        vm.expectRevert("invalid state");
        swap.markExecuted(swapId);
    }

    function test_markRefunded() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        swap.markRefunded(swapId);
        (SwapContract.SwapState state,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state), uint8(SwapContract.SwapState.Refunded));
    }

    function test_markRefunded_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markRefunded(swapId);
    }

    function test_transferOwnership() public {
        swap.transferOwnership(alice);
        assertEq(swap.owner(), alice);
    }

    function test_transferOwnership_revert_notOwner() public {
        vm.prank(alice);
        vm.expectRevert("not owner");
        swap.transferOwnership(alice);
    }

    function test_transferOwnership_revert_zeroAddress() public {
        vm.expectRevert("zero address");
        swap.transferOwnership(address(0));
    }

    function test_maxFee() public {
        swap.createSwap("a", "b", 1, 1, "", "", "", "", 1, block.timestamp + 1, 10000, "cid", litActionAddr, address(0), address(0));
    }

    function test_mixedTokenSwap() public {
        // ERC-20 on source, native on dest
        uint256 swapId = swap.createSwap(
            "base-sepolia", "ethereum-sepolia", 1000000, 1 ether,
            "0xRefund", "0xRefund", "0xDep", "0xDep",
            1, block.timestamp + 1 hours, 100, "QmMixed", litActionAddr,
            usdc, address(0)
        );
        (address tokenSrc, address tokenDst) = swap.getSwapTokens(swapId);
        assertEq(tokenSrc, usdc);
        assertEq(tokenDst, address(0));
    }
}
