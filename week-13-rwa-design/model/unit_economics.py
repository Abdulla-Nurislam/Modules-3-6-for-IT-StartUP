"""Roofic unit-economics model (Week 13).

Pure standard library. Every default below is an ILLUSTRATIVE ASSUMPTION chosen to make
the model runnable. They are not market data and must be replaced with real numbers
(local rents, taxes, vacancy) before any claim is made to investors.

Two things are modelled:
  1. annual_breakdown()  - where one year of rent goes, and what an investor earns.
  2. distribute()        - pro-rata payout in integer token units, the way the on-chain
                           program has to do it (no floats, rounding dust accounted for).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

BPS = 10_000


@dataclass(frozen=True)
class Assumptions:
    price: float = 100_000.0          # USD, purchase price of the property
    gross_rent_yield: float = 0.09    # potential annual rent / price
    vacancy: float = 0.08             # share of potential rent that is not collected
    opex_ratio: float = 0.20          # of collected rent: property tax, repairs, insurance
    manager_fee: float = 0.05         # of collected rent, paid to the property manager
    platform_rent_fee_bps: int = 100  # of net operating income, taken when rent is distributed
    platform_sale_fee_bps: int = 150  # of primary-sale proceeds, charged to the property owner
    platform_fixed_cost_month: float = 3_000.0  # USD: infra, KYC provider, legal retainer

    def validate(self) -> None:
        for name in ("gross_rent_yield", "vacancy", "opex_ratio", "manager_fee"):
            v = getattr(self, name)
            if not 0 <= v < 1:
                raise ValueError(f"{name} must be in [0, 1), got {v}")
        if self.price <= 0:
            raise ValueError("price must be positive")
        for name in ("platform_rent_fee_bps", "platform_sale_fee_bps"):
            if not 0 <= getattr(self, name) <= BPS:
                raise ValueError(f"{name} must be in [0, {BPS}]")
        if self.opex_ratio + self.manager_fee >= 1:
            raise ValueError("opex_ratio + manager_fee must be below 100% of collected rent")


def annual_breakdown(a: Assumptions) -> dict[str, float]:
    """Waterfall of one year of rent for one property. All values in USD."""
    a.validate()
    potential = a.price * a.gross_rent_yield
    vacancy_loss = potential * a.vacancy
    collected = potential - vacancy_loss
    opex = collected * a.opex_ratio
    manager = collected * a.manager_fee
    net_operating = collected - opex - manager
    platform_fee = net_operating * a.platform_rent_fee_bps / BPS
    investor_income = net_operating - platform_fee
    return {
        "potential_rent": potential,
        "vacancy_loss": vacancy_loss,
        "collected_rent": collected,
        "opex": opex,
        "manager_fee": manager,
        "net_operating_income": net_operating,
        "platform_rent_fee": platform_fee,
        "investor_income": investor_income,
        "investor_net_yield": investor_income / a.price,
        "platform_sale_fee": a.price * a.platform_sale_fee_bps / BPS,
    }


def break_even_properties(a: Assumptions) -> int:
    """Properties needed for recurring platform fee income to cover fixed costs (steady state)."""
    fee = annual_breakdown(a)["platform_rent_fee"]
    if fee <= 0:
        raise ValueError("platform earns no recurring fee under these assumptions")
    return math.ceil(a.platform_fixed_cost_month * 12 / fee)


def distribute(total_units: int, holdings: dict[str, int]) -> tuple[dict[str, int], int]:
    """Split `total_units` (e.g. USDC base units, 6 decimals) pro-rata by share count.

    Floor division per holder; the remainder ("dust") is returned separately so that
    sum(payouts) + dust == total_units always holds. Dust is always < number of holders.
    """
    if total_units < 0:
        raise ValueError("total_units must be non-negative")
    total_shares = sum(holdings.values())
    if total_shares <= 0:
        raise ValueError("no shares outstanding")
    if any(s < 0 for s in holdings.values()):
        raise ValueError("negative holding")
    payouts = {h: total_units * s // total_shares for h, s in holdings.items()}
    return payouts, total_units - sum(payouts.values())


SCENARIOS = {
    "bear": dict(gross_rent_yield=0.07, vacancy=0.15, opex_ratio=0.25),
    "base": dict(),
    "bull": dict(gross_rent_yield=0.11, vacancy=0.04, opex_ratio=0.15),
}


def main() -> None:
    base = Assumptions()
    print("ILLUSTRATIVE ASSUMPTIONS - replace with real local data before using these numbers\n")
    print(f"{'scenario':<8} {'NOI/yr':>10} {'platform fee':>13} {'investor/yr':>12} {'net yield':>10} {'break-even':>11}")
    for name, override in SCENARIOS.items():
        a = replace(base, **override)
        b = annual_breakdown(a)
        print(
            f"{name:<8} {b['net_operating_income']:>10,.0f} {b['platform_rent_fee']:>13,.0f} "
            f"{b['investor_income']:>12,.0f} {b['investor_net_yield']:>9.2%} {break_even_properties(a):>10d}p"
        )
    b = annual_breakdown(base)
    print(f"\nBase case waterfall per ${base.price:,.0f} property, one year:")
    for k in ("potential_rent", "vacancy_loss", "opex", "manager_fee", "platform_rent_fee", "investor_income"):
        print(f"  {k:<18}{b[k]:>10,.0f}")
    print(f"  one-off sale fee  {b['platform_sale_fee']:>10,.0f}  (paid by the property owner at listing)")


if __name__ == "__main__":
    main()

