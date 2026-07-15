import Dexie, { type Table } from "dexie";
import {
  DATA_SCHEMA_VERSION,
  type Attempt,
  type PracticeMode,
  type SessionSnapshot,
} from "@learning-morse/shared-types";

export const DATABASE_NAME = "learning-morse-code";
export const DATABASE_VERSION = 1;

export type AppMetaRecord = {
  key: string;
  value: unknown;
  updatedAt: string;
};

export type SettingsRecord = {
  scope: string;
  value: unknown;
  updatedAt: string;
};

export type CharacterStatRecord = {
  id: string;
  character: string;
  mode: PracticeMode;
  attempts: number;
  correct: number;
  totalReactionMs: number;
  lastPracticedAt: string;
};

export type CharacterFlagRecord = {
  character: string;
  favorite: boolean;
  needsWork: boolean;
  updatedAt: string;
};

export type CourseProgressRecord = {
  courseId: string;
  step: number;
  unlockedCharacters: string[];
  updatedAt: string;
};

export type StoredTrainingSession = {
  snapshot: SessionSnapshot;
  attempts: Attempt[];
};

export interface SessionRepository {
  initialize(now?: string): Promise<void>;
  createSession(snapshot: SessionSnapshot): Promise<void>;
  saveSession(snapshot: SessionSnapshot): Promise<void>;
  saveAttemptAndSession(attempt: Attempt, snapshot: SessionSnapshot): Promise<void>;
  loadSession(sessionId: string): Promise<StoredTrainingSession | null>;
  getLatestRecoverableSession(): Promise<StoredTrainingSession | null>;
  getRecentSessions(limit?: number): Promise<SessionSnapshot[]>;
  getCharacterStats(): Promise<CharacterStatRecord[]>;
}

export class LearningMorseDatabase extends Dexie {
  appMeta!: Table<AppMetaRecord, string>;
  settings!: Table<SettingsRecord, string>;
  sessions!: Table<SessionSnapshot, string>;
  attempts!: Table<Attempt, string>;
  characterStats!: Table<CharacterStatRecord, string>;
  flags!: Table<CharacterFlagRecord, string>;
  courseProgress!: Table<CourseProgressRecord, string>;

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(DATABASE_VERSION).stores({
      appMeta: "key, updatedAt",
      settings: "scope, updatedAt",
      sessions: "id, status, startedAt, updatedAt",
      attempts: "id, sessionId, [sessionId+questionIndex], submittedAt",
      characterStats: "id, character, mode, lastPracticedAt",
      flags: "character, favorite, needsWork, updatedAt",
      courseProgress: "courseId, updatedAt",
    });
  }
}

export class DexieSessionRepository implements SessionRepository {
  readonly database: LearningMorseDatabase;

  constructor(database: LearningMorseDatabase = new LearningMorseDatabase()) {
    this.database = database;
  }

  async initialize(now = new Date().toISOString()): Promise<void> {
    await this.database.open();
    await this.database.appMeta.put({
      key: "schema",
      value: { databaseVersion: DATABASE_VERSION, dataSchemaVersion: DATA_SCHEMA_VERSION },
      updatedAt: now,
    });
  }

  async createSession(snapshot: SessionSnapshot): Promise<void> {
    if (snapshot.status !== "preparing" && snapshot.status !== "prompting" && snapshot.status !== "answering") {
      throw new Error("A new session must be in an initial state");
    }
    await this.database.sessions.add(structuredClone(snapshot));
  }

  async saveSession(snapshot: SessionSnapshot): Promise<void> {
    await this.database.sessions.put(structuredClone(snapshot));
  }

  async saveAttemptAndSession(attempt: Attempt, snapshot: SessionSnapshot): Promise<void> {
    if (attempt.sessionId !== snapshot.id) throw new Error("Attempt and session ids do not match");
    if (attempt.questionIndex < 0 || attempt.questionIndex >= snapshot.questions.length) {
      throw new RangeError("Attempt question index is outside the session snapshot");
    }

    await this.database.transaction(
      "rw",
      this.database.attempts,
      this.database.sessions,
      this.database.characterStats,
      async () => {
        const existingAttempt = await this.database.attempts.get(attempt.id);
        if (existingAttempt) {
          if (JSON.stringify(existingAttempt) !== JSON.stringify(attempt)) {
            throw new Error("The first attempt for this question is immutable");
          }
        } else {
          await this.database.attempts.add(structuredClone(attempt));
          const statId = `${attempt.target}|${snapshot.definition.mode}`;
          const current = await this.database.characterStats.get(statId);
          await this.database.characterStats.put({
            id: statId,
            character: attempt.target,
            mode: snapshot.definition.mode,
            attempts: (current?.attempts ?? 0) + 1,
            correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
            totalReactionMs: (current?.totalReactionMs ?? 0) + attempt.reactionMs,
            lastPracticedAt: attempt.submittedAt,
          });
        }
        await this.database.sessions.put(structuredClone(snapshot));
      },
    );
  }

  async loadSession(sessionId: string): Promise<StoredTrainingSession | null> {
    const snapshot = await this.database.sessions.get(sessionId);
    if (!snapshot) return null;
    const attempts = await this.database.attempts.where("sessionId").equals(sessionId).sortBy("questionIndex");
    return { snapshot, attempts };
  }

  async getLatestRecoverableSession(): Promise<StoredTrainingSession | null> {
    const recoverable = await this.database.sessions
      .where("status")
      .anyOf(["preparing", "prompting", "answering", "feedback", "paused", "interrupted"])
      .toArray();
    recoverable.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return recoverable[0] ? this.loadSession(recoverable[0].id) : null;
  }

  async getRecentSessions(limit = 20): Promise<SessionSnapshot[]> {
    return this.database.sessions.orderBy("updatedAt").reverse().limit(limit).toArray();
  }

  async getCharacterStats(): Promise<CharacterStatRecord[]> {
    return this.database.characterStats.toArray();
  }

  async clearAll(): Promise<void> {
    await this.database.transaction(
      "rw",
      [
        this.database.appMeta,
        this.database.settings,
        this.database.sessions,
        this.database.attempts,
        this.database.characterStats,
        this.database.flags,
        this.database.courseProgress,
      ],
      async () => {
        await Promise.all([
          this.database.appMeta.clear(),
          this.database.settings.clear(),
          this.database.sessions.clear(),
          this.database.attempts.clear(),
          this.database.characterStats.clear(),
          this.database.flags.clear(),
          this.database.courseProgress.clear(),
        ]);
      },
    );
  }

  close(): void {
    this.database.close();
  }
}

export function createSessionRepository(name = DATABASE_NAME): DexieSessionRepository {
  return new DexieSessionRepository(new LearningMorseDatabase(name));
}
