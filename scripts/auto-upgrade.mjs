import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT = '80a521ba84f9998155fd875767e1e947';
const KV = 'd0dfa57fdac448c4b02dfcd614ac1092';
const SITE = 'https://sublink.youbin-li.workers.dev';
const UPSTREAM = '7Sageer/sublink-worker';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/sublink`;
export function compareVersions(a, b) {
  const parse = v => { if (!/^v\d+\.\d+\.\d+$/.test(v)) throw Error('Expected a stable release tag'); return v.slice(1).split('.').map(BigInt); };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function pageVersion(html) {
  const matches = [...html.matchAll(/https:\/\/github\.com\/7Sageer\/sublink-worker\/releases\/tag\/(v\d+\.\d+\.\d+)(?=["'\s<])/g)];
  const tags = [...new Set(matches.map(m => m[1]))];
  if (tags.length !== 1) throw Error('Cannot identify deployed version from homepage');
  return tags[0];
}
export function configure(input) {
  // A changed deployment surface needs review before it can touch production.
  const allowed = new Set(['name','main','compatibility_date','compatibility_flags','kv_namespaces','binding','id','directory']);
  for (const line of input.split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    if (text.startsWith('[') && text !== '[assets]' && text !== ']') throw Error('Unexpected deployment table');
    for (const match of text.matchAll(/\b([a-zA-Z_][\w]*)\s*=/g)) if (!allowed.has(match[1])) throw Error(`Unexpected configuration: ${match[1]}`);
  }
  if ((input.match(/^name\s*=/gm) || []).length !== 1 || (input.match(/binding\s*=\s*"SUBLINK_KV"/g) || []).length !== 1) throw Error('Unexpected Worker/KV configuration');
  if (!/^main\s*=\s*"src\/worker\.jsx"\s*$/m.test(input) || !/^directory\s*=\s*"\.\/public"\s*$/m.test(input)) throw Error('Unexpected Worker entry or asset directory');
  const kvPattern = /kv_namespaces\s*=\s*\[\s*\{\s*binding\s*=\s*"SUBLINK_KV"\s*,\s*id\s*=\s*"[^"]*"\s*\}\s*\]/;
  if (!kvPattern.test(input)) throw Error('Unexpected KV schema');
  return input.replace(/^name\s*=.*$/m, `name = "sublink"\naccount_id = "${ACCOUNT}"\nworkers_dev = true\npreview_urls = true`)
    .replace(kvPattern, `kv_namespaces = [\n  { binding = "SUBLINK_KV", id = "${KV}" }\n]`);
}
function sameVersions(a, b) {
  const normalize = v => v.map(x => `${x.version_id}:${x.percentage}`).sort().join(',');
  return normalize(a) === normalize(b);
}
export async function transact(ops) {
  const before = await ops.snapshot();
  let candidate;
  try {
    candidate = await ops.upload();
    if ((await ops.current()).id !== before.id) throw Error('Deployment changed during upload; refusing to overwrite it');
    await ops.activate([{ version_id: candidate, percentage: 100 }]);
    await ops.verify(candidate);
  } catch (error) {
    if (candidate) {
      const current = await ops.current();
      if (sameVersions(current.versions, [{version_id:candidate,percentage:100}])) {
        await ops.activate(before.versions);
        await ops.verifyRollback(before);
        console.error('Upgrade failed; original deployment restored and verified.');
      } else if (!sameVersions(current.versions, before.versions)) {
        throw new Error(`Deployment changed externally; rollback stopped. Original error: ${error.message}`);
      }
    }
    throw error;
  }
}
async function request(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  return response;
}
async function cf(path, body) {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw Error('Missing CLOUDFLARE_API_TOKEN repository secret');
  const response = await request(`${API}/${path}`, {
    method: body ? 'POST' : 'GET', headers: {Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {})
  });
  const data = await response.json();
  if (!data.success) throw Error(`Cloudflare operation failed: ${path}`);
  return data.result;
}
async function github(path) {
  return (await request(`https://api.github.com/repos/${UPSTREAM}/${path}`, {headers:{Accept:'application/vnd.github+json',...(process.env.GH_TOKEN ? {Authorization:`Bearer ${process.env.GH_TOKEN}`} : {})}})).json();
}
async function retry(fn) {
  let error;
  for (let i=0;i<5;i++) { try { return await fn(); } catch(e) { error=e; if(i<4) await new Promise(r=>setTimeout(r,5000)); } }
  throw error;
}
async function health(tag) {
  const suffix = `?upgrade_check=${Date.now()}`;
  const html = await (await request(SITE+'/'+suffix)).text();
  if (pageVersion(html) !== tag) throw Error('Homepage release differs from expected version');
  const icon = await request(SITE+'/favicon.png'+suffix);
  if (!icon.headers.get('content-type')?.includes('image/png')) throw Error('Static asset check failed');
  const sample='vless://00000000-0000-4000-8000-000000000001@example.com:443?security=tls&type=tcp#DeployCheck';
  const config=encodeURIComponent(sample);
  const json=await (await request(`${SITE}/singbox?config=${config}`)).json();
  if (!json.outbounds?.some(p=>p.type==='vless' && p.server==='example.com')) throw Error('Sing-box conversion check failed');
  const yaml=await (await request(`${SITE}/clash?config=${config}`)).text();
  if (!yaml.includes('proxies:') || !yaml.includes('example.com')) throw Error('Clash conversion check failed');
  const ini=await (await request(SITE+'/subconverter?selectedRules=minimal')).text();
  if (!ini.includes('[custom]')) throw Error('Subconverter check failed');
}
async function detect() {
  const release=await github('releases/latest');
  if (release.draft || release.prerelease) throw Error('Latest release is not stable');
  const tag=release.tag_name;
  const current=pageVersion(await (await request(SITE+'/?upgrade_check='+Date.now())).text());
  const upgrade=compareVersions(tag,current)>0;
  let object=(await github(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for(let i=0;object.type==='tag' && i<5;i++) object=(await github(`git/tags/${object.sha}`)).object;
  if(object.type!=='commit' || !/^[0-9a-f]{40}$/.test(object.sha)) throw Error('Cannot resolve immutable release commit');
  const state={tag,current,sha:object.sha,upgrade};
  await writeFile('upgrade-state.json',JSON.stringify(state,null,2));
  if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,`upgrade=${upgrade}\nsha=${object.sha}\ntag=${tag}\n`);
  console.log(JSON.stringify(state));
}
async function prepare(directory) {
  const state=JSON.parse(await readFile('upgrade-state.json','utf8'));
  const pkg=JSON.parse(await readFile(resolve(directory,'package.json'),'utf8'));
  if('v'+pkg.version!==state.tag) throw Error('Package version does not match release');
  const file=resolve(directory,'wrangler.toml');
  await writeFile(file,configure(await readFile(file,'utf8')));
}
async function apply(directory) {
  const state=JSON.parse(await readFile('upgrade-state.json','utf8'));
  if(!state.upgrade) return;
  const current=async()=>{const list=(await cf('deployments')).deployments; if(!list?.length) throw Error('No existing deployment'); return list[0];};
  const assertBinding=async()=>{
    const bindings=(await cf('settings')).bindings;
    if(!bindings.some(b=>b.name==='SUBLINK_KV' && b.type==='kv_namespace' && b.namespace_id===KV)) throw Error('Original KV binding changed');
    if(bindings.some(b=>b.name!=='SUBLINK_KV' && b.type!=='assets')) throw Error('Unexpected production bindings need review');
  };
  await transact({
    snapshot: async()=>{
      await assertBinding();
      const before=await current();
      if(pageVersion(await (await request(SITE+'/?upgrade_check='+Date.now())).text())!==state.current) throw Error('Homepage changed after release detection');
      if(!before.versions?.length || before.versions.reduce((n,v)=>n+v.percentage,0)!==100) throw Error('Invalid existing deployment');
      await writeFile('deployment-before.json',JSON.stringify(before,null,2)); return before;
    },
    upload: async()=>{
      const cli=resolve('tooling/node_modules/wrangler/bin/wrangler.js');
      const run=spawnSync(process.execPath,[cli,'versions','upload','--config',resolve(directory,'wrangler.toml'),'--message',`Sublink ${state.tag}; run ${process.env.GITHUB_RUN_ID || 'manual'}`],{encoding:'utf8',timeout:180000,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
      const output=(run.stdout||'')+'\n'+(run.stderr||''); console.log(output);
      if(run.error || run.status!==0) throw Error('Candidate upload failed');
      const id=output.match(/Worker Version ID:\s*([0-9a-f-]{36})/i)?.[1];
      if(!id) throw Error('Could not identify uploaded version; production was not activated');
      await writeFile('candidate-version.json',JSON.stringify({id,tag:state.tag})); return id;
    },
    current,
    activate: versions=>cf('deployments',{strategy:'percentage',versions}),
    verify: id=>retry(async()=>{
      if(!sameVersions((await current()).versions,[{version_id:id,percentage:100}])) throw Error('Candidate is not the active deployment');
      await assertBinding(); await health(state.tag);
    }),
    verifyRollback: before=>retry(async()=>{
      if(!sameVersions((await current()).versions,before.versions)) throw Error('Rollback deployment differs from original');
      await assertBinding(); await health(state.current);
    })
  });
  console.log(`Verified upgrade to ${state.tag}`);
}
async function preflight() {
  const bindings=(await cf('settings')).bindings;
  if(!bindings.some(b=>b.name==='SUBLINK_KV' && b.type==='kv_namespace' && b.namespace_id===KV)) throw Error('Original production KV binding differs');
  const deployments=(await cf('deployments')).deployments;
  if(!deployments?.length) throw Error('No existing production deployment');
  console.log('Cloudflare deployment credential and original KV binding verified.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [command,directory='upstream']=process.argv.slice(2);
  try {
    if(command==='preflight') await preflight();
    else if(command==='detect') await detect();
    else if(command==='prepare') await prepare(directory);
    else if(command==='apply') await apply(directory);
    else if(command==='health') await health(process.argv[3]);
    else throw Error('Expected preflight, detect, prepare, apply, or health');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
