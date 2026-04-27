import { TransactionInstruction } from '@solana/web3.js';
import { Ledger } from '../ledger';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Mint layout: 82 bytes
// [4 mintAuthorityOption][32 mintAuthority][8 supply][1 decimals][1 isInitialized][4 freezeAuthorityOption][32 freezeAuthority]
export interface MintData {
  mintAuthorityOption: number;
  mintAuthority: string;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthorityOption: number;
  freezeAuthority: string;
}

// Token account layout: 165 bytes
// [32 mint][32 owner][8 amount][36 delegate option][1 state][12 isNative option][8 delegatedAmount][36 closeAuthority option]
export interface TokenAccountData {
  mint: string;
  owner: string;
  amount: bigint;
  state: number; // 1 = initialized
}

export function parseMint(data: Buffer): MintData {
  if (data.length < 82) throw new Error('Invalid mint data length');
  const bs58 = require('bs58');
  return {
    mintAuthorityOption: data.readUInt32LE(0),
    mintAuthority: bs58.encode(data.slice(4, 36)),
    supply: data.readBigUInt64LE(36),
    decimals: data[44],
    isInitialized: data[45] === 1,
    freezeAuthorityOption: data.readUInt32LE(46),
    freezeAuthority: bs58.encode(data.slice(50, 82)),
  };
}

export function serializeMint(mint: MintData): Buffer {
  const bs58 = require('bs58');
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(mint.mintAuthorityOption, 0);
  const authBytes = Buffer.from(bs58.decode(mint.mintAuthority));
  authBytes.copy(buf, 4);
  buf.writeBigUInt64LE(mint.supply, 36);
  buf[44] = mint.decimals;
  buf[45] = mint.isInitialized ? 1 : 0;
  buf.writeUInt32LE(mint.freezeAuthorityOption, 46);
  const freezeBytes = Buffer.from(bs58.decode(mint.freezeAuthority));
  freezeBytes.copy(buf, 50);
  return buf;
}

export function parseTokenAccount(data: Buffer): TokenAccountData {
  if (data.length < 165) throw new Error('Invalid token account data length');
  const bs58 = require('bs58');
  return {
    mint: bs58.encode(data.slice(0, 32)),
    owner: bs58.encode(data.slice(32, 64)),
    amount: data.readBigUInt64LE(64),
    state: data[108],
  };
}

export function serializeTokenAccount(acc: TokenAccountData): Buffer {
  const bs58 = require('bs58');
  const buf = Buffer.alloc(165);
  const mintBytes = Buffer.from(bs58.decode(acc.mint));
  mintBytes.copy(buf, 0);
  const ownerBytes = Buffer.from(bs58.decode(acc.owner));
  ownerBytes.copy(buf, 32);
  buf.writeBigUInt64LE(acc.amount, 64);
  // delegate option = None (0) at offset 68
  buf.writeUInt32LE(0, 68);
  // state at 108
  buf[108] = acc.state;
  // isNative option = None at 109
  buf.writeUInt32LE(0, 109);
  // delegatedAmount at 121
  buf.writeBigUInt64LE(0n, 121);
  // closeAuthority option = None at 129
  buf.writeUInt32LE(0, 129);
  return buf;
}

export function isMintAccount(data: Buffer): boolean {
  return data.length === 82 && data[45] === 1;
}

export function isTokenAccount(data: Buffer): boolean {
  return data.length === 165 && data[108] === 1;
}

export function executeTokenInstruction(
  ix: TransactionInstruction,
  ledger: Ledger,
  signers: Set<string>
): void {
  const data = ix.data;
  if (data.length < 1) throw new Error('Token instruction data too short');

  const discriminator = data[0];

  switch (discriminator) {
    case 20: // InitializeMint2
      executeInitializeMint2(ix, data, ledger);
      break;
    case 18: // InitializeAccount3
      executeInitializeAccount3(ix, data, ledger);
      break;
    case 7: // MintTo
      executeMintTo(ix, data, ledger, signers);
      break;
    case 3: // Transfer
      executeTokenTransfer(ix, data, ledger, signers);
      break;
    case 12: // TransferChecked
      executeTransferChecked(ix, data, ledger, signers);
      break;
    case 8: // Burn
      executeBurn(ix, data, ledger, signers);
      break;
    case 9: // CloseAccount
      executeCloseAccount(ix, ledger, signers);
      break;
    default:
      throw new Error(`Unknown token instruction: ${discriminator}`);
  }
}

function executeInitializeMint2(
  ix: TransactionInstruction,
  data: Buffer,
  ledger: Ledger
): void {
  // Minimum: 1 disc + 1 decimals + 32 mintAuth + 1 hasFreezeAuth = 35
  if (data.length < 35) throw new Error('InitializeMint2 data too short');
  if (ix.keys.length < 1) throw new Error('InitializeMint2 requires mint account');

  const bs58 = require('bs58');
  const mintPubkey = ix.keys[0].pubkey.toBase58();
  const mintAcc = ledger.getAccount(mintPubkey);
  if (!mintAcc) throw new Error('Mint account does not exist');
  if (mintAcc.data.length < 82) throw new Error('Mint account too small');

  const existing = parseMintSafe(mintAcc.data);
  if (existing && existing.isInitialized) throw new Error('Mint already initialized');

  const decimals = data[1];
  const mintAuthority = bs58.encode(data.slice(2, 34));
  const hasFreezeAuth = data[34];
  const freezeAuthority = hasFreezeAuth && data.length >= 67
    ? bs58.encode(data.slice(35, 67))
    : mintAuthority;

  const mintData: MintData = {
    mintAuthorityOption: 1,
    mintAuthority,
    supply: 0n,
    decimals,
    isInitialized: true,
    freezeAuthorityOption: hasFreezeAuth,
    freezeAuthority,
  };

  mintAcc.data = serializeMint(mintData);
  mintAcc.owner = TOKEN_PROGRAM_ID;
  ledger.setAccount(mintPubkey, mintAcc);
}

function executeInitializeAccount3(
  ix: TransactionInstruction,
  data: Buffer,
  ledger: Ledger
): void {
  if (data.length < 33) throw new Error('InitializeAccount3 data too short');
  if (ix.keys.length < 2) throw new Error('InitializeAccount3 requires token + mint accounts');

  const bs58 = require('bs58');
  const tokenPubkey = ix.keys[0].pubkey.toBase58();
  const mintPubkey = ix.keys[1].pubkey.toBase58();

  const tokenAcc = ledger.getAccount(tokenPubkey);
  if (!tokenAcc) throw new Error('Token account does not exist');

  const mintAcc = ledger.getAccount(mintPubkey);
  if (!mintAcc) throw new Error('Mint account does not exist');

  const owner = bs58.encode(data.slice(1, 33));

  const tokenData: TokenAccountData = {
    mint: mintPubkey,
    owner,
    amount: 0n,
    state: 1,
  };

  tokenAcc.data = serializeTokenAccount(tokenData);
  tokenAcc.owner = TOKEN_PROGRAM_ID;
  ledger.setAccount(tokenPubkey, tokenAcc);
}

function executeMintTo(
  ix: TransactionInstruction,
  data: Buffer,
  ledger: Ledger,
  signers: Set<string>
): void {
  if (data.length < 9) throw new Error('MintTo data too short');
  if (ix.keys.length < 3) throw new Error('MintTo requires mint, destination, authority');

  const mintPubkey = ix.keys[0].pubkey.toBase58();
  const destPubkey = ix.keys[1].pubkey.toBase58();
  const authorityPubkey = ix.keys[2].pubkey.toBase58();

  if (!signers.has(authorityPubkey)) throw new Error('Authority must be a signer');

  const amount = data.readBigUInt64LE(1);

  const mintAcc = ledger.getAccount(mintPubkey);
  if (!mintAcc || mintAcc.data.length < 82) throw new Error('Mint account invalid');

  const mintData = parseMint(mintAcc.data);
  if (!mintData.isInitialized) throw new Error('Mint not initialized');
  if (mintData.mintAuthority !== authorityPubkey) throw new Error('Invalid mint authority');

  const destAcc = ledger.getAccount(destPubkey);
  if (!destAcc || destAcc.data.length < 165) throw new Error('Destination token account invalid');

  const tokenData = parseTokenAccount(destAcc.data);
  if (tokenData.mint !== mintPubkey) throw new Error('Destination mint mismatch');

  tokenData.amount += amount;
  mintData.supply += amount;

  destAcc.data = serializeTokenAccount(tokenData);
  mintAcc.data = serializeMint(mintData);

  ledger.setAccount(destPubkey, destAcc);
  ledger.setAccount(mintPubkey, mintAcc);
}

function executeTokenTransfer(
  ix: TransactionInstruction,
  data: Buffer,
  ledger: Ledger,
  signers: Set<string>
): void {
  if (data.length < 9) throw new Error('Token Transfer data too short');
  if (ix.keys.length < 3) throw new Error('Token Transfer requires source, destination, owner');

  const srcPubkey = ix.keys[0].pubkey.toBase58();
  const destPubkey = ix.keys[1].pubkey.toBase58();
  const ownerPubkey = ix.keys[2].pubkey.toBase58();

  if (!signers.has(ownerPubkey)) throw new Error('Owner must be a signer');

  const amount = data.readBigUInt64LE(1);

  const srcAcc = ledger.getAccount(srcPubkey);
  if (!srcAcc || srcAcc.data.length < 165) throw new Error('Source token account invalid');

  const destAcc = ledger.getAccount(destPubkey);
  if (!destAcc || destAcc.data.length < 165) throw new Error('Destination token account invalid');

  const srcData = parseTokenAccount(srcAcc.data);
  if (srcData.owner !== ownerPubkey) throw new Error('Owner mismatch');
  if (srcData.amount < amount) throw new Error('Insufficient token balance');

  const destData = parseTokenAccount(destAcc.data);

  srcData.amount -= amount;
  destData.amount += amount;

  srcAcc.data = serializeTokenAccount(srcData);
  destAcc.data = serializeTokenAccount(destData);

  ledger.setAccount(srcPubkey, srcAcc);
  ledger.setAccount(destPubkey, destAcc);
}

function executeTransferChecked(
  ix: TransactionInstruction,
  data: Buffer,
  ledger: Ledger,
  signers: Set<string>
): void {
  if (data.length < 10) throw new Error('TransferChecked data too short');
  if (ix.keys.length < 4) throw new Error('TransferChecked requires source, mint, destination, owner');

  const srcPubkey = ix.keys[0].pubkey.toBase58();
  const mintPubkey = ix.keys[1].pubkey.toBase58();
  const destPubkey = ix.keys[2].pubkey.toBase58();
  const ownerPubkey = ix.keys[3].pubkey.toBase58();

  if (!signers.has(ownerPubkey)) throw new Error('Owner must be a signer');

  const amount = data.readBigUInt64LE(1);
  const decimals = data[9];

  const mintAcc = ledger.getAccount(mintPubkey);
  if (!mintAcc || mintAcc.data.length < 82) throw new Error('Mint account invalid');

  const mintData = parseMint(mintAcc.data);
  if (mintData.decimals !== decimals) throw new Error('Decimals mismatch');

  const srcAcc = ledger.getAccount(srcPubkey);
  if (!srcAcc || srcAcc.data.length < 165) throw new Error('Source token account invalid');

  const destAcc = ledger.getAccount(destPubkey);
  if (!destAcc || destAcc.data.length < 165) throw new Error('Destination token account invalid');

  const srcData = parseTokenAccount(srcAcc.data);
  if (srcData.owner !== ownerPubkey) throw new Error('Owner mismatch');
  if (srcData.mint !== mintPubkey) throw new Error('Source mint mismatch');
  if (srcData.amount < amount) throw new Error('Insufficient token balance');

  const destData = parseTokenAccount(destAcc.data);

  srcData.amount -= amount;
  destData.amount += amount;

  srcAcc.data = serializeTokenAccount(srcData);
  destAcc.data = serializeTokenAccount(destData);

  ledger.setAccount(srcPubkey, srcAcc);
  ledger.setAccount(destPubkey, destAcc);
}

function executeBurn(
  ix: TransactionInstruction,
  data: Buffer,
  ledger: Ledger,
  signers: Set<string>
): void {
  if (data.length < 9) throw new Error('Burn data too short');
  if (ix.keys.length < 3) throw new Error('Burn requires tokenAccount, mint, owner');

  const tokenPubkey = ix.keys[0].pubkey.toBase58();
  const mintPubkey = ix.keys[1].pubkey.toBase58();
  const ownerPubkey = ix.keys[2].pubkey.toBase58();

  if (!signers.has(ownerPubkey)) throw new Error('Owner must be a signer');

  const amount = data.readBigUInt64LE(1);

  const tokenAcc = ledger.getAccount(tokenPubkey);
  if (!tokenAcc || tokenAcc.data.length < 165) throw new Error('Token account invalid');

  const mintAcc = ledger.getAccount(mintPubkey);
  if (!mintAcc || mintAcc.data.length < 82) throw new Error('Mint account invalid');

  const tokenData = parseTokenAccount(tokenAcc.data);
  if (tokenData.owner !== ownerPubkey) throw new Error('Owner mismatch');
  if (tokenData.mint !== mintPubkey) throw new Error('Mint mismatch');
  if (tokenData.amount < amount) throw new Error('Insufficient token balance');

  const mintData = parseMint(mintAcc.data);

  tokenData.amount -= amount;
  mintData.supply -= amount;

  tokenAcc.data = serializeTokenAccount(tokenData);
  mintAcc.data = serializeMint(mintData);

  ledger.setAccount(tokenPubkey, tokenAcc);
  ledger.setAccount(mintPubkey, mintAcc);
}

function executeCloseAccount(
  ix: TransactionInstruction,
  ledger: Ledger,
  signers: Set<string>
): void {
  if (ix.keys.length < 3) throw new Error('CloseAccount requires account, destination, owner');

  const accountPubkey = ix.keys[0].pubkey.toBase58();
  const destPubkey = ix.keys[1].pubkey.toBase58();
  const ownerPubkey = ix.keys[2].pubkey.toBase58();

  if (!signers.has(ownerPubkey)) throw new Error('Owner must be a signer');

  const tokenAcc = ledger.getAccount(accountPubkey);
  if (!tokenAcc || tokenAcc.data.length < 165) throw new Error('Token account invalid');

  const tokenData = parseTokenAccount(tokenAcc.data);
  if (tokenData.owner !== ownerPubkey) throw new Error('Owner mismatch');
  if (tokenData.amount !== 0n) throw new Error('Token account balance must be 0 to close');

  const destAcc = ledger.getOrCreateAccount(destPubkey);
  destAcc.lamports += tokenAcc.lamports;

  ledger.setAccount(destPubkey, destAcc);
  ledger.deleteAccount(accountPubkey);
}

function parseMintSafe(data: Buffer): MintData | null {
  try {
    return parseMint(data);
  } catch {
    return null;
  }
}
