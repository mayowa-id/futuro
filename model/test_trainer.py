import copy
import hashlib
import json
import unittest
from trainer import dispatch, fit, predict


def features(cutoff='2025-01-01T00:00:00.000Z'):
    def side():
        return dict(venueGoalsFor=8, venueGoalsAgainst=5, venuePlayed=5,
                    last6=dict(played=6, goalsFor=10, goalsAgainst=7))
    return dict(featureVersion='form-v1', cutoff=cutoff, home=side(), away=side(),
                leagueHomeGoals=1.5, leagueAwayGoals=1.2)


def examples(count, prefix, cutoff, available_after, goals):
    return [dict(fixtureId=f'{prefix}-{i}', features=features(cutoff), availableAfter=available_after,
                 goals=list(goals)) for i in range(count)]


class TrainerTests(unittest.TestCase):
    def data(self):
        return (examples(40, 'train', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', [3, 0]),
                examples(20, 'validation', '2025-02-01T00:00:00.000Z', '2025-02-02T00:00:00.000Z', [2, 1]))

    def test_deterministic_training_and_validation_only_selection(self):
        train, validation = self.data()
        first = fit(train, validation, {'mode': 'historical'})
        self.assertEqual(first, fit(train, validation, {'mode': 'historical'}))
        self.assertEqual(len(first['report']['trials']), 9)
        self.assertEqual(first['report']['selected']['validationBrier'], min(t['validationBrier'] for t in first['report']['trials']))
        self.assertFalse(first['report']['testLabelsSeen'])
        self.assertGreater(first['artifact']['parameters']['goalScales'][0], 1)
        self.assertEqual(first['artifact']['parameters']['goalScales'][1], .5)
        with self.assertRaises(ValueError):
            dispatch(dict(action='fit', train=train, validation=validation, metadata={}, test=[{'goals': [0, 0]}]))

    def test_small_overlapping_and_reversed_splits_are_rejected(self):
        train, validation = self.data()
        with self.assertRaises(ValueError):
            fit(train[:2], validation, {})
        validation[0]['fixtureId'] = train[0]['fixtureId']
        with self.assertRaises(ValueError):
            fit(train, validation, {})
        train, validation = self.data()
        train[0]['availableAfter'] = '2026-01-01T00:00:00.000Z'
        with self.assertRaises(ValueError):
            fit(train, validation, {})

    def test_artifact_digest_cutoff_and_code_versions_are_enforced(self):
        artifact = fit(*self.data(), {'mode': 'historical'})['artifact']
        text = json.dumps(artifact, separators=(',', ':'))
        digest = hashlib.sha256(text.encode()).hexdigest()
        result = dispatch(dict(action='predict', features=[features('2025-03-01T00:00:00.000Z')], artifactJson=text, artifactHash=digest))[0]
        self.assertEqual(result['artifactHash'], digest)
        self.assertFalse(result['calibrated'])
        self.assertTrue(all(0 <= p <= 1 for p in result['probabilities'].values()))
        with self.assertRaises(ValueError):
            dispatch(dict(action='predict', features=[], artifactJson=text + ' ', artifactHash=digest))
        with self.assertRaises(ValueError):
            predict(features(), artifact, digest)
        changed = copy.deepcopy(artifact)
        changed['scoringCodeHash'] = 'wrong'
        with self.assertRaises(ValueError):
            predict(features('2025-03-01T00:00:00.000Z'), changed, digest)


if __name__ == '__main__':
    unittest.main()
