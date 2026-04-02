#!/usr/bin/env node

import { Command } from 'commander';
import { createSwap } from './commands/create-swap.js';
import { checkSwap } from './commands/check-swap.js';
import { executeSwap } from './commands/execute-swap.js';
import { statusSwap } from './commands/status.js';

const program = new Command();

program
  .name('action-swaps')
  .description('Cross-chain settlement primitive via Lit Actions')
  .version('0.1.0');

program
  .command('create')
  .description('Create a new cross-chain swap')
  .requiredOption('--source-chain <chain>', 'Source chain identifier (e.g., base-sepolia)')
  .requiredOption('--dest-chain <chain>', 'Destination chain identifier (e.g., ethereum-sepolia)')
  .requiredOption('--source-amount <amount>', 'Amount on source chain (in smallest unit)')
  .requiredOption('--dest-amount <amount>', 'Amount on destination chain (in smallest unit)')
  .requiredOption('--refund-source <address>', 'Refund address on source chain')
  .requiredOption('--refund-dest <address>', 'Refund address on dest chain')
  .requiredOption('--source-recipient <address>', 'Who receives source chain funds')
  .requiredOption('--dest-recipient <address>', 'Who receives dest chain funds')
  .option('--fee-bps <bps>', 'Fee in basis points (0-10000)', '0')
  .option('--expiration <seconds>', 'Seconds until expiration', '3600')
  .option('--confirmations <blocks>', 'Required confirmation blocks', '1')
  .option('--action-type <type>', 'Action type: evm-evm, evm-btc, evm-zec, btc-zec', 'evm-evm')
  .action(createSwap);

program
  .command('check')
  .description('Check deposit status for a swap')
  .requiredOption('--swap-id <id>', 'Swap ID')
  .action(checkSwap);

program
  .command('execute')
  .description('Execute a funded swap via Lit Action')
  .requiredOption('--swap-id <id>', 'Swap ID')
  .action(executeSwap);

program
  .command('status')
  .description('Show swap status from the contract')
  .requiredOption('--swap-id <id>', 'Swap ID')
  .action(statusSwap);

program.parse();
