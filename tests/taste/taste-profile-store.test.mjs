import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveTastePaths,
  appendTasteEvent,
  appendTasteEventForProfile,
  appendTasteEventIdempotentForProfile,
  readTasteEvents,
  readTasteEventsForProfile,
  readTasteIndex,
  readTasteIndexForProfile,
  readTasteManifest,
  readTasteManifestForProfile,
  readTasteObjections,
  readTasteObjectionsForProfile,
  readTasteProfile,
  readTasteProfileForProfile,
  readTasteProfileIdMap,
  resolveTastePathsForProfile,
  writeTasteEvents,
  writeTasteEventsForProfile,
  writeTasteIndexForProfile,
  writeTasteObjectionsForProfile,
  writeTasteProfileForProfile,
} from "../../src/server/taste-store.ts";
import { useIsolatedDataDir } from "../helpers/test-data.mjs";

// Aşama 1: gerçek `data/` dizinine yazmayı engelle (B-14).
useIsolatedDataDir("ct-taste-store-");

const AS_OF = "2026-11-02T00:00:00.000Z";

function makeEvent(eventId, contentId = "movie:550") {
  return {
    eventId,
    contentId,
    eventType: "rating_changed",
    payload: { previousValue: null, newValue: 8 },
    recordedAt: AS_OF,
    timeSource: "actual",
    timePrecision: "exact",
  };
}

function makeProfile(name) {
  return {
    mediaType: "movie",
    algorithmVersion: "v1.0",
    taxonomyVersion: "v0.1",
    asOf: AS_OF,
    profileName: name,
    metrics: {
      "genre.drama": {
        metricId: "genre.drama",
        affinity: 30,
        longTermAffinity: 30,
        recentAffinity: 30,
        status: "directional",
        evidence: {
          posMass: 2.0,
          negMass: 0,
          uncertainMass: 0,
          topPositiveContentIds: ["movie:1"],
          topNegativeContentIds: [],
        },
      },
    },
  };
}

function makeIndex(revision) {
  return {
    schemaVersion: "1.0.0",
    revision,
    updatedAt: AS_OF,
    extractorVersion: "v1.0",
    taxonomyVersion: "v0.1",
    mappingVersion: "tmdb-2026-11",
    items: {},
  };
}

function makeObjection(contentId, metricId) {
  return {
    contentId,
    metricId,
    reason: "not-present",
    createdAt: AS_OF,
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ct-r2a2-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("profil kapsamlı event okuma/yazma yolları izole çalışır", async () => {
  await withTempDir(async (dataDir) => {
    await appendTasteEventForProfile("profile-AAA", makeEvent("evt-a1", "movie:1"), dataDir);
    await appendTasteEventIdempotentForProfile("profile-AAA", makeEvent("evt-a1", "movie:1"), dataDir);
    await appendTasteEventForProfile("profile-AAA", makeEvent("evt-a2", "movie:2"), dataDir);
    await appendTasteEventForProfile("profile-AAG", makeEvent("evt-b1", "movie:9"), dataDir);

    const a = await readTasteEventsForProfile("profile-AAA", dataDir);
    const b = await readTasteEventsForProfile("profile-AAG", dataDir);
    assert.deepEqual(a.map((e) => e.eventId), ["evt-a1", "evt-a2"]);
    assert.deepEqual(b.map((e) => e.eventId), ["evt-b1"]);

    await writeTasteEventsForProfile("profile-AAG", [makeEvent("evt-b2", "movie:8")], dataDir);
    assert.deepEqual((await readTasteEventsForProfile("profile-AAG", dataDir)).map((e) => e.eventId), ["evt-b2"]);
    assert.deepEqual((await readTasteEventsForProfile("profile-AAA", dataDir)).map((e) => e.eventId), ["evt-a1", "evt-a2"]);

    const scopedA = resolveTastePathsForProfile("profile-AAA", dataDir);
    const scopedB = resolveTastePathsForProfile("profile-AAG", dataDir);
    assert.notEqual(scopedA.dir, scopedB.dir);
    assert.ok(existsSync(scopedA.paths.events));
    assert.ok(existsSync(scopedB.paths.events));
  });
});

test("profil kapsamlı profile/index/manifest yolları izole ve manifest günceller", async () => {
  await withTempDir(async (dataDir) => {
    await writeTasteProfileForProfile("profile-AAA", makeProfile("A"), dataDir, "wm-a");
    await writeTasteProfileForProfile("profile-AAG", makeProfile("B"), dataDir, "wm-b");

    const pa = await readTasteProfileForProfile("profile-AAA", dataDir);
    const pb = await readTasteProfileForProfile("profile-AAG", dataDir);
    assert.equal(pa?.profileName, "A");
    assert.equal(pb?.profileName, "B");

    await writeTasteIndexForProfile("profile-AAA", makeIndex(11), dataDir);
    await writeTasteIndexForProfile("profile-AAG", makeIndex(22), dataDir);
    assert.equal((await readTasteIndexForProfile("profile-AAA", dataDir))?.revision, 11);
    assert.equal((await readTasteIndexForProfile("profile-AAG", dataDir))?.revision, 22);

    const ma = await readTasteManifestForProfile("profile-AAA", dataDir);
    const mb = await readTasteManifestForProfile("profile-AAG", dataDir);
    assert.ok(ma?.generationId);
    assert.ok(mb?.generationId);
    assert.notEqual(ma?.generationId, mb?.generationId);
    assert.equal(ma?.eventWatermark, "wm-a");
    assert.equal(mb?.eventWatermark, "wm-b");
    assert.ok(ma?.files.events.includes(scopedPath(dataDir, "profile-AAA").dir));
    assert.ok(mb?.files.events.includes(scopedPath(dataDir, "profile-AAG").dir));
  });
});

test("profil kapsamlı objections izole yazılır/okunur", async () => {
  await withTempDir(async (dataDir) => {
    await writeTasteObjectionsForProfile("profile-AAA", [makeObjection("movie:1", "genre.drama")], dataDir);
    await writeTasteObjectionsForProfile("profile-AAG", [makeObjection("movie:2", "genre.comedy")], dataDir);

    assert.deepEqual(
      (await readTasteObjectionsForProfile("profile-AAA", dataDir)).map((o) => o.contentId),
      ["movie:1"]
    );
    assert.deepEqual(
      (await readTasteObjectionsForProfile("profile-AAG", dataDir)).map((o) => o.contentId),
      ["movie:2"]
    );
  });
});

test("profil kapsamlı yazımlar legacy/global kökü değiştirmez ve migration yapmaz", async () => {
  await withTempDir(async (dataDir) => {
    await writeTasteProfileForProfile("profile-AAA", makeProfile("A"), dataDir);
    await appendTasteEventForProfile("profile-AAA", makeEvent("evt-a1"), dataDir);
    await writeTasteIndexForProfile("profile-AAA", makeIndex(1), dataDir);
    await writeTasteObjectionsForProfile("profile-AAA", [makeObjection("movie:1", "genre.drama")], dataDir);

    const legacyRoot = path.join(dataDir, "taste");
    const legacyFiles = [
      "cinetrack-taste-events.json",
      "cinetrack-taste-profile.json",
      "cinetrack-taste-index.json",
      "cinetrack-taste-manifest.json",
      "cinetrack-taste-objections.json",
    ];
    for (const name of legacyFiles) {
      assert.equal(existsSync(path.join(legacyRoot, name)), false, `legacy dosya oluşmamalı: ${name}`);
    }
    assert.equal(existsSync(path.join(legacyRoot, ".taste.lock")), false, "legacy lock profilden etkilenmemeli");
  });
});

test("profil eşleme manifesti profil kapsamlı ilk yazımda kayıt oluşturur", async () => {
  await withTempDir(async (dataDir) => {
    await appendTasteEventForProfile("profile-AAA", makeEvent("evt-a1"), dataDir);
    const mapResult = await readTasteProfileIdMap(dataDir);
    assert.equal(mapResult.status, "ok");
    assert.ok(mapResult.data.entries["PROFILE-AAA"]);
    assert.equal(
      mapResult.data.entries["PROFILE-AAA"].dir,
      resolveTastePathsForProfile("profile-AAA", dataDir).dir
    );
  });
});

test("profil kapsamlı okuma bilinmeyen profilde boş/missing döner", async () => {
  await withTempDir(async (dataDir) => {
    assert.deepEqual(await readTasteEventsForProfile("profile-AAA", dataDir), []);
    assert.equal(await readTasteProfileForProfile("profile-AAA", dataDir), null);
    assert.equal(await readTasteIndexForProfile("profile-AAA", dataDir), null);
    assert.equal(await readTasteManifestForProfile("profile-AAA", dataDir), null);
    assert.deepEqual(await readTasteObjectionsForProfile("profile-AAA", dataDir), []);
  });
});

test("legacy global API davranışı korunur (varsayılan imzalar)", async () => {
  const markerEventId = `r2a2-legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = makeEvent(markerEventId, "movie:4242");
  const before = await readTasteEvents();
  try {
    await appendTasteEvent(marker);
    const after = await readTasteEvents();
    assert.ok(after.some((e) => e.eventId === markerEventId));
    assert.ok(typeof resolveTastePaths().events === "string" && resolveTastePaths().events.endsWith("cinetrack-taste-events.json"));

    const profile = await readTasteProfile();
    const index = await readTasteIndex();
    const manifest = await readTasteManifest();
    const objections = await readTasteObjections();
    assert.ok(profile === null || typeof profile === "object");
    assert.ok(index === null || typeof index === "object");
    assert.ok(manifest === null || typeof manifest === "object");
    assert.ok(Array.isArray(objections));
  } finally {
    // Legacy global dosyaları bu test çalıştığından temizle (yalnızca eklediğimiz kaydı çıkar).
    await writeTasteEvents(before);
  }
});

test("aynı profil kapsamlı paralel event eklemeleri kayıp üretmez", async () => {
  await withTempDir(async (dataDir) => {
    const total = 40;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        appendTasteEventForProfile("profile-AAA", makeEvent(`evt-par-${i}`, `movie:${i}`), dataDir)
      )
    );
    const events = await readTasteEventsForProfile("profile-AAA", dataDir);
    assert.equal(events.length, total);
    assert.equal(new Set(events.map((e) => e.eventId)).size, total);
  });
});

function scopedPath(dataDir, profileId) {
  return resolveTastePathsForProfile(profileId, dataDir);
}
