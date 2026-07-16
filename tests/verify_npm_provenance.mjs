import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function verifyPublishedPackage(config, fetchImpl = fetch) {
  const { pkg, version, repository, ref, workflow, commit, integrity } = config;
  assert.ok(pkg && version && repository && ref && workflow && commit && integrity);

  const metadataResponse = await fetchImpl(`https://registry.npmjs.org/${pkg}/${version}`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.name, pkg);
  assert.equal(metadata.version, version);
  assert.equal(metadata.repository.url, `git+${repository}.git`);
  assert.equal(metadata.dist.integrity, integrity);
  assert.ok(metadata.dist.attestations?.url);

  const attestationResponse = await fetchImpl(metadata.dist.attestations.url);
  assert.equal(attestationResponse.status, 200);
  const attestationDocument = await attestationResponse.json();
  const slsa = attestationDocument.attestations.find(
    (item) => item.predicateType === 'https://slsa.dev/provenance/v1',
  );
  assert.ok(slsa, 'missing SLSA provenance attestation');
  const statement = JSON.parse(
    Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'),
  );
  assert.equal(statement.subject[0].name, `pkg:npm/${pkg}@${version}`);
  const [algorithm, encodedDigest] = integrity.split('-', 2);
  assert.equal(algorithm, 'sha512');
  assert.equal(
    statement.subject[0].digest.sha512,
    Buffer.from(encodedDigest, 'base64').toString('hex'),
  );
  const source = statement.predicate.buildDefinition.externalParameters.workflow;
  assert.equal(source.repository, repository);
  assert.equal(source.ref, ref);
  assert.equal(source.path, workflow);
  const resolved = statement.predicate.buildDefinition.resolvedDependencies.find(
    (item) => item.digest?.gitCommit === commit,
  );
  assert.ok(resolved, 'provenance does not resolve to the expected commit');
  assert.equal(resolved.uri, `git+${repository}@${ref}`);
  assert.equal(
    statement.predicate.runDetails.builder.id,
    'https://github.com/actions/runner/github-hosted',
  );
  return statement;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pkg, version, repository, ref, workflow, commit, integrity] =
    process.argv.slice(2);
  await verifyPublishedPackage({
    pkg,
    version,
    repository,
    ref,
    workflow,
    commit,
    integrity,
  });
  console.log(`verified npm provenance for ${pkg}@${version}`);
}
