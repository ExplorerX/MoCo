import { MORSE, createMorseTiming, type MorseCharacter } from "@learning-morse/morse-core";
import {
  DATA_SCHEMA_VERSION,
  type Attempt,
  type PracticeDefinition,
  type SessionSnapshot,
  type SessionStatus,
  type TrainingQuestion,
} from "@learning-morse/shared-types";

export type TrainingState = {
  snapshot: SessionSnapshot;
  attempts: Attempt[];
};

export type CreateTrainingOptions = {
  sessionId: string;
  now: string;
};

function assertIsoTimestamp(value: string, label: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`${label} must be a valid ISO timestamp`);
  }
}

function normalizeCharacters(characters: string[]): MorseCharacter[] {
  const normalized = characters.map((character) => character.trim().toUpperCase());
  if (normalized.length === 0) throw new RangeError("At least one practice character is required");
  if (normalized.some((character) => !(character in MORSE))) {
    throw new RangeError("Practice characters must exist in the Morse character set");
  }
  return [...new Set(normalized)] as MorseCharacter[];
}

export function validatePracticeDefinition(definition: PracticeDefinition): void {
  if (definition.schemaVersion !== DATA_SCHEMA_VERSION) {
    throw new RangeError(`Unsupported practice definition schema: ${definition.schemaVersion}`);
  }
  normalizeCharacters(definition.characters);
  if (!Number.isInteger(definition.questionCount) || definition.questionCount < 1 || definition.questionCount > 1000) {
    throw new RangeError("Question count must be an integer between 1 and 1000");
  }
  if (!definition.seed.trim()) throw new RangeError("A deterministic seed is required");
  if (definition.guidedLessonId !== undefined && !definition.guidedLessonId.trim()) {
    throw new RangeError("Guided lesson id must not be empty");
  }
  if (definition.timeoutMs !== null && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)) {
    throw new RangeError("Timeout must be null or greater than zero");
  }
  if (!Number.isFinite(definition.timing.frequencyHz) || definition.timing.frequencyHz <= 0) {
    throw new RangeError("Audio frequency must be greater than zero");
  }
  if (!Number.isFinite(definition.timing.volume) || definition.timing.volume < 0 || definition.timing.volume > 1) {
    throw new RangeError("Volume must stay between zero and one");
  }
  createMorseTiming(definition.timing.characterWpm, definition.timing.effectiveWpm);
}

function createSeededRandom(seed: string): () => number {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  value >>>= 0;

  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function generateQuestions(
  definition: PracticeDefinition,
  sessionId: string,
): TrainingQuestion[] {
  validatePracticeDefinition(definition);
  if (!sessionId.trim()) throw new RangeError("Session id is required");

  const characters = normalizeCharacters(definition.characters);
  const choicePool = [...new Set([
    ...characters,
    ...(Object.keys(MORSE).slice(0, 36) as MorseCharacter[]),
  ])];
  const random = createSeededRandom(definition.seed);
  const questions: TrainingQuestion[] = [];

  for (let index = 0; index < definition.questionCount; index += 1) {
    const previousThree = questions.slice(-3).map((question) => question.target);
    const candidates =
      characters.length > 1 && previousThree.length === 3 && previousThree.every((value) => value === previousThree[0])
        ? characters.filter((character) => character !== previousThree[0])
        : characters;
    const target = definition.shuffle === false
      ? characters[index % characters.length]
      : candidates[Math.floor(random() * candidates.length)];
    const distractors = shuffle(
      choicePool.filter((character) => character !== target),
      random,
    ).slice(0, 3);
    const choices = shuffle([target, ...distractors], random);

    questions.push({
      id: `${sessionId}:question:${index}`,
      index,
      target,
      choices,
    });
  }

  return questions;
}

function transitionSnapshot(
  snapshot: SessionSnapshot,
  status: SessionStatus,
  now: string,
  changes: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  assertIsoTimestamp(now, "Transition time");
  return { ...snapshot, ...changes, status, updatedAt: now };
}

function assertStatus(snapshot: SessionSnapshot, allowed: SessionStatus[], action: string): void {
  if (!allowed.includes(snapshot.status)) {
    throw new Error(`Cannot ${action} while session is ${snapshot.status}`);
  }
}

export function createTrainingSession(
  definition: PracticeDefinition,
  options: CreateTrainingOptions,
): TrainingState {
  validatePracticeDefinition(definition);
  if (!options.sessionId.trim()) throw new RangeError("Session id is required");
  assertIsoTimestamp(options.now, "Session start time");

  const snapshot: SessionSnapshot = {
    id: options.sessionId,
    status: "preparing",
    definition: structuredClone(definition),
    questions: generateQuestions(definition, options.sessionId),
    currentQuestionIndex: 0,
    questionStartedAt: null,
    currentReplayCount: 0,
    resumeStatus: null,
    startedAt: options.now,
    updatedAt: options.now,
    completedAt: null,
    summary: null,
  };

  return { snapshot, attempts: [] };
}

export function restoreTrainingSession(snapshot: SessionSnapshot, attempts: Attempt[]): TrainingState {
  validatePracticeDefinition(snapshot.definition);
  if (snapshot.questions.length !== snapshot.definition.questionCount) {
    throw new Error("Stored question snapshot does not match the practice definition");
  }
  if (snapshot.currentQuestionIndex < 0 || snapshot.currentQuestionIndex >= snapshot.questions.length) {
    throw new RangeError("Stored question index is outside the question snapshot");
  }
  const uniqueIndices = new Set(attempts.map((attempt) => attempt.questionIndex));
  if (uniqueIndices.size !== attempts.length || attempts.some((attempt) => attempt.sessionId !== snapshot.id)) {
    throw new Error("Stored attempts are inconsistent with the session snapshot");
  }
  return { snapshot: structuredClone(snapshot), attempts: structuredClone(attempts) };
}

export function getCurrentQuestion(state: TrainingState): TrainingQuestion {
  const question = state.snapshot.questions[state.snapshot.currentQuestionIndex];
  if (!question) throw new Error("Current question is missing");
  return question;
}

export function startTraining(state: TrainingState, now: string): TrainingState {
  assertStatus(state.snapshot, ["preparing"], "start training");
  return {
    ...state,
    snapshot: transitionSnapshot(state.snapshot, "prompting", now, {
      questionStartedAt: null,
      currentReplayCount: 0,
    }),
  };
}

export function markPromptComplete(state: TrainingState, now: string): TrainingState {
  assertStatus(state.snapshot, ["prompting"], "accept answers");
  return {
    ...state,
    snapshot: transitionSnapshot(state.snapshot, "answering", now, { questionStartedAt: now }),
  };
}

export function recordReplay(state: TrainingState, now: string): TrainingState {
  assertStatus(state.snapshot, ["prompting", "answering"], "record replay");
  return {
    ...state,
    snapshot: transitionSnapshot(state.snapshot, state.snapshot.status, now, {
      currentReplayCount: state.snapshot.currentReplayCount + 1,
    }),
  };
}

export function submitTrainingAnswer(
  state: TrainingState,
  response: string,
  now: string,
  timingScore: number | null = null,
): { state: TrainingState; attempt: Attempt } {
  assertStatus(state.snapshot, ["answering"], "submit an answer");
  assertIsoTimestamp(now, "Submission time");
  if (!state.snapshot.questionStartedAt) throw new Error("Question start time is missing");
  if (timingScore !== null && (!Number.isFinite(timingScore) || timingScore < 0 || timingScore > 1)) {
    throw new RangeError("Timing score must be null or stay between zero and one");
  }

  const question = getCurrentQuestion(state);
  const normalizedResponse = response.trim().toUpperCase();
  const attempt: Attempt = {
    id: `${state.snapshot.id}:attempt:${question.index}`,
    sessionId: state.snapshot.id,
    questionIndex: question.index,
    target: question.target,
    response: normalizedResponse,
    correct: normalizedResponse === question.target,
    reactionMs: Math.max(0, Date.parse(now) - Date.parse(state.snapshot.questionStartedAt)),
    replayCount: state.snapshot.currentReplayCount,
    timingScore,
    submittedAt: now,
  };

  const nextState: TrainingState = {
    attempts: [...state.attempts, attempt],
    snapshot: transitionSnapshot(state.snapshot, "feedback", now, { questionStartedAt: null }),
  };
  return { state: nextState, attempt };
}

export function advanceTraining(state: TrainingState, now: string): TrainingState {
  assertStatus(state.snapshot, ["feedback"], "advance training");
  const isFinalQuestion = state.snapshot.currentQuestionIndex === state.snapshot.questions.length - 1;
  if (!isFinalQuestion) {
    return {
      ...state,
      snapshot: transitionSnapshot(state.snapshot, "prompting", now, {
        currentQuestionIndex: state.snapshot.currentQuestionIndex + 1,
        questionStartedAt: null,
        currentReplayCount: 0,
      }),
    };
  }

  const correct = state.attempts.filter((attempt) => attempt.correct).length;
  const totalReactionMs = state.attempts.reduce((total, attempt) => total + attempt.reactionMs, 0);
  return {
    ...state,
    snapshot: transitionSnapshot(state.snapshot, "completed", now, {
      completedAt: now,
      summary: {
        total: state.attempts.length,
        correct,
        accuracy: state.attempts.length === 0 ? 0 : correct / state.attempts.length,
        averageReactionMs: state.attempts.length === 0 ? 0 : totalReactionMs / state.attempts.length,
        completedAt: now,
      },
    }),
  };
}

export function pauseTraining(state: TrainingState, now: string): TrainingState {
  assertStatus(state.snapshot, ["prompting", "answering"], "pause training");
  const resumeStatus = state.snapshot.status === "answering" ? "answering" : "prompting";
  return {
    ...state,
    snapshot: transitionSnapshot(state.snapshot, "paused", now, {
      resumeStatus,
      questionStartedAt: null,
    }),
  };
}

export function interruptTraining(state: TrainingState, now: string): TrainingState {
  assertStatus(state.snapshot, ["prompting", "answering"], "interrupt training");
  const resumeStatus = state.snapshot.status === "answering" ? "answering" : "prompting";
  return {
    ...state,
    snapshot: transitionSnapshot(state.snapshot, "interrupted", now, {
      resumeStatus,
      questionStartedAt: null,
    }),
  };
}

export function resumeTraining(state: TrainingState, now: string): TrainingState {
  assertStatus(state.snapshot, ["paused", "interrupted"], "resume training");
  return {
    ...state,
    snapshot: transitionSnapshot(state.snapshot, "prompting", now, {
      resumeStatus: null,
      questionStartedAt: null,
    }),
  };
}

export function abandonTraining(state: TrainingState, now: string): TrainingState {
  assertStatus(
    state.snapshot,
    ["preparing", "prompting", "answering", "feedback", "paused", "interrupted"],
    "abandon training",
  );
  return {
    ...state,
    snapshot: transitionSnapshot(state.snapshot, "abandoned", now, {
      questionStartedAt: null,
      resumeStatus: null,
    }),
  };
}

export function createMistakePracticeDefinition(
  state: TrainingState,
  seed: string,
): PracticeDefinition {
  if (!seed.trim()) throw new RangeError("A deterministic seed is required");
  const mistakes = [...new Set(state.attempts.filter((attempt) => !attempt.correct).map((attempt) => attempt.target))];
  const characters = mistakes.length > 0 ? mistakes : state.snapshot.definition.characters;
  return {
    ...structuredClone(state.snapshot.definition),
    characters,
    questionCount: Math.max(characters.length * 3, characters.length),
    seed,
  };
}
