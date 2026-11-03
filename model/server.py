"""Local scoring HTTP boundary; Python standard library only."""
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from scoring import score


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_json(200 if self.path == '/health' else 404,
                       {'status': 'ok', 'model': 'poisson-form-v1'} if self.path == '/health' else {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/score':
            self.send_json(404, {'error': 'Not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 100_000:
                raise ValueError()
            features = json.loads(self.rfile.read(length))
            for key in ['leagueHomeGoals', 'leagueAwayGoals']:
                if not isinstance(features[key], (float, int)) or not math.isfinite(features[key]) or not 0 <= features[key] <= 100:
                    raise ValueError()
            for side in ['home', 'away']:
                for key in ['venuePlayed', 'venueGoalsFor', 'venueGoalsAgainst']:
                    value = features[side][key]
                    if not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 1000:
                        raise ValueError()
                for key in ['played', 'goalsFor', 'goalsAgainst']:
                    value = features[side]['last6'][key]
                    if not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 1000:
                        raise ValueError()
            self.send_json(200, score(features))
        except (ValueError, TypeError, KeyError, OverflowError):
            self.send_json(400, {'error': 'Invalid feature snapshot'})

    def send_json(self, status, body):
        data = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    import os
    ThreadingHTTPServer(('127.0.0.1', int(os.getenv('MODEL_PORT', '8001'))), Handler).serve_forever()
