import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Connection, Keypair, PublicKey } from "@solana/web3.js";
import { decodePriceUpdateV2, getPrice, PYTH_RECEIVER } from "./pyth.js";

/** Собирает валидный бинарный буфер PriceUpdateV2 для тестирования декодера и защитных проверок */
function buildPriceUpdateV2Buffer({
  verification = "Full" as "Full" | "Partial",
  price = 150_00000000n,
  conf = 10_000000n,
  expo = -8,
  publishTimeSec = Math.floor(Date.now() / 1000) - 5,
  emaPrice = 149_50000000n,
  postedSlot = 310_000_000n,
} = {}): Buffer {
  const levelLen = verification === "Partial" ? 2 : 1;
  const buf = Buffer.alloc(8 + 32 + levelLen + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  let o = 8 + 32; // discriminator + write_authority
  if (verification === "Partial") {
    buf.writeUInt8(0, o);
    buf.writeUInt8(5, o + 1); // num_signatures
    o += 2;
  } else {
    buf.writeUInt8(1, o);
    o += 1;
  }
  buf.fill(0xab, o, o + 32); // feed_id
  o += 32;
  buf.writeBigInt64LE(price, o);
  o += 8;
  buf.writeBigUInt64LE(conf, o);
  o += 8;
  buf.writeInt32LE(expo, o);
  o += 4;
  buf.writeBigInt64LE(BigInt(publishTimeSec), o);
  o += 8;
  buf.writeBigInt64LE(BigInt(publishTimeSec - 1), o);
  o += 8;
  buf.writeBigInt64LE(emaPrice, o);
  o += 8;
  buf.writeBigUInt64LE(conf, o);
  o += 8;
  buf.writeBigUInt64LE(postedSlot, o);
  return buf;
}

function mockConnection(owner: PublicKey, data: Buffer | null): Connection {
  return {
    getAccountInfo: async () =>
      data
        ? {
            owner,
            data,
            executable: false,
            lamports: 1_000_000,
            rentEpoch: 0,
          }
        : null,
  } as unknown as Connection;
}

describe("Pyth PriceUpdateV2 decoder & 5 oracle safety checks", () => {
  it("decodes Full PriceUpdateV2 layout and computes conservative price", () => {
    const buf = buildPriceUpdateV2Buffer({
      price: 150_25000000n,
      conf: 25000000n,
      expo: -8,
    });
    const decoded = decodePriceUpdateV2(buf);
    assert.equal(decoded.verification, "Full");
    assert.ok(Math.abs(decoded.price - 150.25) < 1e-6);
    assert.ok(Math.abs(decoded.conf - 0.25) < 1e-6);
    assert.ok(Math.abs(decoded.price - decoded.conf - 150.0) < 1e-6);
  });

  it("rejects spoofed account owner (!= PYTH_RECEIVER)", async () => {
    const fakeOwner = Keypair.generate().publicKey;
    const conn = mockConnection(fakeOwner, buildPriceUpdateV2Buffer());
    await assert.rejects(
      () => getPrice(conn, PublicKey.unique()),
      /Pyth Receiver/,
    );
  });

  it("rejects Partial verification level", async () => {
    const conn = mockConnection(
      PYTH_RECEIVER,
      buildPriceUpdateV2Buffer({ verification: "Partial" }),
    );
    await assert.rejects(
      () => getPrice(conn, PublicKey.unique()),
      /Wormhole guardians/,
    );
  });

  it("rejects stale price feed (> maxAgeSec)", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 900;
    const conn = mockConnection(
      PYTH_RECEIVER,
      buildPriceUpdateV2Buffer({ publishTimeSec: staleSec }),
    );
    await assert.rejects(
      () => getPrice(conn, PublicKey.unique(), { maxAgeSec: 120 }),
      /устарела/,
    );
  });

  it("rejects wide confidence interval (conf / price > maxConfRatio)", async () => {
    const conn = mockConnection(
      PYTH_RECEIVER,
      buildPriceUpdateV2Buffer({
        price: 100_00000000n,
        conf: 5_00000000n, // 5% > 2%
      }),
    );
    await assert.rejects(
      () => getPrice(conn, PublicKey.unique(), { maxConfRatio: 0.02 }),
      /доверительный интервал/,
    );
  });
});

