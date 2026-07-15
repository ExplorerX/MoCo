import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTraining,
  createMistakePracticeDefinition,
  createTrainingSession,
  generateQuestions,
  markPromptComplete,
  pauseTraining,
  recordReplay,
  resumeTraining,
  startTraining,
  submitTrainingAnswer,
} from "@learning-morse/training-engine";
import { DATA_SCHEMA_VERSION, type PracticeDefinition } from "@learning-morse/shared-types";

const definition: PracticeDefinition = {
  schemaVersion: DATA_SCHEMA_VERSION,
  mode: "sound-to-character",
  characters: ["K", "M", "R", "S"],
  questionCount: 12,
  seed: "stage-b-fixed-seed",
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

test("generates deterministic questions without four identical targets in a row", () => {
  const first = generateQuestions(definition, "session-fixed");
  const second = generateQuestions(definition, "session-fixed");
  assert.deepEqual(first, second);
  assert.equal(first.length, 12);
  assert.ok(first.every((question) => question.choices.length === 4 && question.choices.includes(question.target)));
  for (let index = 3; index < first.length; index += 1) {
    assert.notDeepEqual(first.slice(index - 3, index + 1).map((question) => question.target), [
      first[index].target,
      first[index].target,
      first[index].target,
      first[index].target,
    ]);
  }
});

test("runs a complete session through prompt, answer, feedback and summary", () => {
  const shortDefinition = { ...definition, questionCount: 2 };
  let state = createTrainingSession(shortDefinition, {
    sessionId: "session-flow",
    now: "2026-07-15T10:00:00.000Z",
  });
  state = startTraining(state, "2026-07-15T10:00:00.100Z");
  state = markPromptComplete(state, "2026-07-15T10:00:01.000Z");
  state = recordReplay(state, "2026-07-15T10:00:01.200Z");

  const firstTarget = state.snapshot.questions[0].target;
  const firstResult = submitTrainingAnswer(state, firstTarget, "2026-07-15T10:00:02.500Z");
  assert.equal(firstResult.attempt.correct, true);
  assert.equal(firstResult.attempt.reactionMs, 1500);
  assert.equal(firstResult.attempt.replayCount, 1);
  state = advanceTraining(firstResult.state, "2026-07-15T10:00:03.000Z");
  state = markPromptComplete(state, "2026-07-15T10:00:04.000Z");

  const secondResult = submitTrainingAnswer(state, "?", "2026-07-15T10:00:06.000Z");
  state = advanceTraining(secondResult.state, "2026-07-15T10:00:06.500Z");
  assert.equal(state.snapshot.status, "completed");
  assert.deepEqual(state.snapshot.summary, {
    total: 2,
    correct: 1,
    accuracy: 0.5,
    averageReactionMs: 1750,
    completedAt: "2026-07-15T10:00:06.500Z",
  });
});

test("pauses and resumes by returning to the prompt safely", () => {
  let state = createTrainingSession(definition, {
    sessionId: "session-pause",
    now: "2026-07-15T11:00:00.000Z",
  });
  state = startTraining(state, "2026-07-15T11:00:00.100Z");
  state = markPromptComplete(state, "2026-07-15T11:00:01.000Z");
  state = pauseTraining(state, "2026-07-15T11:00:02.000Z");
  assert.equal(state.snapshot.status, "paused");
  assert.equal(state.snapshot.resumeStatus, "answering");
  state = resumeTraining(state, "2026-07-15T11:01:00.000Z");
  assert.equal(state.snapshot.status, "prompting");
  assert.equal(state.snapshot.questionStartedAt, null);
});

test("builds a deterministic mistake-only practice definition", () => {
  const shortDefinition = { ...definition, questionCount: 1 };
  let state = createTrainingSession(shortDefinition, {
    sessionId: "session-mistake",
    now: "2026-07-15T12:00:00.000Z",
  });
  state = startTraining(state, "2026-07-15T12:00:00.100Z");
  state = markPromptComplete(state, "2026-07-15T12:00:01.000Z");
  const target = state.snapshot.questions[0].target;
  state = submitTrainingAnswer(state, "?", "2026-07-15T12:00:02.000Z").state;
  const retry = createMistakePracticeDefinition(state, "mistake-seed");
  assert.deepEqual(retry.characters, [target]);
  assert.equal(retry.questionCount, 3);
  assert.equal(retry.seed, "mistake-seed");
});
