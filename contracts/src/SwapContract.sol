// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title SwapContract
 * @notice On-chain source of truth for cross-chain swaps via Lit Actions.
 *         Each swap has a unique Lit Action (IPFS CID) that controls
 *         deterministic deposit addresses across chains.
 */
contract SwapContract {
    enum SwapState { Created, Funded, Executed, Refunded, Expired }
    enum FeeModel { RearLoaded }

    struct Swap {
        // Chain identifiers (e.g., "base-sepolia", "bitcoin-signet")
        string sourceChain;
        string destChain;

        // Amounts in smallest unit (wei, satoshi, zatoshi)
        uint256 sourceAmount;
        uint256 destAmount;

        // Refund addresses (chain-specific format, stored as strings)
        string refundAddressSource;
        string refundAddressDest;

        // Deposit addresses derived from Lit Action key
        string depositAddressSource;
        string depositAddressDest;

        // Timing
        uint256 confirmationBlocks;
        uint256 expirationTimestamp;

        // Fees
        uint16 feeBps; // 0-10000 (0-100%)
        FeeModel feeModel;

        // Lit Action
        string litActionCid;

        // State
        SwapState state;
        address creator;
        uint256 createdAt;

        // The EVM address derived from the Lit Action's key
        // Used to restrict who can call markExecuted/markRefunded
        address litActionEvmAddress;

        // ERC-20 token addresses (address(0) = native token)
        address tokenAddressSource;
        address tokenAddressDest;
    }

    address public owner;
    uint256 public swapCount;
    mapping(uint256 => Swap) public swaps;

    event SwapCreated(
        uint256 indexed swapId,
        string sourceChain,
        string destChain,
        uint256 sourceAmount,
        uint256 destAmount,
        string litActionCid,
        address creator
    );
    event SwapExecuted(uint256 indexed swapId);
    event SwapRefunded(uint256 indexed swapId);
    event SwapExpired(uint256 indexed swapId);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyLitAction(uint256 swapId) {
        require(
            msg.sender == swaps[swapId].litActionEvmAddress,
            "not lit action"
        );
        _;
    }

    modifier inState(uint256 swapId, SwapState expected) {
        require(swaps[swapId].state == expected, "invalid state");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Create a new swap record
     * @param sourceChain Chain identifier for source (e.g., "base-sepolia")
     * @param destChain Chain identifier for destination (e.g., "bitcoin-signet")
     * @param sourceAmount Amount expected on source chain (smallest unit)
     * @param destAmount Amount expected on destination chain (smallest unit)
     * @param refundAddressSource Address for refund on source chain
     * @param refundAddressDest Address for refund on destination chain
     * @param depositAddressSource Deposit address on source chain (from Lit key)
     * @param depositAddressDest Deposit address on destination chain (from Lit key)
     * @param confirmationBlocks Required block confirmations before execution
     * @param expirationTimestamp Unix timestamp after which swap can be refunded
     * @param feeBps Fee in basis points (0-10000)
     * @param litActionCid IPFS CID of the Lit Action for this swap
     * @param litActionEvmAddress EVM address derived from the Lit Action's key
     * @param tokenAddressSource ERC-20 token on source chain (address(0) = native)
     * @param tokenAddressDest ERC-20 token on dest chain (address(0) = native)
     */
    function createSwap(
        string calldata sourceChain,
        string calldata destChain,
        uint256 sourceAmount,
        uint256 destAmount,
        string calldata refundAddressSource,
        string calldata refundAddressDest,
        string calldata depositAddressSource,
        string calldata depositAddressDest,
        uint256 confirmationBlocks,
        uint256 expirationTimestamp,
        uint16 feeBps,
        string calldata litActionCid,
        address litActionEvmAddress,
        address tokenAddressSource,
        address tokenAddressDest
    ) external returns (uint256 swapId) {
        require(sourceAmount > 0, "source amount zero");
        require(destAmount > 0, "dest amount zero");
        require(expirationTimestamp > block.timestamp, "already expired");
        require(feeBps <= 10000, "fee too high");
        require(litActionEvmAddress != address(0), "zero lit action address");

        swapId = swapCount++;

        Swap storage s = swaps[swapId];
        s.sourceChain = sourceChain;
        s.destChain = destChain;
        s.sourceAmount = sourceAmount;
        s.destAmount = destAmount;
        s.refundAddressSource = refundAddressSource;
        s.refundAddressDest = refundAddressDest;
        s.depositAddressSource = depositAddressSource;
        s.depositAddressDest = depositAddressDest;
        s.confirmationBlocks = confirmationBlocks;
        s.expirationTimestamp = expirationTimestamp;
        s.feeBps = feeBps;
        s.feeModel = FeeModel.RearLoaded;
        s.litActionCid = litActionCid;
        s.state = SwapState.Created;
        s.creator = msg.sender;
        s.createdAt = block.timestamp;
        s.litActionEvmAddress = litActionEvmAddress;
        s.tokenAddressSource = tokenAddressSource;
        s.tokenAddressDest = tokenAddressDest;

        emit SwapCreated(
            swapId,
            sourceChain,
            destChain,
            sourceAmount,
            destAmount,
            litActionCid,
            msg.sender
        );
    }

    /**
     * @notice Mark a swap as executed (called by the Lit Action after settlement)
     */
    function markExecuted(uint256 swapId)
        external
        onlyLitAction(swapId)
        inState(swapId, SwapState.Created)
    {
        swaps[swapId].state = SwapState.Executed;
        emit SwapExecuted(swapId);
    }

    /**
     * @notice Mark a swap as refunded (called by the Lit Action after refund)
     */
    function markRefunded(uint256 swapId)
        external
        onlyLitAction(swapId)
        inState(swapId, SwapState.Created)
    {
        swaps[swapId].state = SwapState.Refunded;
        emit SwapRefunded(swapId);
    }

    /**
     * @notice Get swap state and key fields
     */
    function getSwapState(uint256 swapId) external view returns (
        SwapState state,
        address creator,
        address litActionEvmAddress,
        uint256 sourceAmount,
        uint256 destAmount,
        uint16 feeBps,
        uint256 expirationTimestamp,
        string memory litActionCid
    ) {
        Swap storage s = swaps[swapId];
        return (
            s.state,
            s.creator,
            s.litActionEvmAddress,
            s.sourceAmount,
            s.destAmount,
            s.feeBps,
            s.expirationTimestamp,
            s.litActionCid
        );
    }

    /**
     * @notice Get swap chain and address details
     */
    function getSwapAddresses(uint256 swapId) external view returns (
        string memory sourceChain,
        string memory destChain,
        string memory refundAddressSource,
        string memory refundAddressDest,
        string memory depositAddressSource,
        string memory depositAddressDest,
        uint256 confirmationBlocks
    ) {
        Swap storage s = swaps[swapId];
        return (
            s.sourceChain,
            s.destChain,
            s.refundAddressSource,
            s.refundAddressDest,
            s.depositAddressSource,
            s.depositAddressDest,
            s.confirmationBlocks
        );
    }

    /**
     * @notice Get token addresses for a swap
     */
    function getSwapTokens(uint256 swapId) external view returns (
        address tokenAddressSource,
        address tokenAddressDest
    ) {
        Swap storage s = swaps[swapId];
        return (s.tokenAddressSource, s.tokenAddressDest);
    }

    /**
     * @notice Transfer contract ownership
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }
}
