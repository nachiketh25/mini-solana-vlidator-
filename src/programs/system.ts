import { TransactionInstruction } from '@solana/web3.js';
import { Ledger } from '../ledger';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

export function executeSystemInstruction(
  ix: TransactionInstruction,
  ledger: Ledger,
  signers: Set<string>
): void {
  const data = ix.data;
  if (data.length < 4) throw new Error('System instruction data too short');

  const discriminator = data.readUInt32LE(0);

  switch (discriminator) {
    case 0: // CreateAccount
      executeCreateAccount(ix, data, ledger, signers);
      break;
    case 2: // Transfer
      executeTransfer(ix, data, ledger, signers);
      break;
    default:
      throw new Error(`Unknown system instruction: ${discriminator}`);
  }
}

function executeCreateAccount(
  ix: TransactionInstruction,
  data: Buffer,
  ledger: Ledger,
  signers: Set<string>
): void {
  if (data.length < 52) throw new Error('CreateAccount data too short');
  if (ix.keys.length < 2) throw new Error('CreateAccount requires 2 accounts');

  const payer = ix.keys[0].pubkey.toBase58();
  const newAccount = ix.keys[1].pubkey.toBase58();

  if (!signers.has(payer)) throw new Error('Payer must be a signer');
  if (!signers.has(newAccount)) throw new Error('New account must be a signer');

  const lamports = data.readBigUInt64LE(4);
  const space = Number(data.readBigUInt64LE(12));
  const owner = bs58Encode(data.slice(20, 52));

  const payerAcc = ledger.getOrCreateAccount(payer);
  if (payerAcc.lamports < lamports) {
    throw new Error('Insufficient funds for CreateAccount');
  }

  const existing = ledger.getAccount(newAccount);
  if (existing && (existing.lamports > 0n || existing.data.length > 0)) {
    throw new Error('Account already exists');
  }

  payerAcc.lamports -= lamports;
  ledger.setAccount(payer, payerAcc);

  ledger.setAccount(newAccount, {
    lamports,
    owner,
    data: Buffer.alloc(space),
    executable: false,
    rentEpoch: 0,
  });
}

function executeTransfer(
  ix: TransactionInstruction,
  data: Buffer,
  ledger: Ledger,
  signers: Set<string>
): void {
  if (data.length < 12) throw new Error('Transfer data too short');
  if (ix.keys.length < 2) throw new Error('Transfer requires 2 accounts');

  const from = ix.keys[0].pubkey.toBase58();
  const to = ix.keys[1].pubkey.toBase58();

  if (!signers.has(from)) throw new Error('Source must be a signer');

  const lamports = data.readBigUInt64LE(4);

  const fromAcc = ledger.getOrCreateAccount(from);
  if (fromAcc.lamports < lamports) {
    throw new Error(`Insufficient funds: has ${fromAcc.lamports}, needs ${lamports}`);
  }

  const toAcc = ledger.getOrCreateAccount(to);

  fromAcc.lamports -= lamports;
  toAcc.lamports += lamports;

  ledger.setAccount(from, fromAcc);
  ledger.setAccount(to, toAcc);
}

// Simple bs58 encode for raw bytes
function bs58Encode(bytes: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bs58 = require('bs58');
  return bs58.encode(bytes);
}
