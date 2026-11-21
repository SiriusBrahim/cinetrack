/** Aşama 0 — B-03 puanlama maliyeti ölçümü (salt okunur). */
import { computeLovedSimilarityScore } from '../../../src/core/loved-similarity.ts';

const mkLoved = (i) => ({
  key: `movie:${i}`,
  title: `Loved ${i}`,
  genre_ids: [(i % 8) + 1, ((i + 3) % 8) + 1],
  overviewTokens: new Set([`token${i % 40}`, `word${i % 17}`, "drama", "story"]),
  castIds: [i % 50, (i + 7) % 50, (i + 13) % 50],
  directorIds: [i % 12],
  collectionId: i % 6,
  year: 1980 + (i % 40),
  weight: 0.5 + ((i % 5) / 10),
});

const mkCandidate = (i) => ({
  id: 100000 + i,
  media_type: 'movie',
  title: `Cand ${i}`,
  genre_ids: [(i % 8) + 1],
  overview: `candidate overview token${i % 40} story ${i}`,
  cast: [{ id: i % 50 }, { id: (i + 7) % 50 }],
  crew: [{ id: i % 12, job: 'Director' }],
  release_date: `${1980 + (i % 40)}-05-01`,
});

for (const n of [200, 1000, 2000]) {
  const loved = Array.from({ length: n }, (_, i) => mkLoved(i));
  const candidates = Array.from({ length: n }, (_, i) => mkCandidate(i));
  const t0 = performance.now();
  let sink = 0;
  for (const c of candidates) sink += computeLovedSimilarityScore(c, loved).score;
  const ms = performance.now() - t0;
  console.log(
    JSON.stringify({ scenario: `${n}x${n}`, ms: Math.round(ms), perCandidateUs: Math.round((ms * 1000) / n), sink: Math.round(sink) })
  );
}
