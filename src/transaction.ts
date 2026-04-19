import { Transaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { Ledger } from './ledger';
import { SYSTEM_PROGRAM_ID, executeSystemInstruction } from './programs/system';
import { TOKEN_PROGRAM_ID, executeTokenInstruction } from './programs/token';
import { ATA_PROGRAM_ID, executeATAInstruction } from './programs/ata';

export function processTransaction(txBase64: string, ledger: Ledger): string {
  const txBytes = Buffer.from(txBase64, 'base64');
  const tx = Transaction.from(txBytes);

  // Validate blockhash
  const blockhash = tx.recentBlockhash;
  if (!blockhash || !ledger.isValidBlockhash(blockhash)) {
    throw new Error(`Invalid or expired blockhash: ${blockhash}`);
  }

  // Verify signatures
  const messageBytes = tx.serializeMessage();
  for (const sigInfo of tx.signatures) {
    if (!sigInfo.signature) {
      throw new Error(`Missing signature for ${sigInfo.publicKey.toBase58()}`);
    }
    // Check for all-zero (placeholder) signature
    const isZero = sigInfo.signature.every((b) => b === 0);
    if (isZero) {
      throw new Error(`Zero signature for ${sigInfo.publicKey.toBase58()}`);
    }
    const valid = nacl.sign.detached.verify(
      messageBytes,
      sigInfo.signature,
      sigInfo.publicKey.toBytes()
    );
    if (!valid) {
      throw new Error(`Invalid signature for ${sigInfo.publicKey.toBase58()}`);
    }
  }

  // Collect signer pubkeys
  const signers = new Set<string>(
    tx.signatures.map((s) => s.publicKey.toBase58())
  );

  // Execute instructions
  for (const ix of tx.instructions) {
    const programId = ix.programId.toBase58();

    switch (programId) {
      case SYSTEM_PROGRAM_ID:
        executeSystemInstruction(ix, ledger, signers);
        break;
      case TOKEN_PROGRAM_ID:
        executeTokenInstruction(ix, ledger, signers);
        break;
      case ATA_PROGRAM_ID:
        executeATAInstruction(ix, ledger, signers);
        break;
      default:
        throw new Error(`Unknown program: ${programId}`);
    }
  }

  ledger.incrementSlot();

  // Return first signature as tx signature
  const firstSig = tx.signatures[0];
  if (firstSig && firstSig.signature) {
    const bs58 = require('bs58');
    return bs58.encode(firstSig.signature);
  }
  return 'unknown';
}
