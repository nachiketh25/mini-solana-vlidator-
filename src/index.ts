import express, { Request, Response } from 'express';

import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import bs58 from 'bs58';
import { Ledger } from './ledger';
import { processTransaction } from './transaction';
import { parseTokenAccount, isTokenAccount, parseMint } from './programs/token';

const app = express();
app.use(express.json({ limit: '10mb' }));

const ledger = new Ledger();

// WebSocket subscription tracking
// subscriptionId -> { ws, sig }
const sigSubscriptions = new Map<number, { ws: WebSocket; sig: string }>();
let nextSubId = 1;

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function contextResult(id: unknown, value: unknown) {
  return rpcResult(id, { context: { slot: ledger.getSlot() }, value });
}

function accountInfoJson(pubkey: string) {
  const acc = ledger.getAccount(pubkey);
  if (!acc) return null;
  return {
    data: [acc.data.toString('base64'), 'base64'],
    executable: acc.executable,
    lamports: Number(acc.lamports),
    owner: acc.owner,
    rentEpoch: acc.rentEpoch,
  };
}

// Notify WebSocket subscribers about a confirmed signature
function notifySignatureConfirmed(sig: string): void {
  for (const [subId, sub] of sigSubscriptions.entries()) {
    if (sub.sig === sig && sub.ws.readyState === WebSocket.OPEN) {
      sub.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'signatureNotification',
        params: {
          result: {
            context: { slot: ledger.getSlot() },
            value: { err: null },
          },
          subscription: subId,
        },
      }));
      sigSubscriptions.delete(subId);
    }
  }
}

app.post('/', (req: Request, res: Response) => {
  const body = req.body;

  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    return res.json(rpcError(body?.id ?? null, -32600, 'Invalid request'));
  }

  const { id, method, params } = body;

  try {
    const result = handleMethod(method, params ?? [], id);
    return res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.json(rpcError(id, -32603, msg));
  }
});

function handleMethod(method: string, params: unknown[], id: unknown): unknown {
  switch (method) {
    // --- Cluster Info ---
    case 'getVersion':
      return rpcResult(id, { 'solana-core': '1.18.0', 'feature-set': 3352961542 });

    case 'getSlot':
      return rpcResult(id, ledger.getSlot());

    case 'getBlockHeight':
      return rpcResult(id, ledger.getBlockHeight());

    case 'getHealth':
      return rpcResult(id, 'ok');

    // --- Blockhash ---
    case 'getLatestBlockhash': {
      const blockhash = ledger.generateBlockhash();
      const lastValidBlockHeight = ledger.getBlockHeight() + 150;
      return contextResult(id, { blockhash, lastValidBlockHeight });
    }

    case 'isBlockhashValid': {
      const bh = typeof params[0] === 'string' ? params[0] : null;
      if (!bh) throw new Error('Missing blockhash param');
      return contextResult(id, ledger.isValidBlockhash(bh));
    }

    // --- Account Queries ---
    case 'getBalance': {
      const pubkey = typeof params[0] === 'string' ? params[0] : null;
      if (!pubkey) return rpcError(id, -32602, 'Invalid params');
      const acc = ledger.getAccount(pubkey);
      return contextResult(id, acc ? Number(acc.lamports) : 0);
    }

    case 'getAccountInfo': {
      const pubkey = typeof params[0] === 'string' ? params[0] : null;
      if (!pubkey) return rpcError(id, -32602, 'Invalid params');
      return contextResult(id, accountInfoJson(pubkey));
    }

    case 'getMultipleAccounts': {
      const keys = Array.isArray(params[0]) ? params[0] as string[] : [];
      const value = keys.map((k) => accountInfoJson(k));
      return contextResult(id, value);
    }

    case 'getMinimumBalanceForRentExemption': {
      const dataSize = typeof params[0] === 'number' ? params[0] : 0;
      return rpcResult(id, Number(ledger.rentExemptLamports(dataSize)));
    }

    // --- Token Queries ---
    case 'getTokenAccountBalance': {
      const pubkey = typeof params[0] === 'string' ? params[0] : null;
      if (!pubkey) return rpcError(id, -32602, 'Invalid params');
      const acc = ledger.getAccount(pubkey);
      if (!acc || !isTokenAccount(acc.data)) {
        return rpcError(id, -32602, 'Account not found or not a token account');
      }
      const tokenData = parseTokenAccount(acc.data);
      const mintAcc = ledger.getAccount(tokenData.mint);
      const decimals = mintAcc && mintAcc.data.length >= 82 ? parseMint(mintAcc.data).decimals : 0;
      const uiAmount = Number(tokenData.amount) / Math.pow(10, decimals);
      return contextResult(id, {
        amount: tokenData.amount.toString(),
        decimals,
        uiAmount,
      });
    }

    case 'getTokenAccountsByOwner': {
      const ownerPubkey = typeof params[0] === 'string' ? params[0] : null;
      if (!ownerPubkey) return rpcError(id, -32602, 'Invalid params');

      const filter = params[1] as Record<string, string> | undefined;
      const results: unknown[] = [];

      for (const [pubkey, acc] of ledger.allAccounts()) {
        if (!isTokenAccount(acc.data)) continue;
        const tokenData = parseTokenAccount(acc.data);
        if (tokenData.owner !== ownerPubkey) continue;

        if (filter?.mint && tokenData.mint !== filter.mint) continue;
        if (filter?.programId && acc.owner !== filter.programId) continue;

        results.push({
          pubkey,
          account: {
            data: [acc.data.toString('base64'), 'base64'],
            executable: acc.executable,
            lamports: Number(acc.lamports),
            owner: acc.owner,
            rentEpoch: acc.rentEpoch,
          },
        });
      }

      return contextResult(id, results);
    }

    // --- Transaction Submission ---
    case 'requestAirdrop': {
      const pubkey = typeof params[0] === 'string' ? params[0] : null;
      const lamports = typeof params[1] === 'number' ? BigInt(params[1]) : null;
      if (!pubkey || lamports === null) return rpcError(id, -32602, 'Invalid params');

      const acc = ledger.getOrCreateAccount(pubkey);
      acc.lamports += lamports;
      ledger.setAccount(pubkey, acc);

      const sig = bs58.encode(randomBytes(64));
      ledger.recordSignature(sig);
      ledger.incrementSlot();
      notifySignatureConfirmed(sig);
      return rpcResult(id, sig);
    }

    case 'sendTransaction': {
      const encodedTx = typeof params[0] === 'string' ? params[0] : null;
      if (!encodedTx) return rpcError(id, -32602, 'Invalid params');

      try {
        const sig = processTransaction(encodedTx, ledger);
        ledger.recordSignature(sig);
        notifySignatureConfirmed(sig);
        return rpcResult(id, sig);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return rpcError(id, -32003, `Transaction failed: ${msg}`);
      }
    }

    case 'getSignatureStatuses': {
      const sigs = Array.isArray(params[0]) ? params[0] as string[] : [];
      const value = sigs.map((sig) => ledger.getSignatureStatus(sig));
      return contextResult(id, value);
    }

    case 'getTransaction': {
      const sig = typeof params[0] === 'string' ? params[0] : null;
      if (!sig) return rpcResult(id, null);
      const status = ledger.getSignatureStatus(sig);
      if (!status) return rpcResult(id, null);
      return rpcResult(id, { slot: status.slot, meta: { err: null } });
    }

    case 'simulateTransaction':
      return contextResult(id, { err: null, logs: [], accounts: null, unitsConsumed: 0 });

    case 'getFeeForMessage':
      return contextResult(id, 5000);

    case 'getRecentBlockhash': {
      const blockhash = ledger.generateBlockhash();
      return contextResult(id, {
        blockhash,
        feeCalculator: { lamportsPerSignature: 5000 },
      });
    }

    case 'getEpochInfo':
      return rpcResult(id, {
        absoluteSlot: ledger.getSlot(),
        blockHeight: ledger.getBlockHeight(),
        epoch: 0,
        slotIndex: ledger.getSlot(),
        slotsInEpoch: 432000,
        transactionCount: 0,
      });

    case 'getClusterNodes':
      return rpcResult(id, []);

    case 'getInflationReward':
      return rpcResult(id, []);

    case 'getStakeMinimumDelegation':
      return contextResult(id, 1000000);

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// WebSocket server on port 3001 (web3.js convention: HTTP port + 1)
const WS_PORT = 3001;
const wsServer = new WebSocketServer({ port: WS_PORT });

wsServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${WS_PORT} already in use. Kill the existing process and retry.`);
    process.exit(1);
  }
  throw err;
});

wsServer.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { id, method, params } = msg;

      if (method === 'signatureSubscribe') {
        const sig = params?.[0] as string;
        const subId = nextSubId++;
        const status = ledger.getSignatureStatus(sig);

        // Immediately confirm if already known
        if (status) {
          ws.send(JSON.stringify(rpcResult(id, subId)));
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'signatureNotification',
            params: {
              result: { context: { slot: status.slot }, value: { err: null } },
              subscription: subId,
            },
          }));
        } else {
          ws.send(JSON.stringify(rpcResult(id, subId)));
          sigSubscriptions.set(subId, { ws, sig });
        }
      } else if (method === 'signatureUnsubscribe') {
        const subId = params?.[0] as number;
        sigSubscriptions.delete(subId);
        ws.send(JSON.stringify(rpcResult(id, true)));
      } else if (method === 'slotSubscribe') {
        const subId = nextSubId++;
        ws.send(JSON.stringify(rpcResult(id, subId)));
      } else if (method === 'rootSubscribe') {
        const subId = nextSubId++;
        ws.send(JSON.stringify(rpcResult(id, subId)));
      } else {
        ws.send(JSON.stringify(rpcError(id, -32601, `WS method not found: ${method}`)));
      }
    } catch {
      // ignore parse errors
    }
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Solana validator RPC on port ${PORT}, WS on port ${PORT + 1}`);
});

export default app;
