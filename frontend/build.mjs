import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
export async function buildFrontend(environment = process.env) {
  let local = '';
  try { local = (await readFile(join(root,'.env'),'utf8')).match(/^PUBLIC_API_URL\s*=\s*["']?([^\s"']+)["']?\s*$/m)?.[1] ?? ''; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = environment.PUBLIC_API_URL ?? (local || 'https://futuro-api-69dy.onrender.com');
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_API_URL must be the API origin'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) ||
    url.username || url.password || url.hostname.includes('*') || url.search || url.hash || !['','/'].includes(url.pathname))
    throw new Error('PUBLIC_API_URL must be an HTTPS origin, or HTTP localhost for development');
  const output = join(root,'dist');
  await mkdir(output,{recursive:true});
  for (const file of ['index.html','app.css','app.js']) {
    let text = await readFile(join(root,'src',file),'utf8');
    if (file === 'index.html') text = text.replaceAll('__FUTURO_API_ORIGIN__',url.origin);
    await writeFile(join(output,file),text);
  }
  await writeFile(join(output,'config.js'),`window.FUTURO_CONFIG = Object.freeze(${JSON.stringify({apiUrl:url.origin})});\n`);
  console.log('Futuro frontend built in frontend/dist');
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  buildFrontend().catch(error=>{console.error(error.message);process.exitCode=1;});
