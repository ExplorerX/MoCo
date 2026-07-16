import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTraining,
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

test("persists preferences and round-trips a versioned local export", async () => {
  const source = createSessionRepository(`morse-export-source-${crypto.randomUUID()}`);
  await source.initialize();
  await source.saveSetting("preferences", { waveform: "square", questionCount: 12 });
  assert.deepEqual(await source.getSetting("preferences"), { waveform: "square", questionCount: 12 });
  const payload = await source.exportData();
  assert.equal(payload.schemaVersion, DATA_SCHEMA_VERSION);
  assert.equal(payload.tables.settings.length, 1);

  const target = createSessionRepository(`morse-export-target-${crypto.randomUUID()}`);
  await target.initialize();
  await target.importData(payload);
  assert.deepEqual(await target.getSetting("preferences"), { waveform: "square", questionCount: 12 });
  await target.clearAll();
  assert.equal(await target.getSetting("preferences"), null);

  source.close();
  target.close();
  await source.database.delete();
  await target.database.delete();
});

test("rejects incomplete imports without clearing existing data", async () => {
  const repository = createSessionRepository(`morse-invalid-import-${crypto.randomUUID()}`);
  await repository.initialize();
  await repository.saveSetting("preferences", { waveform: "square" });
  await assert.rejects(
    repository.importData({
      schemaVersion: DATA_SCHEMA_VERSION,
      exportedAt: "2026-07-16T00:00:00.000Z",
      tables: {},
    } as never),
    /table is missing/,
  );
  assert.deepEqual(await repository.getSetting("preferences"), { waveform: "square" });
  repository.close();
  await repository.database.delete();
});

test("finds the latest completed session that actually contains mistakes", async () => {
  const repository = createSessionRepository(`morse-mistakes-${crypto.randomUUID()}`);
  await repository.initialize();
  const oneQuestion = { ...definition, questionCount: 1 };

  const complete = async (id: string, startedAt: string, response: "correct" | "wrong") => {
    let state = createTrainingSession(oneQuestion, { sessionId: id, now: startedAt });
    state = startTraining(state, new Date(Date.parse(startedAt) + 100).toISOString());
    state = markPromptComplete(state, new Date(Date.parse(startedAt) + 200).toISOString());
    await repository.createSession(state.snapshot);
    const answer = response === "correct" ? state.snapshot.questions[0].target : "?";
    const submitted = submitTrainingAnswer(state, answer, new Date(Date.parse(startedAt) + 300).toISOString());
    await repository.saveAttemptAndSession(submitted.attempt, submitted.state.snapshot);
    state = advanceTraining(submitted.state, new Date(Date.parse(startedAt) + 400).toISOString());
    await repository.saveSession(state.snapshot);
  };

  await complete("older-with-mistake", "2026-07-15T13:00:00.000Z", "wrong");
  await complete("newer-perfect", "2026-07-15T13:01:00.000Z", "correct");
  assert.equal((await repository.getLatestCompletedSession())?.snapshot.id, "newer-perfect");
  assert.equal((await repository.getLatestCompletedSession(true))?.snapshot.id, "older-with-mistake");
  repository.close();
  await repository.database.delete();
});
