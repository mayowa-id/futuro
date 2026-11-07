"""Chronological, dependency-free goal-rate fitting and validation-only grid search."""
import hashlib
import json
import math
from pathlib import Path
from scoring import ARTIFACT_HASH as SCORING_HASH, base_rates, market_probabilities, score

TRAINER_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
GRID = [(s, w) for s in (2, 5, 10) for w in (.25, .5, .75)]
MINIMUMS = {'train': 40, 'validation': 20, 'test': 20}


def outcomes(goals):
    h, a = goals
    return dict(home_win=int(h > a), away_win=int(a > h), over_1_5=int(h+a >= 2),
                over_2_5=int(h+a >= 3), home_win_or_over_2_5=int(h > a or h+a >= 3),
                away_win_or_over_2_5=int(a > h or h+a >= 3))


def rates_with_parameters(features, parameters):
    rates = base_rates(features, parameters['shrinkageMatches'], parameters['recentWeight'])
    return [min(6., max(.15, r * scale)) for r, scale in zip(rates, parameters['goalScales'])]


def brier(examples, parameters=None):
    losses = []
    for item in examples:
        probabilities = (market_probabilities(rates_with_parameters(item['features'], parameters))
                         if parameters is not None else score(item['features'])['probabilities'])
        actual = outcomes(item['goals'])
        losses.append(sum((probabilities[key] - actual[key]) ** 2 for key in actual) / len(actual))
    return sum(losses) / len(losses)


def fit(train, validation, metadata):
    if len(train) < MINIMUMS['train'] or len(validation) < MINIMUMS['validation']:
        raise ValueError('At least 40 eligible training and 20 validation fixtures are required')
    seen = set()
    for split in (train, validation):
        for item in split:
            if item['fixtureId'] in seen:
                raise ValueError('Training/validation fixtures must be disjoint')
            seen.add(item['fixtureId'])
            if len(item['goals']) != 2 or any(type(g) is not int or not 0 <= g <= 100 for g in item['goals']):
                raise ValueError('Invalid regulation goals')
            if item['features']['featureVersion'] != 'form-v1':
                raise ValueError('Unsupported feature version')
    if max(item['availableAfter'] for item in train) > min(item['features']['cutoff'] for item in validation):
        raise ValueError('Training outcomes must precede validation cutoffs')
    trials = []
    for shrinkage, weight in GRID:
        initial = [base_rates(item['features'], shrinkage, weight) for item in train]
        # Poisson MLE for a multiplicative goal-rate correction, fitted to training labels only.
        scales = [min(2., max(.5, sum(item['goals'][side] for item in train) /
                              sum(rate[side] for rate in initial))) for side in (0, 1)]
        parameters = dict(shrinkageMatches=shrinkage, recentWeight=weight, goalScales=scales)
        training_nll = sum(sum(r - g * math.log(r) + math.lgamma(g + 1)
                               for r, g in zip(rates_with_parameters(item['features'], parameters), item['goals']))
                           for item in train) / len(train)
        trials.append(dict(parameters=parameters, trainingGoalNll=training_nll,
                           validationBrier=brier(validation, parameters)))
    chosen = min(trials, key=lambda trial: trial['validationBrier'])
    artifact = dict(formatVersion=1, modelVersion='trained-poisson-v1', scoringCodeHash=SCORING_HASH,
                    trainerCodeHash=TRAINER_HASH, parameters=chosen['parameters'], metadata=metadata,
                    trainedThrough=max(item['availableAfter'] for item in train),
                    validatedThrough=max(item['availableAfter'] for item in validation), calibrated=False)
    return dict(artifact=artifact, report=dict(selectionMetric='validation mean six-market Brier per fixture',
                trainFixtures=len(train), validationFixtures=len(validation), trials=trials,
                selected=chosen, baselineValidationBrier=brier(validation), testLabelsSeen=False))


def predict(features, artifact, artifact_hash):
    if artifact['formatVersion'] != 1 or artifact['scoringCodeHash'] != SCORING_HASH or artifact['trainerCodeHash'] != TRAINER_HASH:
        raise ValueError('Model artifact requires the scoring/trainer code version it was created with')
    if features['featureVersion'] != 'form-v1' or features['cutoff'] < artifact['validatedThrough']:
        raise ValueError('Prediction cutoff must follow the model selection period')
    rates = rates_with_parameters(features, artifact['parameters'])
    specification = dict(family='trained_independent_poisson', parameters=artifact['parameters'],
                         **artifact['metadata'], trainedThrough=artifact['trainedThrough'],
                         validatedThrough=artifact['validatedThrough'], featureVersion='form-v1')
    return dict(modelVersion=artifact['modelVersion'], rates=rates, artifactHash=artifact_hash,
                specification=specification, probabilities=market_probabilities(rates), calibrated=False,
                limitations=['Independent Poisson assumption', 'Parameters selected on validation data, not calibrated confidence',
                             'No automatic promotion; held-out comparison is descriptive',
                             'Injuries, context and website opinions are not fitted features'])


def dispatch(request):
    action = request.get('action')
    if action == 'fit' and set(request) == {'action', 'train', 'validation', 'metadata'}:
        return fit(request['train'], request['validation'], request['metadata'])
    if action == 'predict' and set(request) == {'action', 'features', 'artifactJson', 'artifactHash'}:
        if hashlib.sha256(request['artifactJson'].encode()).hexdigest() != request['artifactHash']:
            raise ValueError('Artifact digest mismatch')
        artifact = json.loads(request['artifactJson'])
        return [predict(f, artifact, request['artifactHash']) for f in request['features']]
    if action == 'baseline' and set(request) == {'action', 'features'}:
        return [score(f) for f in request['features']]
    raise ValueError('Unsupported worker request; fitting accepts training and validation data only')


if __name__ == '__main__':
    import sys
    try:
        request = json.load(sys.stdin)
        json.dump(dispatch(request), sys.stdout, allow_nan=False, separators=(',', ':'))
    except (ValueError, KeyError, TypeError, OverflowError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
