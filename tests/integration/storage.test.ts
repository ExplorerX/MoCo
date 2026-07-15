import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTrainingSession,
  markPromptComplete,
  startTraining,
  submitTrainingAnswer,
} from "@learning-morse/training-engine";
import { DATA_SCHEMA_VERSION, type PracticeDefinition } from "@learning-morse/shared-types";
import { DATABASE_VERSION, createSessionRepository } from "@learning-morse/storage";

const definition: PracticeDefinition = {
  schemaVersion: DATA_SCHEMA_VERSION,
  mode: "sound-to-character",
  characters: ["K", "M", "R", "S"],
  questionCount: 2,
  seed: "storage-seed",
  timing: {
    characterWpm: 20,
    effectiveWpm: 10,
    frequencyHz: 600,
    waveform: "sine",
    volume: 0.6,
  },
  timeoutMs: null,
  feedbackMode: "immediate",
};

test("creates the versioned IndexedDB schema and metadata", async () => {
  const repository = createSessionRepository(`morse-schema-${crypto.randomUUID()}`);
  await repository.initialize("2026-07-15T10:00:00.000Z");
  const tableNames = repository.database.tables.map((table) => table.name).sort();
  assert.deepEqual(tableNames, [
    "appMeta",
    "attempts",
    "characterStats",
    "courseProgress",
    "flags",
    "sessions",
    "settings",
  ]);
  const schema = await repository.database.appMeta.get("schema");
  assert.deepEqual(schema?.value, { databaseVersion: DATABASE_VERSION, dataSchemaVersion: DATA_SCHEMA_VERSION });
  repository.close();
  await repository.database.delete();
});

test("atomically saves the first attempt, session progress and character stats", async () => {
  const repository = createSessionRepository(`morse-atomic-${crypto.randomUUID()}`);
  await repository.initialize();
  let state = createTrainingSession(definition, {
    sessionId: "persisted-session",
    now: "2026-07-15T11:00:00.000Z",
  });
  state = startTraining(state, "2026-07-15T11:00:00.100Z");
  state = markPromptComplete(state, "2026-07-15T11:00:01.000Z");
  await repository.createSession(state.snapshot);
  const target = state.snapshot.questions[0].target;
  const result = submitTrainingAnswer(state, target, "2026-07-15T11:00:02.250Z");
  await repository.saveAttemptAndSession(result.attempt, result.state.snapshot);

  const stored = await repository.loadSession("persisted-session");
  assert.equal(stored?.snapshot.status, "feedback");
  assert.equal(stored?.attempts.length, 1);
  assert.equal(stored?.attempts[0].reactionMs, 1250);
  assert.deepEqual(await repository.getCharacterStats(), [{
    id: `${target}|sound-to-character`,
    character: target,
    mode: "sound-to-character",
    attempts: 1,
    correct: 1,
    totalReactionMs: 1250,
    lastPracticedAt: "2026-07-15T11:00:02.250Z",
  }]);
  repository.close();
  await repository.database.delete();
});

test("recovers the most recently updated incomplete session", async () => {
  const repository = createSessionRepository(`morse-recovery-${crypto.randomUUID()}`);
  await repository.initialize();
  const older = startTraining(createTrainingSession(definition, {
    sessionId: "older-session",
    now: "2026-07-15T12:00:00.000Z",
  }), "2026-07-15T12:00:00.100Z");
  const newer = startTraining(createTrainingSession(definition, {
    sessionId: "newer-session",
    now: "2026-07-15T12:01:00.000Z",
  }), "2026-07-15T12:01:00.100Z");
  await repository.createSession(older.snapshot);
  await repository.createSession(newer.snapshot);
  const recovered = await repository.getLatestRecoverableSession();
  assert.equal(recovered?.snapshot.id, "newer-session");
  const recent = await repository.getRecentSessions(1);
  assert.deepEqual(recent.map((session) => session.id), ["newer-session"]);
  repository.close();
  await repository.database.delete();
});
