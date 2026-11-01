// Unit tests for the pure RPC data layer (no network, fake Connection).
// Run: npm test   (node:test + tsx)
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import {
  MAX_MULTIPLE_ACCOUNTS,
  TOKEN_2022_PROGRAM,
  fetchCluster,
  fetchParsedMints,
  fetchProgramActivity,
  fetchTokens,
  short,
} from "./rpc";

const key = () => Keypair.generate().publicKey.toBase58();
const fake = (impl: Record<string, unknown>) => impl as unknown as Connection;

test("fetchParsedMints: deduplicates and never sends more than 100 addresses per RPC call", async () => {
  const mints = Array.from({ length: 250 }, key);
  const input = [...mints, ...mints.slice(0, 30)]; // 30 duplicates
  const sizes: number[] = [];
  const conn = fake({
    getMultipleParsedAccounts: async (keys: PublicKey[]) => {
      sizes.push(keys.length);
      assert.ok(keys.length <= MAX_MULTIPLE_ACCOUNTS, `batch of ${keys.length} exceeds RPC limit`);
      return { value: keys.map((k) => ({ data: { parsed: { info: { echo: k.toBase58() } }, program: "x", space: 0 } })) };
    },
  });
  const out = await fetchParsedMints(conn, input);
  assert.deepEqual(sizes, [100, 100, 50]);
  assert.equal(out.size, 250);
  for (const m of mints) {
    const d = out.get(m) as { parsed: { info: { echo: string } } };
    assert.equal(d.parsed.info.echo, m, "each mint must map to its own account data");
  }
});

test("fetchParsedMints: missing accounts map to undefined instead of shifting neighbours", async () => {
  const [a, b, c] = [key(), key(), key()];
  const conn = fake({
    getMultipleParsedAccounts: async () => ({
      value: [{ data: { parsed: { info: { n: 1 } } } }, null, { data: { parsed: { info: { n: 3 } } } }],
    }),
  });
  const out = await fetchParsedMints(conn, [a, b, c]);
  assert.equal(out.get(b), undefined);
  assert.equal((out.get(c) as { parsed: { info: { n: number } } }).parsed.info.n, 3);
});

test("fetchTokens: Token-2022 name/symbol come from on-chain tokenMetadata, with extensions listed", async () => {
  const owner = Keypair.generate().publicKey;
  const mint = key();
  const acct = {
    pubkey: Keypair.generate().publicKey,
    account: {
      data: { parsed: { info: { mint, tokenAmount: { uiAmountString: "990050", decimals: 6 } } } },
    },
  };
  const conn = fake({
    getParsedTokenAccountsByOwner: async (_o: PublicKey, f: { programId: PublicKey }) => ({
      value: f.programId.toBase58() === TOKEN_2022_PROGRAM ? [acct] : [],
    }),
    getMultipleParsedAccounts: async () => ({
      value: [
        {
          data: {
            parsed: {
              info: {
                supply: "1000000000000",
                decimals: 6,
                extensions: [
                  { extension: "transferFeeConfig", state: {} },
                  { extension: "metadataPointer", state: {} },
                  { extension: "tokenMetadata", state: { name: "Roofic", symbol: "ROOF", uri: "https://x" } },
                ],
              },
            },
          },
        },
      ],
    }),
  });
  const [t] = await fetchTokens(conn, owner);
  assert.equal(t.symbol, "ROOF");
  assert.equal(t.name, "Roofic");
  assert.equal(t.program, "Token-2022");
  assert.equal(t.amount, 990050);
  assert.equal(t.supply, 1_000_000);
  assert.deepEqual(t.extensions, ["transferFeeConfig"]);
});

test("fetchTokens: wallet with 230 token accounts does not break the RPC limit", async () => {
  const owner = Keypair.generate().publicKey;
  const accounts = Array.from({ length: 230 }, () => ({
    pubkey: Keypair.generate().publicKey,
    account: { data: { parsed: { info: { mint: key(), tokenAmount: { uiAmountString: "1", decimals: 0 } } } } },
  }));
  const conn = fake({
    getParsedTokenAccountsByOwner: async (_o: PublicKey, f: { programId: PublicKey }) => ({
      value: f.programId.toBase58() === TOKEN_2022_PROGRAM ? [] : accounts,
    }),
    getMultipleParsedAccounts: async (keys: PublicKey[]) => {
      if (keys.length > 100) throw new Error("Too many inputs provided; max 100");
      return { value: keys.map(() => null) };
    },
  });
  const res = await fetchTokens(conn, owner);
  assert.equal(res.length, 230);
  assert.ok(res.every((t) => t.name === "Unknown token"));
});

test("fetchCluster: uses non-vote TPS when every sample has it, otherwise falls back and says so", async () => {
  const base = {
    getEpochInfo: async () => ({ absoluteSlot: 100, blockHeight: 90, epoch: 5, slotIndex: 50, slotsInEpoch: 200 }),
    getVersion: async () => ({ "solana-core": "4.3.0" }),
  };
  const nonVote = await fetchCluster(
    fake({
      ...base,
      getRecentPerformanceSamples: async () => [
        { numTransactions: 6000, numNonVoteTransactions: 1000, samplePeriodSecs: 60 },
        { numTransactions: 3000, numNonVoteTransactions: 600, samplePeriodSecs: 60 },
      ],
    }),
  );
  assert.equal(nonVote.tpsNonVote, true);
  assert.equal(nonVote.epochProgress, 0.25);
  // RPC returns newest first; the series is reversed to oldest → newest, so the newest sample is last
  assert.deepEqual(nonVote.tpsSeries, [600 / 60, 1000 / 60]);
  assert.equal(nonVote.tps, 1000 / 60);

  const withVotes = await fetchCluster(
    fake({ ...base, getRecentPerformanceSamples: async () => [{ numTransactions: 6000, samplePeriodSecs: 60 }] }),
  );
  assert.equal(withVotes.tpsNonVote, false);
  assert.equal(withVotes.tps, 100);
});

test("fetchProgramActivity: counts failures and buckets by time", async () => {
  const sig = (blockTime: number, err: unknown = null) => ({ signature: `s${blockTime}`, slot: blockTime, blockTime, err });
  const conn = fake({
    // RPC returns newest first
    getSignaturesForAddress: async () => [sig(1000), sig(900, { InstructionError: [0, "x"] }), sig(500), sig(0)],
  });
  const a = await fetchProgramActivity(conn, key(), 100, 4);
  assert.equal(a.total, 4);
  assert.equal(a.failed, 1);
  assert.equal(a.firstTime, 0);
  assert.equal(a.lastTime, 1000);
  assert.equal(a.buckets.reduce((s, n) => s + n, 0), 4, "every signature lands in exactly one bucket");
  assert.equal(a.buckets.length, 4);
});

test("short(): truncates long strings only", () => {
  assert.equal(short("abcdefghijklmnop", 4), "abcd…mnop");
  assert.equal(short("abc", 4), "abc");
});
