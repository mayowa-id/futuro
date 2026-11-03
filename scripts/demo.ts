import 'dotenv/config';
import { Futuro } from '../src/service';
import { Store } from '../src/store';
import { sampleFixtures } from './sample';

async function main() {
  const store = new Store('./data/demo.sqlite');
  try {
    const { history, target } = sampleFixtures();
    store.ingest('demo', target.observedAt, { synthetic: true }, [...history, target]);
    const futuro = new Futuro(store);
    const prediction = await futuro.predict(target.id, 'demo');
    store.ingest('demo', new Date().toISOString(), { syntheticResult: [2, 1] }, [{ ...target, observedAt: new Date().toISOString(), status: 'finished', score: [2, 1] }]);
    futuro.settle();
    console.log(JSON.stringify({ synthetic: true, predictionId: prediction.id, explanation: prediction.explanation,
      candidates: prediction.candidates, performance: futuro.performance('demo') }, null, 2));
  } finally { store.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
