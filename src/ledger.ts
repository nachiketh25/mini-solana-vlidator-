import bs58 from 'bs58';
import { randomBytes } from 'crypto';

export interface Account {
  lamports: bigint;
  owner: string;
  data: Buffer;
  executable: boolean;
  rentEpoch: number;
}

export interface SignatureStatus {
  slot: number;
  confirmations: null;
  err: null;
  confirmationStatus: 'confirmed';
}

export class Ledger {
  private accounts: Map<string, Account> = new Map();
  private slot: number = 1;
  private blockHeight: number = 1;
  private validBlockhashes: Set<string> = new Set();
  private processedSignatures: Map<string, SignatureStatus> = new Map();

  constructor() {
    // Pre-generate an initial blockhash
    this.generateBlockhash();
  }

  generateBlockhash(): string {
    const hash = bs58.encode(randomBytes(32));
    this.validBlockhashes.add(hash);
    return hash;
  }

  isValidBlockhash(blockhash: string): boolean {
    return this.validBlockhashes.has(blockhash);
  }

  getSlot(): number {
    return this.slot;
  }

  getBlockHeight(): number {
    return this.blockHeight;
  }

  incrementSlot(): void {
    this.slot++;
    this.blockHeight++;
  }

  getAccount(pubkey: string): Account | undefined {
    return this.accounts.get(pubkey);
  }

  setAccount(pubkey: string, account: Account): void {
    this.accounts.set(pubkey, account);
  }

  deleteAccount(pubkey: string): void {
    this.accounts.delete(pubkey);
  }

  recordSignature(sig: string): void {
    this.processedSignatures.set(sig, {
      slot: this.slot,
      confirmations: null,
      err: null,
      confirmationStatus: 'confirmed',
    });
  }

  getSignatureStatus(sig: string): SignatureStatus | null {
    return this.processedSignatures.get(sig) ?? null;
  }

  getOrCreateAccount(pubkey: string): Account {
    const existing = this.accounts.get(pubkey);
    if (existing) return existing;
    const acc: Account = {
      lamports: 0n,
      owner: '11111111111111111111111111111111',
      data: Buffer.alloc(0),
      executable: false,
      rentEpoch: 0,
    };
    this.accounts.set(pubkey, acc);
    return acc;
  }

  allAccounts(): Map<string, Account> {
    return this.accounts;
  }

  rentExemptLamports(dataSize: number): bigint {
    return BigInt(Math.ceil((dataSize + 128) * 6960));
  }
}
