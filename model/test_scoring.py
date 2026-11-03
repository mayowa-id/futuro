import math
import unittest
from scoring import score


class ScoringTests(unittest.TestCase):
    def features(self, rate=1.5):
        def side():
            return dict(venueGoalsFor=rate * 5, venueGoalsAgainst=rate * 5, venuePlayed=5,
                        last6=dict(played=6, goalsFor=rate * 6, goalsAgainst=rate * 6))
        return dict(home=side(), away=side(), leagueHomeGoals=rate, leagueAwayGoals=rate)

    def test_recent_scoring_affects_prediction(self):
        features = self.features()
        before = score(features)['probabilities']['home_win']
        features['home']['last6']['goalsFor'] = 24
        self.assertGreater(score(features)['probabilities']['home_win'], before)

    def test_totals_equal_closed_form_poisson(self):
        result = score(self.features())
        self.assertAlmostEqual(result['probabilities']['over_1_5'], 1 - math.exp(-3) * 4, places=10)
        self.assertAlmostEqual(result['probabilities']['over_2_5'], 1 - math.exp(-3) * (1 + 3 + 4.5), places=10)

    def test_symmetric_teams_and_inclusive_union(self):
        p = score(self.features())['probabilities']
        self.assertAlmostEqual(p['home_win'], p['away_win'])
        self.assertGreater(p['home_win_or_over_2_5'], max(p['home_win'], p['over_2_5']))
        self.assertLess(p['home_win_or_over_2_5'], p['home_win'] + p['over_2_5'])

    def test_extreme_rates_stay_valid(self):
        for rate in [0, .1, 6, 100]:
            result = score(self.features(rate))
            self.assertFalse(result['calibrated'])
            for value in result['probabilities'].values():
                self.assertTrue(math.isfinite(value) and 0 <= value <= 1)


if __name__ == '__main__':
    unittest.main()
