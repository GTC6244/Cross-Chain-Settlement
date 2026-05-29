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
            address(0),
            address(0)
        );
    }

    // Helper: settle both legs for a swap
    function _settleBothLegs(uint256 swapId) internal {
        vm.startPrank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xSourceTxHash");
        swap.markLegSettled(swapId, false, "0xDestTxHash");
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // createSwap
    // -----------------------------------------------------------------------

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

    function test_createSwap_legsInitiallyUnsettled() public {
        uint256 swapId = _createTestSwap();
        (bool srcSettled, bool dstSettled, string memory srcTx, string memory dstTx) = swap.getSwapLegs(swapId);
        assertFalse(srcSettled);
        assertFalse(dstSettled);
        assertEq(bytes(srcTx).length, 0);
        assertEq(bytes(dstTx).length, 0);
    }

    function test_createSwap_nativeTokens() public {
        uint256 swapId = _createTestSwap();
        (address tokenSrc, address tokenDst) = swap.getSwapTokens(swapId);
        assertEq(tokenSrc, address(0));
        assertEq(tokenDst, address(0));
    }

    function test_createSwap_erc20Tokens() public {
        uint256 swapId = swap.createSwap(
            "base-sepolia", "ethereum-sepolia", 1000000, 1000000,
            "0xRefundSource", "0xRefundDest", "0xDepositSource", "0xDepositDest",
            1, block.timestamp + 1 hours, 50, "QmErc20Cid", litActionAddr,
            usdc, usdc
        );
        (address tokenSrc, address tokenDst) = swap.getSwapTokens(swapId);
        assertEq(tokenSrc, usdc);
        assertEq(tokenDst, usdc);
    }

    function test_createSwap_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit SwapContract.SwapCreated(0, "base-sepolia", "bitcoin-signet", 1 ether, 100000, "QmTestCid123", owner);
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

    // -----------------------------------------------------------------------
    // markLegSettled
    // -----------------------------------------------------------------------

    function test_markLegSettled_source() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xabc123");

        (bool srcSettled, bool dstSettled, string memory srcTx, string memory dstTx) = swap.getSwapLegs(swapId);
        assertTrue(srcSettled);
        assertFalse(dstSettled);
        assertEq(srcTx, "0xabc123");
        assertEq(bytes(dstTx).length, 0);
    }

    function test_markLegSettled_dest() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, false, "0xdef456");

        (bool srcSettled, bool dstSettled,, string memory dstTx) = swap.getSwapLegs(swapId);
        assertFalse(srcSettled);
        assertTrue(dstSettled);
        assertEq(dstTx, "0xdef456");
    }

    function test_markLegSettled_bothLegs() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);

        (bool srcSettled, bool dstSettled, string memory srcTx, string memory dstTx) = swap.getSwapLegs(swapId);
        assertTrue(srcSettled);
        assertTrue(dstSettled);
        assertEq(srcTx, "0xSourceTxHash");
        assertEq(dstTx, "0xDestTxHash");
    }

    function test_markLegSettled_emitsEvent() public {
        uint256 swapId = _createTestSwap();
        vm.expectEmit(true, false, false, true);
        emit SwapContract.LegSettled(swapId, true, "0xabc");
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xabc");
    }

    // -----------------------------------------------------------------------
    // markFeeSettled
    // -----------------------------------------------------------------------

    function test_markFeeSettled() public {
        uint256 swapId = _createTestSwap();
        (bool before,) = swap.getFeeStatus(swapId);
        assertFalse(before);

        vm.prank(litActionAddr);
        swap.markFeeSettled(swapId, "0xFeeTx");

        (bool settled, string memory feeTx) = swap.getFeeStatus(swapId);
        assertTrue(settled);
        assertEq(feeTx, "0xFeeTx");
    }

    function test_markFeeSettled_revert_alreadySettled() public {
        uint256 swapId = _createTestSwap();
        vm.startPrank(litActionAddr);
        swap.markFeeSettled(swapId, "0xFeeTx");
        vm.expectRevert("fee already settled");
        swap.markFeeSettled(swapId, "0xFeeTx2");
        vm.stopPrank();
    }

    function test_markFeeSettled_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markFeeSettled(swapId, "0xFeeTx");
    }

    function test_markFeeSettled_emitsEvent() public {
        uint256 swapId = _createTestSwap();
        vm.expectEmit(true, false, false, true);
        emit SwapContract.FeeSettled(swapId, "0xFeeTx");
        vm.prank(litActionAddr);
        swap.markFeeSettled(swapId, "0xFeeTx");
    }

    function test_markLegSettled_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markLegSettled(swapId, true, "0xabc");
    }

    function test_markLegSettled_revert_alreadySettled_source() public {
        uint256 swapId = _createTestSwap();
        vm.startPrank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xfirst");
        vm.expectRevert("source leg already settled");
        swap.markLegSettled(swapId, true, "0xsecond");
        vm.stopPrank();
    }

    function test_markLegSettled_revert_alreadySettled_dest() public {
        uint256 swapId = _createTestSwap();
        vm.startPrank(litActionAddr);
        swap.markLegSettled(swapId, false, "0xfirst");
        vm.expectRevert("dest leg already settled");
        swap.markLegSettled(swapId, false, "0xsecond");
        vm.stopPrank();
    }

    function test_markLegSettled_revert_wrongState() public {
        uint256 swapId = _createTestSwap();
        // Execute the swap first
        _settleBothLegs(swapId);
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
        // Now try to settle a leg on an executed swap
        vm.prank(litActionAddr);
        vm.expectRevert("invalid state");
        swap.markLegSettled(swapId, true, "0xlate");
    }

    // -----------------------------------------------------------------------
    // markExecuted (now requires both legs)
    // -----------------------------------------------------------------------

    function test_markExecuted_afterBothLegs() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);

        vm.prank(litActionAddr);
        swap.markExecuted(swapId);

        (SwapContract.SwapState state,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state), uint8(SwapContract.SwapState.Executed));
    }

    function test_markExecuted_emitsEvent() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);

        vm.expectEmit(true, false, false, false);
        emit SwapContract.SwapExecuted(swapId);
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_sourceLegNotSettled() public {
        uint256 swapId = _createTestSwap();
        // Only settle dest leg
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, false, "0xdest");

        vm.prank(litActionAddr);
        vm.expectRevert("source leg not settled");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_destLegNotSettled() public {
        uint256 swapId = _createTestSwap();
        // Only settle source leg
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xsrc");

        vm.prank(litActionAddr);
        vm.expectRevert("dest leg not settled");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_noLegsSettled() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        vm.expectRevert("source leg not settled");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_wrongState() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
        // Try again
        vm.prank(litActionAddr);
        vm.expectRevert("invalid state");
        swap.markExecuted(swapId);
    }

    // -----------------------------------------------------------------------
    // markRefunded
    // -----------------------------------------------------------------------

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

    // Refund allowed even with one leg settled (partial settlement recovery)
    function test_markRefunded_afterPartialSettlement() public {
        uint256 swapId = _createTestSwap();
        vm.startPrank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xsource");
        swap.markRefunded(swapId);
        vm.stopPrank();

        (SwapContract.SwapState state,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state), uint8(SwapContract.SwapState.Refunded));
    }

    // -----------------------------------------------------------------------
    // Ownership
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    function test_maxFee() public {
        swap.createSwap("a", "b", 1, 1, "", "", "", "", 1, block.timestamp + 1, 10000, "cid", litActionAddr, address(0), address(0));
    }

    function test_mixedTokenSwap() public {
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

    // Full lifecycle: create -> settle source -> settle dest -> execute
    function test_fullLifecycle() public {
        uint256 swapId = _createTestSwap();

        // Initially Created, no legs settled
        (SwapContract.SwapState state0,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state0), uint8(SwapContract.SwapState.Created));

        // Settle source leg
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xbtc-txid-abc");
        (bool src1, bool dst1,,) = swap.getSwapLegs(swapId);
        assertTrue(src1);
        assertFalse(dst1);

        // Still in Created state
        (SwapContract.SwapState state1,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state1), uint8(SwapContract.SwapState.Created));

        // Settle dest leg
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, false, "0xeth-txhash-def");
        (bool src2, bool dst2,,) = swap.getSwapLegs(swapId);
        assertTrue(src2);
        assertTrue(dst2);

        // Mark executed
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
        (SwapContract.SwapState state2,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state2), uint8(SwapContract.SwapState.Executed));
    }
}
