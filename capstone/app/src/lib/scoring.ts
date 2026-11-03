// ============================================================================
// Client & Server TypeScript port of `capstone/scoring/engine.py`
// Produces identical bear/base/bull yields, 4-factor risk decomposition, and
// canonical SHA-256 `valuation_hash` ([u8; 32]) committed on-chain in Property.
// ============================================================================

export interface PropertyInput {
  property_id: number;
  name: string;
  city: string;
  price_usd: number;
  gross_yield: number;        // e.g. 0.095 (9.5%)
  vacancy_rate: number;       // e.g. 0.07  (7.0%)
  opex_ratio: number;         // e.g. 0.18  (18.0%)
  manager_fee_ratio: number;  // e.g. 0.05  (5.0%)
  platform_rent_fee_bps: number;
  platform_sale_fee_bps: number;
  building_age_years: number;
}

export interface RiskFactors {
  vacancy: number;
  operating_costs: number;
  building_age: number;
  downside_yield: number;
}

export interface ScoreReport {
  property_id: number;
  name: string;
  net_yield_bear: number;
  net_yield_base: number;
  net_yield_bull: number;
  risk_score: number;
  risk_grade: "A" | "B" | "C" | "D";
  factors: RiskFactors;
  warnings: string[];
  valuation_hash_hex: string;
  valuation_hash_bytes: number[];
}

function netYield(
  grossYield: number,
  vacancy: number,
  opex: number,
  managerFee: number,
  platformRentFeeBps: number,
): number {
  const collected = grossYield * (1.0 - vacancy);
  const noi = collected * (1.0 - opex - managerFee);
  return noi * (1.0 - platformRentFeeBps / 10_000.0);
}

/** Python-compatible round-half-to-even */
function pyRoundInt(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (Math.abs(diff - 0.5) < 1e-12) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(x);
}

function pyRound6(x: number): number {
  return Number(x.toFixed(6));
}

function pyFloatJson(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : `${x}`;
}

/** Canonical payload matching `json.dumps(..., sort_keys=True, separators=(",", ":"))` in engine.py */
export function buildCanonicalPayload(
  inp: PropertyInput,
  bear: number,
  base: number,
  bull: number,
  riskScore: number,
  grade: string,
): string {
  const bBear = pyRound6(bear);
  const bBase = pyRound6(base);
  const bBull = pyRound6(bull);
  return (
    `{"input":{` +
    `"building_age_years":${Math.trunc(inp.building_age_years)},` +
    `"city":${JSON.stringify(inp.city)},` +
    `"gross_yield":${pyFloatJson(inp.gross_yield)},` +
    `"manager_fee_ratio":${pyFloatJson(inp.manager_fee_ratio)},` +
    `"name":${JSON.stringify(inp.name)},` +
    `"opex_ratio":${pyFloatJson(inp.opex_ratio)},` +
    `"platform_rent_fee_bps":${Math.trunc(inp.platform_rent_fee_bps)},` +
    `"platform_sale_fee_bps":${Math.trunc(inp.platform_sale_fee_bps)},` +
    `"price_usd":${pyFloatJson(inp.price_usd)},` +
    `"property_id":${Math.trunc(inp.property_id)},` +
    `"vacancy_rate":${pyFloatJson(inp.vacancy_rate)}` +
    `},` +
    `"net_yield_base":${pyFloatJson(bBase)},` +
    `"net_yield_bear":${pyFloatJson(bBear)},` +
    `"net_yield_bull":${pyFloatJson(bBull)},` +
    `"risk_grade":${JSON.stringify(grade)},` +
    `"risk_score":${riskScore}}`
  );
}

// Pure synchronous SHA-256 (FIPS 180-4) so `evaluateProperty` runs synchronously in React & Node
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Bytes(asciiOrUtf8: string): number[] {
  const bytes = new TextEncoder().encode(asciiOrUtf8);
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 9 + 63) & ~63);
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let i = 0; i < padLen; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(7, w[t - 15]) ^ rotr(18, w[t - 15]) ^ (w[t - 15] >>> 3);
      const s1 = rotr(17, w[t - 2]) ^ rotr(19, w[t - 2]) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, idx) => outView.setUint32(idx * 4, v, false));
  return Array.from(out);
}

export function bytesToHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length !== 64) return new Array(32).fill(0);
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16) || 0);
  }
  return out;
}

export function evaluateProperty(inp: PropertyInput): ScoreReport {
  if (inp.price_usd <= 0) throw new Error("price_usd must be positive");
  if (!(inp.gross_yield > 0 && inp.gross_yield < 0.5)) throw new Error("gross_yield must be in (0, 0.5)");
  if (!(inp.vacancy_rate >= 0 && inp.vacancy_rate < 1)) throw new Error("vacancy_rate must be in [0, 1)");
  if (!(inp.opex_ratio + inp.manager_fee_ratio >= 0 && inp.opex_ratio + inp.manager_fee_ratio < 1)) {
    throw new Error("opex_ratio + manager_fee_ratio must be in [0, 1)");
  }

  const base = netYield(
    inp.gross_yield,
    inp.vacancy_rate,
    inp.opex_ratio,
    inp.manager_fee_ratio,
    inp.platform_rent_fee_bps,
  );
  const bear = netYield(
    inp.gross_yield * 0.85,
    Math.min(0.95, inp.vacancy_rate + 0.07),
    Math.min(0.90 - inp.manager_fee_ratio, inp.opex_ratio + 0.05),
    inp.manager_fee_ratio,
    inp.platform_rent_fee_bps,
  );
  const bull = netYield(
    inp.gross_yield * 1.12,
    Math.max(0.0, inp.vacancy_rate - 0.03),
    Math.max(0.05, inp.opex_ratio - 0.03),
    inp.manager_fee_ratio,
    inp.platform_rent_fee_bps,
  );

  const vacancyPts = Math.min(25, pyRoundInt(inp.vacancy_rate * 125));
  const costPts = Math.min(25, pyRoundInt((inp.opex_ratio + inp.manager_fee_ratio) * 60));
  const agePts = Math.min(25, pyRoundInt(Math.max(0, inp.building_age_years) * 0.8));
  const spreadPts = Math.min(25, Math.max(0, pyRoundInt((0.08 - bear) * 350)));

  const factors: RiskFactors = {
    vacancy: vacancyPts,
    operating_costs: costPts,
    building_age: agePts,
    downside_yield: spreadPts,
  };
  const riskScore = Math.min(100, vacancyPts + costPts + agePts + spreadPts);
  const grade: "A" | "B" | "C" | "D" =
    riskScore < 25 ? "A" : riskScore < 45 ? "B" : riskScore < 65 ? "C" : "D";

  const warnings: string[] = [];
  if (bear < 0.045) warnings.push("Bear-case net yield falls below 4.5% threshold");
  if (inp.vacancy_rate > 0.12) warnings.push("Elevated vacancy assumption (>12%)");
  if (inp.building_age_years > 20) warnings.push("Older building (>20y): higher capex reserve recommended");

  const canonical = buildCanonicalPayload(inp, bear, base, bull, riskScore, grade);
  const hashBytes = sha256Bytes(canonical);
  const hashHex = bytesToHex(hashBytes);

  return {
    property_id: inp.property_id,
    name: inp.name,
    net_yield_bear: bear,
    net_yield_base: base,
    net_yield_bull: bull,
    risk_score: riskScore,
    risk_grade: grade,
    factors,
    warnings,
    valuation_hash_hex: hashHex,
    valuation_hash_bytes: hashBytes,
  };
}

export interface PresetCatalogItem {
  input: PropertyInput;
  totalShares: number;
  pricePerShareUsdc: number; // in human USDC (e.g. 100 USDC)
}

export const PRESET_CATALOG: PresetCatalogItem[] = [
  {
    input: {
      property_id: 1,
      name: "Almaty Loft #1",
      city: "Almaty",
      price_usd: 100_000,
      gross_yield: 0.095,
      vacancy_rate: 0.07,
      opex_ratio: 0.18,
      manager_fee_ratio: 0.05,
      platform_rent_fee_bps: 100,
      platform_sale_fee_bps: 150,
      building_age_years: 4,
    },
    totalShares: 1_000,
    pricePerShareUsdc: 100,
  },
  {
    input: {
      property_id: 2,
      name: "Astana Business Center",
      city: "Astana",
      price_usd: 250_000,
      gross_yield: 0.11,
      vacancy_rate: 0.06,
      opex_ratio: 0.16,
      manager_fee_ratio: 0.05,
      platform_rent_fee_bps: 100,
      platform_sale_fee_bps: 150,
      building_age_years: 3,
    },
    totalShares: 2_500,
    pricePerShareUsdc: 100,
  },
  {
    input: {
      property_id: 3,
      name: "Shymkent Family House",
      city: "Shymkent",
      price_usd: 80_000,
      gross_yield: 0.088,
      vacancy_rate: 0.09,
      opex_ratio: 0.2,
      manager_fee_ratio: 0.05,
      platform_rent_fee_bps: 100,
      platform_sale_fee_bps: 150,
      building_age_years: 8,
    },
    totalShares: 800,
    pricePerShareUsdc: 100,
  },
];

/** Precomputed lookup table by valuation_hash_hex for instant on-chain verification */
export const KNOWN_REPORTS_BY_HASH: Record<string, { input: PropertyInput; report: ScoreReport }> =
  Object.fromEntries(
    PRESET_CATALOG.map((item) => {
      const report = evaluateProperty(item.input);
      return [report.valuation_hash_hex, { input: item.input, report }];
    }),
  );

