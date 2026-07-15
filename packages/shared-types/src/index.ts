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
export type SessionStatus =
  | "preparing"
  | "prompting"
  | "answering"
  | "feedback"
  | "paused"
  | "interrupted"
  | "completed"
  | "abandoned";

export type InputSource = "keyboard" | "pointer" | "touch" | "gamepad" | "external-key";
export type InputControl = "single" | "dot" | "dash";

export type KeySignal = {
  source: InputSource;
  control: InputControl;
  phase: "down" | "up" | "cancel";
  timestampMs: number;
};

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
  shuffle?: boolean;
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

export type TrainingQuestion = {
  id: string;
  index: number;
  target: string;
  choices: string[];
};

export type SessionSummary = {
  total: number;
  correct: number;
  accuracy: number;
  averageReactionMs: number;
  completedAt: string;
};

export type SessionSnapshot = {
  id: string;
  status: SessionStatus;
  definition: PracticeDefinition;
  questions: TrainingQuestion[];
  currentQuestionIndex: number;
  questionStartedAt: string | null;
  currentReplayCount: number;
  resumeStatus: "prompting" | "answering" | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  summary: SessionSummary | null;
};
