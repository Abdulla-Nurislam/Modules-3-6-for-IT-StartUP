import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { evaluateProperty, type PropertyInput } from "@/lib/scoring";

const execFileAsync = promisify(execFile);

/**
 * POST /api/score
 * Runs `capstone/scoring/engine.py` directly via Python 3 to compute and verify
 * the yield scenarios, 4-factor risk score, and SHA-256 `valuation_hash`.
 * Falls back to the identical TypeScript engine if Python is unavailable.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PropertyInput;
    const scoringDir = path.resolve(process.cwd(), "..", "scoring");
    const pyScript = `
import json, sys
from dataclasses import asdict
sys.path.insert(0, ${JSON.stringify(scoringDir)})
from engine import PropertyInput, evaluate_property
data = json.loads(sys.argv[1])
inp = PropertyInput(
    property_id=int(data["property_id"]),
    name=str(data["name"]),
    city=str(data["city"]),
    price_usd=float(data["price_usd"]),
    gross_yield=float(data["gross_yield"]),
    vacancy_rate=float(data["vacancy_rate"]),
    opex_ratio=float(data["opex_ratio"]),
    manager_fee_ratio=float(data["manager_fee_ratio"]),
    platform_rent_fee_bps=int(data.get("platform_rent_fee_bps", 100)),
    platform_sale_fee_bps=int(data.get("platform_sale_fee_bps", 150)),
    building_age_years=int(data.get("building_age_years", 5)),
)
rep = evaluate_property(inp)
out = asdict(rep)
out["valuation_hash_bytes"] = list(bytes.fromhex(rep.valuation_hash_hex))
out["engine_source"] = "python3 (capstone/scoring/engine.py)"
print(json.dumps(out))
`;
    try {
      const { stdout } = await execFileAsync("python3", ["-c", pyScript, JSON.stringify(body)], {
        timeout: 4000,
      });
      return NextResponse.json(JSON.parse(stdout.trim()));
    } catch {
      const fallback = evaluateProperty(body);
      return NextResponse.json({ ...fallback, engine_source: "typescript-fallback" });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

