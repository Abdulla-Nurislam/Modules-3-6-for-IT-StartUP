import unittest
from dataclasses import replace

from engine import PropertyInput, evaluate_property


class ScoringEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sample = PropertyInput(
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

    def test_scenario_ordering_and_bounds(self) -> None:
        rep = evaluate_property(self.sample)
        self.assertLess(rep.net_yield_bear, rep.net_yield_base)
        self.assertLess(rep.net_yield_base, rep.net_yield_bull)
        self.assertTrue(0 <= rep.risk_score <= 100)
        self.assertEqual(rep.risk_score, sum(rep.factors.values()))
        self.assertEqual(len(bytes.fromhex(rep.valuation_hash_hex)), 32)

    def test_hash_is_deterministic_and_sensitive_to_inputs(self) -> None:
        r1 = evaluate_property(self.sample)
        r2 = evaluate_property(self.sample)
        r3 = evaluate_property(replace(self.sample, vacancy_rate=0.08))
        self.assertEqual(r1.valuation_hash_hex, r2.valuation_hash_hex)
        self.assertNotEqual(r1.valuation_hash_hex, r3.valuation_hash_hex)

    def test_worse_fundamentals_increase_risk_and_trigger_warnings(self) -> None:
        good = evaluate_property(self.sample)
        risky = evaluate_property(
            replace(self.sample, vacancy_rate=0.16, opex_ratio=0.28, building_age_years=25, gross_yield=0.07)
        )
        self.assertGreater(risky.risk_score, good.risk_score)
        self.assertEqual(len(good.warnings), 0)
        self.assertGreaterEqual(len(risky.warnings), 2)

    def test_invalid_inputs_rejected(self) -> None:
        with self.assertRaises(ValueError):
            evaluate_property(replace(self.sample, price_usd=0))
        with self.assertRaises(ValueError):
            evaluate_property(replace(self.sample, vacancy_rate=1.0))

    def test_cyrillic_utf8_hash_matches_typescript_engine(self) -> None:
        cyr = PropertyInput(
            property_id=2,
            name="Тест Алматы",
            city="Алматы",
            price_usd=123_456.78,
            gross_yield=0.0731,
            vacancy_rate=0.113,
            opex_ratio=0.271,
            manager_fee_ratio=0.0615,
            building_age_years=27,
        )
        rep = evaluate_property(cyr)
        self.assertEqual(rep.risk_score, 73)
        self.assertEqual(rep.valuation_hash_hex[:16], "46e7f31ddc9d8c3b")


if __name__ == "__main__":
    unittest.main()

