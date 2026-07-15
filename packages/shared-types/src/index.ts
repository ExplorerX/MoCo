export const DATA_SCHEMA_VERSION = 1 as const;

export type PracticeMode =
  | "character-to-code"
  | "code-to-character"
  | "sound-to-character"
  | "character-to-keying"
  | "text-to-code"
  | "code-to-text"
  | "sound-to-text"
  | "free-keying";

export type AudioWaveform = "sine" | "square";
export type FeedbackMode = "immediate" | "session-end";
export type SessionStatus = "ready" | "active" | "paused" | "completed" | "abandoned";

export type TimingProfile = {
  characterWpm: number;
  effectiveWpm: number;
  frequencyHz: number;
  waveform: AudioWaveform;
  volume: number;
};

export type PracticeDefinition = {
  schemaVersion: typeof DATA_SCHEMA_VERSION;
  mode: PracticeMode;
  characters: string[];
  questionCount: number;
  seed: string;
  timing: TimingProfile;
  timeoutMs: number | null;
  feedbackMode: FeedbackMode;
};

export type Attempt = {
  id: string;
  sessionId: string;
  questionIndex: number;
  target: string;
  response: string;
  correct: boolean;
  reactionMs: number;
  replayCount: number;
  timingScore: number | null;
  submittedAt: string;
};

export type SessionSnapshot = {
  id: string;
  status: SessionStatus;
  definition: PracticeDefinition;
  currentQuestionIndex: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};
