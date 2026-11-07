"""Dependency-free, transparent Poisson baseline. No claimed calibration or edge."""
import math
import hashlib
from pathlib import Path

VERSION = 'poisson-form-v1'
SPECIFICATION = dict(family='independent_poisson', shrinkageMatches=5,
                     recentWindow=6, venueWindow=10, recentVenueWeights=[0.5, 0.5],
                     rateBounds=[0.15, 6], maximumGoals=40, featureVersion='form-v1')
ARTIFACT_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def poisson(rate, count):
    return math.exp(-rate) * rate ** count / math.factorial(count)


def base_rates(features, shrinkage=5, recent_weight=0.5):
    home, away = features['home'], features['away']
    base_home, base_away = features['leagueHomeGoals'], features['leagueAwayGoals']
    # Shrink short samples toward league scoring rates before combining attacks/defences.
    def shrunk(total, n, prior):
        return (total + shrinkage * prior) / (n + shrinkage)
    home_attack = shrunk(home['venueGoalsFor'], home['venuePlayed'], base_home)
    home_defence = shrunk(home['venueGoalsAgainst'], home['venuePlayed'], base_away)
    away_attack = shrunk(away['venueGoalsFor'], away['venuePlayed'], base_away)
    away_defence = shrunk(away['venueGoalsAgainst'], away['venuePlayed'], base_home)
    def recent(side, field):
        form = side['last6']
        return shrunk(form[field], form['played'], (base_home + base_away) / 2)
    home_recent = (recent(home, 'goalsFor') + recent(away, 'goalsAgainst')) / 2
    away_recent = (recent(away, 'goalsFor') + recent(home, 'goalsAgainst')) / 2
    return [min(6, max(.15, (home_attack + away_defence) / 2 * (1 - recent_weight) + home_recent * recent_weight)),
            min(6, max(.15, (away_attack + home_defence) / 2 * (1 - recent_weight) + away_recent * recent_weight))]


def market_probabilities(rates):
    markets = dict.fromkeys(['home_win', 'away_win', 'over_1_5', 'over_2_5',
                             'home_win_or_over_2_5', 'away_win_or_over_2_5'], 0.)
    mass = 0.
    home_distribution = [poisson(rates[0], h) for h in range(41)]
    away_distribution = [poisson(rates[1], a) for a in range(41)]
    for h, home_p in enumerate(home_distribution):
        for a, away_p in enumerate(away_distribution):
            p = home_p * away_p
            mass += p
            conditions = [h > a, a > h, h + a >= 2, h + a >= 3,
                          h > a or h + a >= 3, a > h or h + a >= 3]
            for key, win in zip(markets, conditions):
                if win:
                    markets[key] += p
    return {key: min(1., max(0., value / mass)) for key, value in markets.items()}


def score(features):
    rates = base_rates(features)
    return {'modelVersion': VERSION, 'rates': rates,
            'artifactHash': ARTIFACT_HASH,
            'specification': SPECIFICATION,
            'probabilities': market_probabilities(rates),
            'calibrated': False,
            'limitations': ['Independent Poisson assumption', 'Short samples shrink toward league means',
                            'Recent-six and venue rates use fixed equal weights, not tuned weights',
                            'Injuries, motivation and source opinions do not adjust this baseline']}
