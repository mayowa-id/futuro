"""Dependency-free, transparent Poisson baseline. No claimed calibration or edge."""
import math

VERSION = 'poisson-form-v1'


def poisson(rate, count):
    return math.exp(-rate) * rate ** count / math.factorial(count)


def score(features):
    home, away = features['home'], features['away']
    base_home, base_away = features['leagueHomeGoals'], features['leagueAwayGoals']
    # Shrink short samples toward league scoring rates before combining attacks/defences.
    def shrunk(total, n, prior):
        return (total + 5 * prior) / (n + 5)
    home_attack = shrunk(home['venueGoalsFor'], home['venuePlayed'], base_home)
    home_defence = shrunk(home['venueGoalsAgainst'], home['venuePlayed'], base_away)
    away_attack = shrunk(away['venueGoalsFor'], away['venuePlayed'], base_away)
    away_defence = shrunk(away['venueGoalsAgainst'], away['venuePlayed'], base_home)
    def recent(side, field):
        form = side['last6']
        return shrunk(form[field], form['played'], (base_home + base_away) / 2)
    home_recent = (recent(home, 'goalsFor') + recent(away, 'goalsAgainst')) / 2
    away_recent = (recent(away, 'goalsFor') + recent(home, 'goalsAgainst')) / 2
    rates = [min(6, max(.15, ((home_attack + away_defence) / 2 + home_recent) / 2)),
             min(6, max(.15, ((away_attack + home_defence) / 2 + away_recent) / 2))]
    markets = dict.fromkeys(['home_win', 'away_win', 'over_1_5', 'over_2_5',
                             'home_win_or_over_2_5', 'away_win_or_over_2_5'], 0.)
    mass = 0.
    for h in range(41):
        for a in range(41):
            p = poisson(rates[0], h) * poisson(rates[1], a)
            mass += p
            conditions = [h > a, a > h, h + a >= 2, h + a >= 3,
                          h > a or h + a >= 3, a > h or h + a >= 3]
            for key, win in zip(markets, conditions):
                if win:
                    markets[key] += p
    return {'modelVersion': VERSION, 'rates': rates,
            'probabilities': {key: value / mass for key, value in markets.items()},
            'calibrated': False,
            'limitations': ['Independent Poisson assumption', 'Short samples shrink toward league means',
                            'Recent-six and venue rates use fixed equal weights, not tuned weights',
                            'Injuries, motivation and source opinions do not adjust this baseline']}
