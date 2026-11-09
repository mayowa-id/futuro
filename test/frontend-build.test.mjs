import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildFrontend } from '../frontend/build.mjs';

test('frontend build publishes only the API origin, and its own package has no backend dependency',async()=>{
  const secret='not-a-real-test-secret-do-not-publish';
  await buildFrontend({PUBLIC_API_URL:'https://api.example.test',API_ACCESS_TOKEN:secret,DATABASE_URL:secret,FOOTBALL_DATA_TOKEN:secret});
  const config=await readFile('frontend/dist/config.js','utf8');
  assert.ok(config.includes('https://api.example.test'));
  assert.ok(!config.includes(secret));
  const html=await readFile('frontend/dist/index.html','utf8');
  assert.ok(!html.includes('__FUTURO_API_ORIGIN__'));
  assert.match(html,/connect-src 'self' https:\/\/api.example.test/);
  const pkg=JSON.parse(await readFile('frontend/package.json','utf8'));
  assert.deepEqual(pkg.dependencies??{},{});
});

test('frontend build rejects credentialed, wildcard, remote HTTP and path-bearing API URLs',async()=>{
  for(const value of ['https://user:secret@example.com','https://*.example.com','http://example.com','https://example.com/api','https://example.com?token=secret'])
    await assert.rejects(buildFrontend({PUBLIC_API_URL:value}),/PUBLIC_API_URL/);
});
