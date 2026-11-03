"""Roofic Yield & Risk Scoring Engine (Capstone).

Transparent, auditable scoring of tokenized rental properties:
  1. Computes bear / base / bull net investor yield after vacancy, opex, manager fee,
     and platform rent fee.
  2. Computes a 0..100 risk score decomposed into four explicit factors (vacancy,
     operating_costs, building_age, downside_yield) and produces a SHA-256
     valuation hash (`valuation_hash: [u8; 32]`) stored on-chain in `Property`.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class PropertyInput:
    property_id: int
    name: str
    city: str
    price_usd: float
    gross_yield: float          # expected annual gross rent / price (e.g. 0.095)
    vacancy_rate: float         # expected vacancy fraction (e.g. 0.07)
    opex_ratio: float           # operating expenses as fraction of collected rent (e.g. 0.18)
    manager_fee_ratio: float    # property manager fee as fraction of collected rent (e.g. 0.05)
    platform_rent_fee_bps: int = 100
    platform_sale_fee_bps: int = 150
    building_age_years: int = 5


@dataclass(frozen=True)
class ScoreReport:
    property_id: int
    name: str
    net_yield_bear: float
    net_yield_base: float
    net_yield_bull: float
    risk_score: int             # 0 (lowest risk) .. 100 (highest risk)
    risk_grade: str             # "A", "B", "C", "D"
    factors: dict[str, int]     # factor -> points contributing to risk_score
    warnings: list[str]
    valuation_hash_hex: str     # 32-byte SHA-256 commitment for on-chain Property.valuation_hash


def _net_yield(
    gross_yield: float,
    vacancy: float,
    opex: float,
    manager_fee: float,
    platform_rent_fee_bps: int,
) -> float:
    collected = gross_yield * (1.0 - vacancy)
    noi = collected * (1.0 - opex - manager_fee)
    return noi * (1.0 - platform_rent_fee_bps / 10_000.0)


def evaluate_property(inp: PropertyInput) -> ScoreReport:
    if inp.price_usd <= 0:
        raise ValueError("price_usd must be positive")
    if not (0 < inp.gross_yield < 0.5):
        raise ValueError("gross_yield must be in (0, 0.5)")
    if not (0 <= inp.vacancy_rate < 1):
        raise ValueError("vacancy_rate must be in [0, 1)")
    if not (0 <= inp.opex_ratio + inp.manager_fee_ratio < 1):
        raise ValueError("opex_ratio + manager_fee_ratio must be in [0, 1)")

    base = _net_yield(
        inp.gross_yield,
        inp.vacancy_rate,
        inp.opex_ratio,
        inp.manager_fee_ratio,
        inp.platform_rent_fee_bps,
    )
    bear = _net_yield(
        inp.gross_yield * 0.85,
        min(0.95, inp.vacancy_rate + 0.07),
        min(0.90 - inp.manager_fee_ratio, inp.opex_ratio + 0.05),
        inp.manager_fee_ratio,
        inp.platform_rent_fee_bps,
    )
    bull = _net_yield(
        inp.gross_yield * 1.12,
        max(0.0, inp.vacancy_rate - 0.03),
        max(0.05, inp.opex_ratio - 0.03),
        inp.manager_fee_ratio,
        inp.platform_rent_fee_bps,
    )

    # Decomposable 0..100 risk score across 4 factors (0..25 each)
    vacancy_pts = min(25, round(inp.vacancy_rate * 125))
    cost_pts = min(25, round((inp.opex_ratio + inp.manager_fee_ratio) * 60))
    age_pts = min(25, round(max(0, inp.building_age_years) * 0.8))
    spread_pts = min(25, max(0, round((0.08 - bear) * 350)))

    factors = {
        "vacancy": vacancy_pts,
        "operating_costs": cost_pts,
        "building_age": age_pts,
        "downside_yield": spread_pts,
    }
    risk_score = min(100, sum(factors.values()))
    if risk_score < 25:
        grade = "A"
    elif risk_score < 45:
        grade = "B"
    elif risk_score < 65:
        grade = "C"
    else:
        grade = "D"

    warnings: list[str] = []
    if bear < 0.045:
        warnings.append("Bear-case net yield falls below 4.5% threshold")
    if inp.vacancy_rate > 0.12:
        warnings.append("Elevated vacancy assumption (>12%)")
    if inp.building_age_years > 20:
        warnings.append("Older building (>20y): higher capex reserve recommended")

    canonical_payload = json.dumps(
        {
            "input": asdict(inp),
            "net_yield_bear": round(bear, 6),
            "net_yield_base": round(base, 6),
            "net_yield_bull": round(bull, 6),
            "risk_score": risk_score,
            "risk_grade": grade,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    digest = hashlib.sha256(canonical_payload).hexdigest()

    return ScoreReport(
        property_id=inp.property_id,
        name=inp.name,
        net_yield_bear=bear,
        net_yield_base=base,
        net_yield_bull=bull,
        risk_score=risk_score,
        risk_grade=grade,
        factors=factors,
        warnings=warnings,
        valuation_hash_hex=digest,
    )


if __name__ == "__main__":
    sample = PropertyInput(
        property_id=1,
        name="Almaty Loft #1",
        city="Almaty",
        price_usd=100_000.0,
        gross_yield=0.095,
        vacancy_rate=0.07,
        opex_ratio=0.18,
        manager_fee_ratio=0.05,
        building_age_years=4,
    )
    rep = evaluate_property(sample)
    print(f"Property: {rep.name} (grade {rep.risk_grade}, risk {rep.risk_score}/100)")
    print(
        f"Net yield — bear: {rep.net_yield_bear:.2%} | base: {rep.net_yield_base:.2%} | bull: {rep.net_yield_bull:.2%}"
    )
    print(f"Factors:  {rep.factors}")
    print(f"SHA-256 valuation_hash: 0x{rep.valuation_hash_hex}")

