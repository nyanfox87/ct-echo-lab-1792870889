import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';
const mode=process.env.PROBE_MODE,version=mode==='v6'?6:7,mime=mode==='v6'?'\u0085application/json':'application/json';
const ghToken=process.env.GH_TOKEN,runId=process.env.GITHUB_RUN_ID,repo=process.env.GITHUB_REPOSITORY;
if(!process.env.ACTIONS_RUNTIME_TOKEN||!ghToken)throw new Error('runtime credentials unavailable');
const ids=getBackendIdsFromToken(),client=internalArtifactTwirpClient();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function create(name,body){
 const c=await client.CreateArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,version,mimeType:StringValue.create({value:mime})});
 if(!c.ok||!c.signedUploadUrl)throw new Error(`create failed v${version}`);
 const blob=new BlobClient(c.signedUploadUrl).getBlockBlobClient();
 const placeholder=Buffer.from('{"p":1}');
 await blob.uploadData(placeholder,{blobHTTPHeaders:{blobContentType:mime}});
 const hash=createHash('sha256').update(placeholder).digest('hex');
 const f=await client.FinalizeArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${hash}`})});
 if(!f.ok)throw new Error(`finalize failed v${version}`);
 const id=String(f.artifactId);
 return {id,url:c.signedUploadUrl};
}
async function list(){const r=await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,{headers:{authorization:`Bearer ${ghToken}`,accept:'application/vnd.github+json','user-agent':'repo-cassette-cross-job-probe'}});return {status:r.status,data:await r.json().catch(()=>({}))};}
async function inspect(id,expected){const r=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,{redirect:'manual',headers:{authorization:`Bearer ${ghToken}`,accept:'application/vnd.github+json','user-agent':'repo-cassette-cross-job-probe'}});const loc=r.headers.get('location');if(!loc)return{id,status:r.status};const u=new URL(loc),raw=await fetch(loc),body=Buffer.from(await raw.arrayBuffer());return{id,status:r.status,rsct:u.searchParams.get('rsct'),rawType:raw.headers.get('content-type'),exact:body.equals(expected),len:body.length};}
const signalName=`cross-signal-${runId}-${mode}`;
const signalBody=Buffer.from(JSON.stringify({mode,signal:true}));
const signal=await create(signalName,signalBody);
console.log(JSON.stringify({mode,event:'signal',id:signal.id,jobBackend:ids.workflowJobRunBackendId}));
let current;
for(let i=0;i<60;i++){current=await list();const names=new Set((current.data.artifacts||[]).map(a=>a.name));if(names.has(`cross-signal-${runId}-v6`)&&names.has(`cross-signal-${runId}-v7`))break;await delay(500);}
const artifacts=current.data.artifacts||[];
if(!artifacts.some(a=>a.name===`cross-signal-${runId}-v6`)||!artifacts.some(a=>a.name===`cross-signal-${runId}-v7`)){console.log(JSON.stringify({mode,event:'barrier-failed',listStatus:current.status,count:artifacts.length}));process.exit(0);}
const latest=Math.max(...artifacts.filter(a=>a.name.startsWith(`cross-signal-${runId}-`)).map(a=>Date.parse(a.created_at)))+5000;
await delay(Math.max(0,latest-Date.now()));
console.log(JSON.stringify({mode,event:'start',backend:ids.workflowJobRunBackendId}));
const names=Array.from({length:4},(_,i)=>`cross-shared-${runId}-${i}`);
for(let i=0;i<names.length;i++){
 try{
  const item=await create(names[i],Buffer.from(JSON.stringify({mode,pair:i,placeholder:true})));
  const body=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${item.id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},mode,pair:i}));
  const overwrite=await new BlobClient(item.url).getBlockBlobClient().uploadData(body,{blobHTTPHeaders:{blobContentType:mime}});
  console.log(JSON.stringify({mode,event:'created',name:names[i],id:item.id,overwrite:true}));
 }catch(e){console.log(JSON.stringify({mode,event:'create-error',name:names[i],error:String(e?.message||e).slice(0,160)}));}
}
await delay(2000);
const all=await list();
const target=(all.data.artifacts||[]).filter(a=>names.includes(a.name));
for(const name of names){const matches=target.filter(a=>a.name===name),observed=[];for(const a of matches)observed.push(await inspect(String(a.id)));console.log(JSON.stringify({mode,event:'inspect',name,items:matches.map(a=>({id:a.id,size:a.size_in_bytes})),observed}));}
