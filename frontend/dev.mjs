import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrontend } from './build.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (!process.argv.includes('--no-build')) await buildFrontend();
const port = Number(process.env.FRONTEND_PORT ?? 4173);
const files = { '/':['index.html','text/html'], '/index.html':['index.html','text/html'],
  '/app.css':['app.css','text/css'], '/app.js':['app.js','text/javascript'], '/config.js':['config.js','text/javascript'] };
createServer(async (request,response)=>{
  const file = files[new URL(request.url,'http://localhost').pathname];
  if (!file || !['GET','HEAD'].includes(request.method)) {response.writeHead(404);response.end();return;}
  try {
    const content = await readFile(join(root,'dist',file[0]));
    response.writeHead(200,{'Content-Type':`${file[1]}; charset=utf-8`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(request.method==='HEAD'?undefined:content);
  } catch {response.writeHead(503);response.end('Run npm run build first.');}
}).listen(port,'localhost',()=>console.log(`Futuro frontend: http://localhost:${port}`));
