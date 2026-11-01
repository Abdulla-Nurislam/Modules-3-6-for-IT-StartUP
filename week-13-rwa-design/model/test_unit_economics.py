import math
import unittest
from dataclasses import replace

from unit_economics import (
    SCENARIOS,
    Assumptions,
    annual_breakdown,
    break_even_properties,
    distribute,
)


class WaterfallTests(unittest.TestCase):
    def test_every_dollar_of_potential_rent_is_accounted_for(self):
        for override in SCENARIOS.values():
            b = annual_breakdown(replace(Assumptions(), **override))
            parts = (
                b["vacancy_loss"] + b["opex"] + b["manager_fee"] + b["platform_rent_fee"] + b["investor_income"]
            )
            self.assertAlmostEqual(parts, b["potential_rent"], places=6)

    def test_base_case_known_values(self):
        # 100k * 9% = 9000 potential; -8% vacancy = 8280 collected;
        # -20% opex -5% manager = 6210 NOI; -1% platform = 6147.90 to investors
        b = annual_breakdown(Assumptions())
        self.assertAlmostEqual(b["collected_rent"], 8280.0)
        self.assertAlmostEqual(b["net_operating_income"], 6210.0)
        self.assertAlmostEqual(b["platform_rent_fee"], 62.10)
        self.assertAlmostEqual(b["investor_income"], 6147.90)
        self.assertAlmostEqual(b["investor_net_yield"], 0.061479)

    def test_scenarios_are_ordered(self):
        y = {n: annual_breakdown(replace(Assumptions(), **o))["investor_net_yield"] for n, o in SCENARIOS.items()}
        self.assertLess(y["bear"], y["base"])
        self.assertLess(y["base"], y["bull"])

    def test_higher_platform_fee_lowers_investor_income_one_for_one(self):
        lo = annual_breakdown(replace(Assumptions(), platform_rent_fee_bps=100))
        hi = annual_breakdown(replace(Assumptions(), platform_rent_fee_bps=300))
        self.assertAlmostEqual(
            lo["investor_income"] - hi["investor_income"], hi["platform_rent_fee"] - lo["platform_rent_fee"]
        )

    def test_break_even_actually_covers_fixed_costs(self):
        a = Assumptions()
        n = break_even_properties(a)
        fee = annual_breakdown(a)["platform_rent_fee"]
        self.assertGreaterEqual(n * fee, a.platform_fixed_cost_month * 12)
        self.assertLess((n - 1) * fee, a.platform_fixed_cost_month * 12, "n must be the minimum")

    def test_invalid_assumptions_are_rejected(self):
        for bad in (
            dict(vacancy=1.0),
            dict(price=0),
            dict(platform_rent_fee_bps=10_001),
            dict(opex_ratio=0.6, manager_fee=0.4),
        ):
            with self.assertRaises(ValueError, msg=str(bad)):
                annual_breakdown(replace(Assumptions(), **bad))

    def test_zero_platform_fee_has_no_break_even(self):
        with self.assertRaises(ValueError):
            break_even_properties(replace(Assumptions(), platform_rent_fee_bps=0))


class DistributeTests(unittest.TestCase):
    def test_exact_split(self):
        payouts, dust = distribute(1_000_000, {"a": 1, "b": 3})
        self.assertEqual(payouts, {"a": 250_000, "b": 750_000})
        self.assertEqual(dust, 0)

    def test_dust_is_tracked_and_small(self):
        holdings = {"a": 1, "b": 1, "c": 1}
        payouts, dust = distribute(100, holdings)
        self.assertEqual(payouts, {"a": 33, "b": 33, "c": 33})
        self.assertEqual(dust, 1)
        self.assertEqual(sum(payouts.values()) + dust, 100)

    def test_conservation_and_dust_bound_over_many_cases(self):
        # deterministic pseudo-random sweep, no external deps
        x = 12345
        for _ in range(500):
            x = (x * 1103515245 + 12345) % 2**31
            holders = 1 + x % 12
            holdings = {f"h{i}": 1 + (x >> i) % 500 for i in range(holders)}
            total = (x >> 3) % 10**9
            payouts, dust = distribute(total, holdings)
            self.assertEqual(sum(payouts.values()) + dust, total)
            self.assertTrue(0 <= dust < holders)
            self.assertTrue(all(p >= 0 for p in payouts.values()))

    def test_no_holder_is_paid_more_than_their_exact_share(self):
        holdings = {"a": 7, "b": 13, "c": 80}
        payouts, _ = distribute(999_999, holdings)
        for h, s in holdings.items():
            self.assertLessEqual(payouts[h], 999_999 * s / 100)

    def test_bad_inputs(self):
        with self.assertRaises(ValueError):
            distribute(100, {})
        with self.assertRaises(ValueError):
            distribute(-1, {"a": 1})
        with self.assertRaises(ValueError):
            distribute(100, {"a": -1, "b": 2})


if __name__ == "__main__":
    unittest.main()

