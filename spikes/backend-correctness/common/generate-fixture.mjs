import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CONTRACT_VERSION = '1B.0-v1';
export const DOMAIN_SPEC_VERSION = '1A-v0.2';
export const FIXED_SEED = 20260722;
export const CLOCK_ORIGIN = '2026-07-22T00:00:00.000Z';

function id(prefix, index) {
  return `${prefix}_${String(index).padStart(6, '0')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function checksum(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function candidateFingerprint({ patchScope, gameMode, subjectGameEntity, normalizedSignature }) {
  return checksum({ patchScope, gameMode, subjectGameEntity, normalizedSignature });
}

export function deriveEligibility(candidate) {
  if (!candidate.catalogValid) return 'ineligible';
  if (candidate.moderationDecision == null) return 'needs_review';
  if (candidate.moderationDecision === 'blocked') return 'ineligible';
  if (candidate.moderationDecision === 'flagged') return 'needs_review';
  if (candidate.requiredClaimDecisions.includes('contradicted')) return 'ineligible';
  if (candidate.requiredClaimDecisions.some((state) => state !== 'supported')) return 'needs_review';
  if (candidate.origin === 'ai_generated' && !candidate.aiReviewConfirmed) return 'needs_review';
  return 'eligible';
}

export function generateFixture() {
  const sources = Array.from({ length: 5 }, (_, i) => ({ id: id('src', i + 1) }));
  const sourcePolicyRevisions = Array.from({ length: 10 }, (_, i) => ({
    id: id('policy', i + 1), sourceId: sources[i % sources.length].id, revision: Math.floor(i / 5) + 1,
  }));
  const patches = Array.from({ length: 3 }, (_, i) => ({ id: id('patch', i + 1), label: `P${i + 1}` }));
  const catalogRevisions = patches.map((patch, i) => ({ id: id('catalog', i + 1), patchId: patch.id }));
  const gameEntityRevisions = Array.from({ length: 250 }, (_, i) => ({
    id: id('entity', i + 1), catalogRevisionId: catalogRevisions[i % 3].id,
  }));
  const compatibilityRules = Array.from({ length: 100 }, (_, i) => ({
    id: id('rule', i + 1), catalogRevisionId: catalogRevisions[i % 3].id,
  }));
  const rawObservations = Array.from({ length: 5000 }, (_, i) => ({
    id: id('raw', i + 1), sourcePolicyRevisionId: sourcePolicyRevisions[i % 10].id,
    contentHash: checksum({ n: i + 1, seed: FIXED_SEED }),
  }));
  const normalizedObservations = rawObservations.map((raw, i) => ({
    id: id('norm', i + 1), rawObservationId: raw.id, patchId: patches[i % 3].id,
    catalogRevisionId: catalogRevisions[i % 3].id,
  }));

  const moderation = [
    ...Array(20).fill(null),
    ...Array(140).fill('clear'),
    ...Array(25).fill('flagged'),
    ...Array(15).fill('blocked'),
  ];
  const origins = [
    ...Array(120).fill('collector_detected'),
    ...Array(40).fill('community_submitted'),
    ...Array(20).fill('editorial'),
    ...Array(20).fill('ai_generated'),
  ];

  const candidates = Array.from({ length: 200 }, (_, i) => {
    const origin = origins[i];
    const patchId = patches[i % 3].id;
    const subject = gameEntityRevisions[i % gameEntityRevisions.length].id;
    const requiredClaimDecisions = i < 100 ? ['supported'] : i < 170 ? ['insufficient'] : ['contradicted'];
    const aiReviewConfirmed = origin !== 'ai_generated' || i >= 195;
    const candidate = {
      id: id('candidate', i + 1), origin, patchId, gameMode: i % 2 ? 'ranked' : 'normal', subject,
      normalizedSignature: `sig-${i % 50}`, moderationDecision: moderation[i], catalogValid: i % 37 !== 0,
      requiredClaimDecisions, aiReviewConfirmed,
    };
    return { ...candidate, fingerprint: candidateFingerprint({
      patchScope: patchId, gameMode: candidate.gameMode, subjectGameEntity: subject,
      normalizedSignature: candidate.normalizedSignature,
    }), eligibility: deriveEligibility(candidate) };
  });

  const claims = candidates.flatMap((candidate, i) => [
    { id: id('claim', i * 2 + 1), candidateId: candidate.id, importance: 'required', decision: candidate.requiredClaimDecisions[0] },
    { id: id('claim', i * 2 + 2), candidateId: candidate.id, importance: 'supporting', decision: i % 11 === 0 ? 'contradicted' : 'supported' },
  ]);
  const evidenceAssociations = Array.from({ length: 1000 }, (_, i) => ({
    id: id('assoc', i + 1), claimId: claims[i % claims.length].id, evidenceId: id('evidence', (i % 500) + 1),
    stance: i % 9 === 0 ? 'contradicts' : 'supports', patchId: patches[i % 3].id,
  }));
  const publications = Array.from({ length: 10 }, (_, i) => ({ id: id('publication', i + 1), candidateId: candidates[i].id }));
  const publicationVersions = publications.flatMap((publication, i) => [1, 2].map((version) => ({
    id: id('pubver', i * 2 + version), publicationId: publication.id, version,
    contentHash: checksum({ publicationId: publication.id, version }),
  })));
  const activePublicationPointers = publications.map((publication, i) => ({
    publicationId: publication.id, publicationVersionId: publicationVersions[i * 2 + 1].id,
  }));

  const fixture = {
    contractVersion: CONTRACT_VERSION, domainSpecVersion: DOMAIN_SPEC_VERSION, seed: FIXED_SEED,
    clockOrigin: CLOCK_ORIGIN, sources, sourcePolicyRevisions, patches, catalogRevisions,
    gameEntityRevisions, compatibilityRules, rawObservations, normalizedObservations,
    candidates, claims, evidenceAssociations, publications, publicationVersions, activePublicationPointers,
  };
  const counts = Object.fromEntries(Object.entries(fixture).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
  return { fixture, counts, checksum: checksum(fixture) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const generated = generateFixture();
  const outputDir = path.resolve('spikes/backend-correctness/common/generated');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'fixture-manifest.json'), JSON.stringify(generated.fixture, null, 2));
  await writeFile(path.join(outputDir, 'expected-counts.json'), JSON.stringify(generated.counts, null, 2));
  await writeFile(path.join(outputDir, 'expected-checksums.json'), JSON.stringify({ fixture: generated.checksum }, null, 2));
  console.log(JSON.stringify({ ...generated.counts, fixtureChecksum: generated.checksum }, null, 2));
}
