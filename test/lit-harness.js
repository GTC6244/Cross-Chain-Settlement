/**
 * Lit Action Test Harness
 *
 * Mocks the Lit Protocol runtime environment so Lit Action code
 * can be unit-tested in Node.js without hitting the live network.
 *
 * Mocks: Lit.Actions.getLitActionPrivateKey(), ethers (v5 API), RPC providers
 */

import { ethers as ethersV6 } from 'ethers';
import crypto from 'crypto';

/**
 * Create a mock Lit runtime environment
 * @param {object} opts
 * @param {string} [opts.privateKey] - 32-byte hex private key (random if not provided)
 * @param {object} [opts.balances] - Map of "address:rpcUrl" -> balance in wei string
 * @param {object} [opts.contractState] - Mock contract state for getSwapState/getSwapAddresses
 * @param {string[]} [opts.sentTxs] - Array to collect sent transactions
 * @returns {object} Mock globals to inject into action code
 */
export function createLitRuntime(opts = {}) {
  const privateKey = opts.privateKey || crypto.randomBytes(32).toString('hex');
  const balances = opts.balances || {};
  const contractState = opts.contractState || {};
  const sentTxs = opts.sentTxs || [];
  let txCounter = 0;

  // Mock ethers v5 BigNumber
  class MockBigNumber {
    constructor(value) {
      this._value = BigInt(value);
    }
    static from(v) {
      if (v instanceof MockBigNumber) return v;
      return new MockBigNumber(v);
    }
    add(other) { return new MockBigNumber(this._value + MockBigNumber.from(other)._value); }
    sub(other) { return new MockBigNumber(this._value - MockBigNumber.from(other)._value); }
    mul(other) { return new MockBigNumber(this._value * MockBigNumber.from(other)._value); }
    div(other) { return new MockBigNumber(this._value / MockBigNumber.from(other)._value); }
    gt(other) { return this._value > MockBigNumber.from(other)._value; }
    lt(other) { return this._value < MockBigNumber.from(other)._value; }
    eq(other) { return this._value === MockBigNumber.from(other)._value; }
    gte(other) { return this._value >= MockBigNumber.from(other)._value; }
    lte(other) { return this._value <= MockBigNumber.from(other)._value; }
    toNumber() { return Number(this._value); }
    toString() { return this._value.toString(); }
  }

  // Mock provider
  function createMockProvider(rpcUrl) {
    return {
      _rpcUrl: rpcUrl,
      getBalance: async (address) => {
        const key = `${address}:${rpcUrl}`;
        const bal = balances[key] || balances[address] || '0';
        return MockBigNumber.from(bal);
      },
      getGasPrice: async () => MockBigNumber.from('1000000000'), // 1 gwei
      getTransactionCount: async () => 0,
    };
  }

  // Mock wallet
  function createMockWallet(key, provider) {
    const realWallet = new ethersV6.Wallet('0x' + key);
    return {
      address: realWallet.address,
      sendTransaction: async (tx) => {
        const hash = '0x' + crypto.randomBytes(32).toString('hex');
        sentTxs.push({
          hash,
          from: realWallet.address,
          to: tx.to,
          value: tx.value ? tx.value.toString() : '0',
          rpcUrl: provider._rpcUrl,
        });
        // Deduct from balance
        if (tx.value) {
          const balKey = `${realWallet.address}:${provider._rpcUrl}`;
          const current = BigInt(balances[balKey] || balances[realWallet.address] || '0');
          const val = typeof tx.value === 'object' ? tx.value._value : BigInt(tx.value);
          const newBal = (current - val).toString();
          balances[balKey] = newBal;
          balances[realWallet.address] = newBal;
        }
        return { hash, wait: async () => ({ blockNumber: 1 }) };
      },
      signMessage: async (msg) => {
        return realWallet.signMessage(msg);
      },
      signingKey: {
        compressedPublicKey: realWallet.signingKey.compressedPublicKey,
      },
    };
  }

  // Mock Contract
  function createMockContract(address, abi, signerOrProvider) {
    // Parse function names from ABI strings
    const funcs = {};
    for (const item of abi) {
      const match = item.match(/function\s+(\w+)/);
      if (match) {
        const name = match[1];
        if (name === 'getSwapState' && contractState.swapState) {
          funcs[name] = async () => contractState.swapState;
        } else if (name === 'getSwapAddresses' && contractState.swapAddresses) {
          funcs[name] = async () => contractState.swapAddresses;
        } else if (name === 'getSwapLegs' && contractState.swapLegs) {
          funcs[name] = async () => contractState.swapLegs;
        } else if (name === 'owner' && contractState.owner) {
          funcs[name] = async () => contractState.owner;
        } else if (name === 'markLegSettled') {
          funcs[name] = async (swapId, isSourceLeg, txHash) => {
            const hash = '0x' + crypto.randomBytes(32).toString('hex');
            sentTxs.push({ hash, type: 'markLegSettled', swapId, isSourceLeg, txHash });
            return { hash, wait: async () => ({ blockNumber: 1 }) };
          };
        } else if (name === 'markExecuted' || name === 'markRefunded') {
          funcs[name] = async (swapId) => {
            const hash = '0x' + crypto.randomBytes(32).toString('hex');
            sentTxs.push({ hash, type: name, swapId });
            return { hash, wait: async () => ({ blockNumber: 1 }) };
          };
        } else {
          funcs[name] = async (...args) => {
            sentTxs.push({ type: name, args });
            return { hash: '0xmock', wait: async () => ({}) };
          };
        }
      }
    }
    return funcs;
  }

  // The mock ethers v5 global
  const mockEthers = {
    BigNumber: MockBigNumber,
    Wallet: function(key, provider) {
      return createMockWallet(key.replace('0x', ''), provider);
    },
    Contract: function(address, abi, signerOrProvider) {
      return createMockContract(address, abi, signerOrProvider);
    },
    providers: {
      JsonRpcProvider: function(rpcUrl) {
        return createMockProvider(rpcUrl);
      },
    },
    utils: {
      parseEther: (v) => MockBigNumber.from(BigInt(Math.floor(parseFloat(v) * 1e18))),
      formatEther: (v) => (Number(MockBigNumber.from(v)._value) / 1e18).toString(),
    },
  };

  // The mock Lit global
  const mockLit = {
    Actions: {
      getLitActionPrivateKey: async () => privateKey,
    },
  };

  return {
    ethers: mockEthers,
    Lit: mockLit,
    privateKey,
    sentTxs,
    balances,
  };
}

/**
 * Execute a Lit Action function string in the mock environment
 * @param {string} actionCode - The action JS code (as a string)
 * @param {object} jsParams - Parameters passed to main()
 * @param {object} runtime - Mock runtime from createLitRuntime()
 * @returns {Promise<any>} The return value from main()
 */
export async function executeAction(actionCode, jsParams, runtime) {
  // Build the execution wrapper
  const wrapper = `
    ${actionCode}
    return main(params);
  `;

  // Create the function with mock globals injected
  const fn = new Function('ethers', 'Lit', 'params', 'Date', wrapper);

  // Use real Date but allow override
  return fn(runtime.ethers, runtime.Lit, jsParams, Date);
}
