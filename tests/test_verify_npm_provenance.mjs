import assert from 'node:assert/strict';
import test from 'node:test';

const expected = {
  pkg: 'superpowers-manager',
  version: '0.1.2',
  repository: 'https://github.com/j7an/superpowers-manager',
  ref: 'refs/tags/v0.1.2',
  workflow: '.github/workflows/release.yml',
  commit: 'a'.repeat(40),
  integrity: `sha512-${Buffer.from('b'.repeat(128), 'hex').toString('base64')}`,
};

function createValidFixture() {
  const statement = {
    subject: [
      {
        name: 'pkg:npm/superpowers-manager@0.1.2',
        digest: { sha512: 'b'.repeat(128) },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: expected.repository,
            ref: expected.ref,
            path: expected.workflow,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${expected.repository}@${expected.ref}`,
            digest: { gitCommit: expected.commit },
          },
        ],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
      },
    },
  };
  const attestationUrl = 'https://registry.npmjs.org/-/npm/v1/attestations/superpowers-manager@0.1.2';
  return {
    metadataStatus: 200,
    attestationStatus: 200,
    metadata: {
      name: expected.pkg,
      version: expected.version,
      repository: { url: `git+${expected.repository}.git` },
      dist: {
        integrity: expected.integrity,
        attestations: { url: attestationUrl },
      },
    },
    attestationDocument: {
      attestations: [
        {
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
            },
          },
        },
      ],
    },
    statement,
    attestationUrl,
  };
}

const baseFixture = createValidFixture();

function validFixture() {
  return structuredClone(baseFixture);
}

function fakeFetch(fixture) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === `https://registry.npmjs.org/${expected.pkg}/${expected.version}`) {
      return {
        status: fixture.metadataStatus,
        json: async () => fixture.metadata,
      };
    }
    if (url === fixture.attestationUrl) {
      return {
        status: fixture.attestationStatus,
        json: async () => fixture.attestationDocument,
      };
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  };
  return { calls, fetchImpl };
}

async function loadVerifier() {
  try {
    return await import('./verify_npm_provenance.mjs');
  } catch (error) {
    assert.fail(`provenance verifier is not implemented: ${error.message}`);
  }
}

async function verifyFixture(fixture) {
  const { verifyPublishedPackage } = await loadVerifier();
  const { fetchImpl } = fakeFetch(fixture);
  return verifyPublishedPackage(expected, fetchImpl);
}

test('accepts exact npm metadata and SLSA provenance', async () => {
  const fixture = validFixture();
  const { verifyPublishedPackage } = await loadVerifier();
  const { calls, fetchImpl } = fakeFetch(fixture);
  const statement = await verifyPublishedPackage({
    pkg: 'superpowers-manager',
    version: '0.1.2',
    repository: 'https://github.com/j7an/superpowers-manager',
    ref: 'refs/tags/v0.1.2',
    workflow: '.github/workflows/release.yml',
    commit: 'a'.repeat(40),
    integrity: `sha512-${Buffer.from('b'.repeat(128), 'hex').toString('base64')}`,
  }, fetchImpl);

  assert.deepEqual(statement, fixture.statement);
  assert.deepEqual(calls, [
    `https://registry.npmjs.org/${expected.pkg}/${expected.version}`,
    fixture.attestationUrl,
  ]);
});

test('rejects malformed metadata response', async () => {
  const fixture = validFixture();
  delete fixture.metadata.dist.attestations;
  await assert.rejects(verifyFixture(fixture));
});

test('rejects wrong registry integrity', async () => {
  const fixture = validFixture();
  fixture.metadata.dist.integrity = `sha512-${Buffer.from('c'.repeat(128), 'hex').toString('base64')}`;
  await assert.rejects(verifyFixture(fixture));
});

test('rejects the old repository identity', async () => {
  const fixture = validFixture();
  fixture.metadata.repository.url = 'git+https://github.com/j7an/superpowers-wrapper.git';
  await assert.rejects(verifyFixture(fixture));
});

test('rejects a provenance ref other than the frozen tag', async () => {
  const fixture = validFixture();
  fixture.statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main';
  fixture.attestationDocument.attestations[0].bundle.dsseEnvelope.payload =
    Buffer.from(JSON.stringify(fixture.statement)).toString('base64');
  await assert.rejects(verifyFixture(fixture));
});

test('rejects a different workflow path', async () => {
  const fixture = validFixture();
  fixture.statement.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/publish.yml';
  fixture.attestationDocument.attestations[0].bundle.dsseEnvelope.payload =
    Buffer.from(JSON.stringify(fixture.statement)).toString('base64');
  await assert.rejects(verifyFixture(fixture));
});

test('rejects provenance that resolves to a different commit', async () => {
  const fixture = validFixture();
  fixture.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'c'.repeat(40);
  fixture.attestationDocument.attestations[0].bundle.dsseEnvelope.payload =
    Buffer.from(JSON.stringify(fixture.statement)).toString('base64');
  await assert.rejects(verifyFixture(fixture), /expected commit/);
});

test('rejects a different package subject', async () => {
  const fixture = validFixture();
  fixture.statement.subject[0].name = 'pkg:npm/superpowers-wrapper@0.1.1';
  fixture.attestationDocument.attestations[0].bundle.dsseEnvelope.payload =
    Buffer.from(JSON.stringify(fixture.statement)).toString('base64');
  await assert.rejects(verifyFixture(fixture));
});

test('rejects an attestation document without SLSA provenance', async () => {
  const fixture = validFixture();
  fixture.attestationDocument.attestations = [];
  await assert.rejects(verifyFixture(fixture), /missing SLSA provenance attestation/);
});
