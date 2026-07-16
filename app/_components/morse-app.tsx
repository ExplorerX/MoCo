"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AudioEngine } from "@learning-morse/audio-engine";
import { InputEngine, keyboardSignal, pointerSignal } from "@learning-morse/input-engine";
import { MORSE as MORSE_TABLE, REVERSE_MORSE, createFarnsworthTimeline, decodeText, dotUnitMs, encodeText, formatMorse as formatCode } from "@learning-morse/morse-core";
import { createSessionRepository, type DexieSessionRepository } from "@learning-morse/storage";
import {
  abandonTraining,
  advanceTraining,
  createMistakePracticeDefinition,
  createTrainingSession,
  getCurrentQuestion,
  interruptTraining,
  markPromptComplete,
  pauseTraining,
  recordReplay,
  restoreTrainingSession,
  resumeTraining,
  startTraining,
  submitTrainingAnswer,
  type TrainingState,
} from "@learning-morse/training-engine";
import { DATA_SCHEMA_VERSION, type AudioWaveform, type PracticeDefinition, type PracticeMode, type SessionSummary, type TimingProfile } from "@learning-morse/shared-types";
import type { SessionSnapshot } from "@learning-morse/shared-types";
import type { CharacterStatRecord, LearningMorseExport } from "@learning-morse/storage";
import PwaStatus from "./pwa-status";
import { domainForPreset, pathForView, routeFromPath, type AppRoute, type AppView, type PrimaryView, type SettingsSection, type TrainingPresetId } from "../_lib/routes";

type Theme = "light" | "dark" | "amber" | "contrast";
type KeyMode = "single" | "dual";
type PressSample = { duration: number; symbol: "." | "-"; at: string };
type LearnFilter = "letters" | "numbers" | "punctuation";
type KeyBindings = { single: string; dot: string; dash: string; submit: string; delete: string; replay: string; pause: string };
type GuidedLesson = { id: string; title: string; characters: readonly [string, string]; cues: readonly [string, string] };
type AppPreferences = {
  frequency: number;
  wpm: number;
  effectiveWpm: number;
  volume: number;
  waveform: AudioWaveform;
  keyMode: KeyMode;
  thresholdUnits: number;
  commitGapUnits: number;
  questionCount: number;
  practiceCharacters: string;
  shuffle: boolean;
  timeoutMs: number | null;
  bindings: KeyBindings;
};

const MORSE: Readonly<Record<string, string>> = MORSE_TABLE;
const DEFAULT_BINDINGS: KeyBindings = { single: "Space", dot: "KeyZ", dash: "KeyX", submit: "Enter", delete: "Backspace", replay: "KeyR", pause: "KeyP" };

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function sanitizePreferences(value: unknown): AppPreferences {
  const saved = value && typeof value === "object" ? value as Partial<AppPreferences> : {};
  const wpm = Math.round(numberInRange(saved.wpm, 20, 8, 40));
  const bindings = { ...DEFAULT_BINDINGS };
  if (saved.bindings && typeof saved.bindings === "object") {
    for (const control of Object.keys(DEFAULT_BINDINGS) as (keyof KeyBindings)[]) {
      const binding = saved.bindings[control];
      if (typeof binding === "string" && binding.trim()) bindings[control] = binding;
    }
  }
  return {
    frequency: Math.round(numberInRange(saved.frequency, 600, 400, 900)),
    wpm,
    effectiveWpm: Math.min(wpm, Math.round(numberInRange(saved.effectiveWpm, 10, 5, 40))),
    volume: numberInRange(saved.volume, 0.6, 0.1, 1),
    waveform: saved.waveform === "square" ? "square" : "sine",
    keyMode: saved.keyMode === "dual" ? "dual" : "single",
    thresholdUnits: numberInRange(saved.thresholdUnits, 2, 1.4, 2.6),
    commitGapUnits: numberInRange(saved.commitGapUnits, 6, 3, 10),
    questionCount: Math.round(numberInRange(saved.questionCount, 4, 4, 40)),
    practiceCharacters: typeof saved.practiceCharacters === "string" ? saved.practiceCharacters : "K M R S",
    shuffle: typeof saved.shuffle === "boolean" ? saved.shuffle : true,
    timeoutMs: typeof saved.timeoutMs === "number" && Number.isFinite(saved.timeoutMs) && saved.timeoutMs > 0 ? saved.timeoutMs : null,
    bindings,
  };
}

const NAV: { id: PrimaryView; label: string }[] = [
  { id: "home", label: "首页" },
  { id: "learn", label: "基础" },
  { id: "receive", label: "听抄" },
  { id: "send", label: "发报" },
  { id: "tools", label: "工具" },
];

const DOMAIN_CARDS = [
  { domain: "learn", eyebrow: "认", title: "基础学习与识别", copy: "学习字符、课程与点划识别。" },
  { domain: "receive", eyebrow: "听", title: "听抄与接收训练", copy: "从声音建立字符反射。" },
  { domain: "send", eyebrow: "拍", title: "发报与节奏训练", copy: "跟拍字符或自由拍发。" },
  { domain: "tools", eyebrow: "查", title: "查询与转换工具", copy: "双向转换并速查字符。" },
] satisfies { eyebrow: string; title: string; copy: string; domain: PrimaryView }[];

const GUIDED_LESSONS: readonly GuidedLesson[] = [
  { id: "signals", title: "点与划", characters: ["E", "T"], cues: ["轻点一下 · 滴", "按住更久 — 嗒"] },
  { id: "opposites", title: "方向相反", characters: ["A", "N"], cues: ["短后长 ·—", "长后短 —·"] },
  { id: "pairs", title: "成双节奏", characters: ["I", "M"], cues: ["两个短音 ··", "两个长音 ——"] },
  { id: "triples", title: "三连节奏", characters: ["S", "O"], cues: ["三点轻快 ···", "三划舒展 ———"] },
  { id: "branches", title: "分支组合", characters: ["U", "D"], cues: ["短短长 ··—", "长短短 —··"] },
  { id: "mirror", title: "镜像节奏", characters: ["R", "K"], cues: ["短长短 ·—·", "长短长 —·—"] },
] as const;

type KeyDurationGuideHandle = {
  update: (elapsedMs: number, pressing: boolean) => void;
};

const KeyDurationGuide = forwardRef<KeyDurationGuideHandle, { elapsedMs: number; thresholdMs: number; dotMs: number; pressing: boolean }>(function KeyDurationGuide({ elapsedMs, thresholdMs, dotMs, pressing }, ref) {
  const maxMs = Math.max(dotMs * 4, thresholdMs * 1.5);
  const progress = Math.min(100, elapsedMs / maxMs * 100);
  const thresholdPosition = Math.min(92, thresholdMs / maxMs * 100);
  const zone = elapsedMs === 0 ? "idle" : elapsedMs < thresholdMs ? "dot" : "dash";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const elapsedRef = useRef<HTMLElement | null>(null);
  const statusRef = useRef<HTMLElement | null>(null);
  const fillRef = useRef<HTMLElement | null>(null);
  const needleRef = useRef<HTMLElement | null>(null);

  const update = useCallback((liveElapsedMs: number, livePressing: boolean) => {
    const safeElapsedMs = Math.max(0, liveElapsedMs);
    const liveProgress = Math.min(100, safeElapsedMs / maxMs * 100);
    const liveZone = safeElapsedMs === 0 ? "idle" : safeElapsedMs < thresholdMs ? "dot" : "dash";
    if (rootRef.current) {
      rootRef.current.dataset.zone = liveZone;
      rootRef.current.setAttribute("aria-label", `按压时长 ${Math.round(safeElapsedMs)} 毫秒，点划阈值 ${Math.round(thresholdMs)} 毫秒`);
    }
    if (elapsedRef.current) elapsedRef.current.textContent = safeElapsedMs ? `${Math.round(safeElapsedMs)} ms` : "准备";
    if (statusRef.current) statusRef.current.textContent = liveZone === "dot" ? "点 ·" : liveZone === "dash" ? "划 —" : livePressing ? "计时中" : "等待输入";
    if (fillRef.current) fillRef.current.style.width = `${liveProgress}%`;
    if (needleRef.current) needleRef.current.style.left = `${liveProgress}%`;
  }, [maxMs, thresholdMs]);

  useImperativeHandle(ref, () => ({ update }), [update]);
  useEffect(() => update(elapsedMs, pressing), [elapsedMs, pressing, update]);

  return (
    <div ref={rootRef} className="duration-guide" data-zone={zone} aria-label={`按压时长 ${Math.round(elapsedMs)} 毫秒，点划阈值 ${Math.round(thresholdMs)} 毫秒`}>
      <div className="duration-readout">
        <span>按压时长</span>
        <strong ref={elapsedRef}>{elapsedMs ? `${Math.round(elapsedMs)} ms` : "准备"}</strong>
        <b ref={statusRef}>{zone === "dot" ? "点 ·" : zone === "dash" ? "划 —" : pressing ? "计时中" : "等待输入"}</b>
      </div>
      <div className="duration-track" aria-hidden="true">
        <i ref={fillRef} className="duration-fill" style={{ width: `${progress}%` }} />
        <i className="duration-threshold" style={{ left: `${thresholdPosition}%` }} />
        <i ref={needleRef} className="duration-needle" style={{ left: `${progress}%` }} />
      </div>
      <div className="duration-labels"><span>短按 · 点</span><span style={{ left: `${thresholdPosition}%` }}>阈值 {Math.round(thresholdMs)} ms</span><span>长按 · 划</span></div>
    </div>
  );
});

const PRACTICE_MODE_MAP: Record<TrainingPresetId, PracticeMode> = {
  "learn.character.decode": "code-to-character",
  "learn.character.encode": "character-to-code",
  "receive.character.audio": "sound-to-character",
  "send.character.guided": "character-to-keying",
  "review.mistakes": "sound-to-character",
};
function parsePracticeCharacters(value: string): string[] {
  return [...new Set(Array.from(value.toUpperCase()).filter((character) => Boolean(MORSE[character])))];
}

function practiceModeLabel(mode: PracticeMode): string {
  return mode === "sound-to-character" ? "声音 → 字符" : mode === "code-to-character" ? "Morse → 字符" : mode === "character-to-code" ? "字符 → Morse" : mode === "character-to-keying" ? "字符 → 发报" : mode;
}

function presetForPracticeMode(mode?: PracticeMode): TrainingPresetId {
  return mode === "code-to-character" ? "learn.character.decode" : mode === "character-to-code" ? "learn.character.encode" : mode === "character-to-keying" ? "send.character.guided" : "receive.character.audio";
}

function domainPathForMode(mode?: PracticeMode): string {
  return mode === "character-to-keying" ? "/send" : mode === "sound-to-character" ? "/receive" : "/learn";
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
}

function learnFilterForCharacter(character?: string): LearnFilter {
  if (character && /^\d$/.test(character)) return "numbers";
  if (character && !/^[A-Z]$/.test(character)) return "punctuation";
  return "letters";
}

export default function MorseApp({ initialPath }: { initialPath: string }) {
  const [route, setRoute] = useState<AppRoute>(() => routeFromPath(initialPath));
  const view = route.view;
  const [theme, setTheme] = useState<Theme>("dark");
  const [frequency, setFrequency] = useState(600);
  const [wpm, setWpm] = useState(20);
  const [effectiveWpm, setEffectiveWpm] = useState(10);
  const [volume, setVolume] = useState(0.6);
  const [waveform, setWaveform] = useState<AudioWaveform>("sine");
  const [keyMode, setKeyMode] = useState<KeyMode>("single");
  const [thresholdUnits, setThresholdUnits] = useState(2);
  const [commitGapUnits, setCommitGapUnits] = useState(6);
  const [bindings, setBindings] = useState<KeyBindings>(DEFAULT_BINDINGS);
  const [sequence, setSequence] = useState("");
  const [decoded, setDecoded] = useState("");
  const [isPressing, setIsPressing] = useState(false);
  const [pressElapsedMs, setPressElapsedMs] = useState(0);
  const [audioState, setAudioState] = useState<"locked" | "ready" | "error">("locked");
  const [isPlaying, setIsPlaying] = useState(false);
  const [samples, setSamples] = useState<PressSample[]>([]);
  const [trainingState, setTrainingState] = useState<TrainingState | null>(null);
  const [latestResultState, setLatestResultState] = useState<TrainingState | null>(null);
  const [recoverableState, setRecoverableState] = useState<TrainingState | null>(null);
  const [lastSummary, setLastSummary] = useState<SessionSummary | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "error">("loading");
  const [questionCount, setQuestionCount] = useState(4);
  const [practiceCharacters, setPracticeCharacters] = useState("K M R S");
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [timeoutMs, setTimeoutMs] = useState<number | null>(null);
  const [practiceError, setPracticeError] = useState("");
  const [learnFilter, setLearnFilter] = useState<LearnFilter>(() => learnFilterForCharacter(route.character));
  const [learnCode, setLearnCode] = useState("");
  const [learnResult, setLearnResult] = useState<"correct" | "error" | null>(null);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [sessionCode, setSessionCode] = useState("");
  const [typedAnswer, setTypedAnswer] = useState("");
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [dataMessage, setDataMessage] = useState("");
  const [characterStats, setCharacterStats] = useState<CharacterStatRecord[]>([]);
  const [recentSessions, setRecentSessions] = useState<SessionSnapshot[]>([]);
  const [routeMessage, setRouteMessage] = useState("");
  const [showGuidedHints, setShowGuidedHints] = useState(true);
  const [toolText, setToolText] = useState("SOS MORSE");
  const [toolCode, setToolCode] = useState("... --- ... / -- --- .-. ... .");

  const audioEngineRef = useRef<AudioEngine | null>(null);
  const inputEngineRef = useRef<InputEngine | null>(null);
  const repositoryRef = useRef<DexieSessionRepository | null>(null);
  const sequenceRef = useRef("");
  const charTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationGuideRef = useRef<KeyDurationGuideHandle | null>(null);
  const pressFrameRef = useRef<number | null>(null);
  const pressStartedAtRef = useRef<number | null>(null);
  const learnEvaluationTimerRef = useRef<number | null>(null);
  const learnResultTimerRef = useRef<number | null>(null);
  const answerPendingRef = useRef(false);
  const advancePendingRef = useRef(false);
  const sessionStartPendingRef = useRef(false);
  const trainingStateRef = useRef<TrainingState | null>(null);
  const routeRef = useRef<AppRoute>(route);
  const activeInputTargetRef = useRef<"keyer" | "session" | "learn">("keyer");
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const sessionActionsRef = useRef({ pause: () => undefined, replay: () => undefined, submit: () => undefined, timeout: () => undefined });

  const dotMs = dotUnitMs(wpm);
  const thresholdMs = dotMs * thresholdUnits;
  const characterGapMs = dotMs * commitGapUnits;
  const wordGapMs = dotMs * (commitGapUnits + 4);
  const sessionStep = trainingState?.snapshot.currentQuestionIndex ?? 0;
  const questions = trainingState?.snapshot.questions ?? [];
  const currentQuestion = trainingState ? getCurrentQuestion(trainingState) : null;
  const currentAttempt = trainingState?.attempts.find((attempt) => attempt.questionIndex === sessionStep) ?? null;
  const sessionAnswer = currentAttempt?.response ?? null;
  const hasSessionAnswer = currentAttempt !== null;
  const activeCharacter = route.character && MORSE[route.character] ? route.character : learnFilter === "numbers" ? "0" : learnFilter === "punctuation" ? "." : "K";
  const sessionMode = trainingState?.snapshot.definition.mode ?? "sound-to-character";
  const sessionTiming = trainingState?.snapshot.definition.timing;
  const sessionDotMs = dotUnitMs(sessionTiming?.characterWpm ?? wpm);
  const sessionThresholdMs = sessionDotMs * thresholdUnits;
  const freeKeyer = view === "send" && route.path === "/send/free";

  const updateWpm = useCallback((nextWpm: number) => {
    const safeWpm = Math.round(numberInRange(nextWpm, 20, 8, 40));
    setWpm(safeWpm);
    setEffectiveWpm((current) => Math.min(current, safeWpm));
  }, []);

  const goTo = useCallback((path: string, replace = false) => {
    const nextRoute = routeFromPath(path);
    if (replace) window.history.replaceState({}, "", nextRoute.path);
    else window.history.pushState({}, "", nextRoute.path);
    setRoute(nextRoute);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  useEffect(() => { trainingStateRef.current = trainingState; }, [trainingState]);
  useEffect(() => { routeRef.current = route; }, [route]);

  useEffect(() => {
    let cancelled = false;
    const onPopState = () => {
      audioEngineRef.current?.stopPlayback();
      setIsPlaying(false);
      const active = trainingStateRef.current;
      if (routeRef.current.view === "session" && active && (active.snapshot.status === "prompting" || active.snapshot.status === "answering")) {
        const interrupted = interruptTraining(active, new Date().toISOString());
        trainingStateRef.current = interrupted;
        setTrainingState(interrupted);
        setRecoverableState(interrupted);
        void repositoryRef.current?.saveSession(interrupted.snapshot).catch(() => setStorageState("error"));
      }
      setSessionCode("");
      setLearnCode("");
      setLearnResult(null);
      setPressElapsedMs(0);
      setTypedAnswer("");
      const nextRoute = routeFromPath(window.location.pathname);
      if (nextRoute.view === "learn") setLearnFilter(learnFilterForCharacter(nextRoute.character));
      setRoute(nextRoute);
    };
    window.addEventListener("popstate", onPopState);
    queueMicrotask(() => {
      if (cancelled) return;
      const browserPath = window.location.pathname;
      if (browserPath !== initialPath) setRoute(routeFromPath(browserPath));
      if (browserPath === "/" && window.localStorage.getItem("morse-v2-onboarding-complete") === "true") goTo("/home", true);
      if (browserPath === "/settings") goTo("/settings/appearance", true);
    });
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPopState);
    };
  }, [goTo, initialPath]);

  useEffect(() => {
    const saved = window.localStorage.getItem("morse-v2-theme") as Theme | null;
    if (!saved || !["light", "dark", "amber", "contrast"].includes(saved)) return;
    const frame = window.requestAnimationFrame(() => setTheme(saved));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("morse-v2-theme", theme);
  }, [theme]);

  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  const getInputEngine = useCallback((target: "keyer" | "session" | "learn" = "keyer") => {
    const characterWpm = target === "session"
      ? trainingStateRef.current?.snapshot.definition.timing.characterWpm ?? wpm
      : wpm;
    if (!inputEngineRef.current) {
      inputEngineRef.current = new InputEngine({ characterWpm, thresholdUnits });
    }
    inputEngineRef.current.setConfig({ characterWpm, thresholdUnits });
    return inputEngineRef.current;
  }, [thresholdUnits, wpm]);

  const getAudioEngine = useCallback(() => {
    if (!audioEngineRef.current) {
      audioEngineRef.current = new AudioEngine({
        config: { frequencyHz: frequency, volume, waveform },
        onStateChange: (state) => {
          if (state === "running") setAudioState("ready");
          if (state === "failed") setAudioState("error");
          if (state === "locked" || state === "suspended" || state === "recovering") setAudioState("locked");
        },
      });
    }
    audioEngineRef.current.setConfig({ frequencyHz: frequency, volume, waveform });
    return audioEngineRef.current;
  }, [frequency, volume, waveform]);

  const ensureAudio = useCallback(async (timing?: TimingProfile) => {
    try {
      const engine = getAudioEngine();
      if (timing) engine.setConfig({ frequencyHz: timing.frequencyHz, volume: timing.volume, waveform: timing.waveform });
      await engine.ensureRunning();
      setAudioState("ready");
      return engine;
    } catch {
      setAudioState("error");
      return null;
    }
  }, [getAudioEngine]);

  const playText = useCallback(async (text: string, timing?: TimingProfile) => {
    if (isPlaying) return;
    try {
      const engine = await ensureAudio(timing);
      if (!engine) return;
      const characterWpm = timing?.characterWpm ?? wpm;
      const playbackEffectiveWpm = Math.min(timing?.effectiveWpm ?? effectiveWpm, characterWpm);
      const timeline = createFarnsworthTimeline(text, characterWpm, playbackEffectiveWpm);
      setIsPlaying(true);
      const cursorMs = await engine.playTimeline(timeline);

      if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = setTimeout(() => {
        playbackTimerRef.current = null;
        setIsPlaying(false);
      }, cursorMs + 100);
    } catch {
      setAudioState("error");
      setIsPlaying(false);
    }
  }, [effectiveWpm, ensureAudio, isPlaying, wpm]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard access can be denied outside a secure or focused context.
    }
  }, []);

  const stopPlayback = useCallback(() => {
    audioEngineRef.current?.stopPlayback();
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    playbackTimerRef.current = null;
    setIsPlaying(false);
  }, []);

  const clearCommitTimers = useCallback(() => {
    if (charTimerRef.current) clearTimeout(charTimerRef.current);
    if (wordTimerRef.current) clearTimeout(wordTimerRef.current);
    charTimerRef.current = null;
    wordTimerRef.current = null;
  }, []);

  const stopPressMeter = useCallback((finalDuration = 0) => {
    if (pressFrameRef.current !== null) window.cancelAnimationFrame(pressFrameRef.current);
    pressFrameRef.current = null;
    pressStartedAtRef.current = null;
    const safeDuration = Math.max(0, finalDuration);
    durationGuideRef.current?.update(safeDuration, false);
    setPressElapsedMs(safeDuration);
  }, []);

  const startPressMeter = useCallback(() => {
    if (pressFrameRef.current !== null) window.cancelAnimationFrame(pressFrameRef.current);
    pressStartedAtRef.current = performance.now();
    setPressElapsedMs(0);
    durationGuideRef.current?.update(0, true);
    const update = () => {
      if (pressStartedAtRef.current === null) return;
      durationGuideRef.current?.update(performance.now() - pressStartedAtRef.current, true);
      pressFrameRef.current = window.requestAnimationFrame(update);
    };
    pressFrameRef.current = window.requestAnimationFrame(update);
  }, []);

  const finishPressMeter = useCallback(() => {
    const duration = pressStartedAtRef.current === null ? 0 : performance.now() - pressStartedAtRef.current;
    stopPressMeter(duration);
  }, [stopPressMeter]);

  const commitSequence = useCallback((appendWordGap = false) => {
    const current = sequenceRef.current;
    const character = current ? REVERSE_MORSE[current] ?? "?" : "";
    sequenceRef.current = "";
    setSequence("");
    setDecoded((value) => {
      const committed = `${value}${character}`;
      return appendWordGap && committed && !committed.endsWith(" ") ? `${committed} ` : committed;
    });
  }, []);

  const scheduleCommitTimers = useCallback(() => {
    clearCommitTimers();
    charTimerRef.current = setTimeout(() => {
      charTimerRef.current = null;
      commitSequence();
    }, characterGapMs);
    wordTimerRef.current = setTimeout(() => {
      wordTimerRef.current = null;
      commitSequence(true);
    }, wordGapMs);
  }, [characterGapMs, clearCommitTimers, commitSequence, wordGapMs]);

  const appendSymbol = useCallback((symbol: "." | "-") => {
    const next = `${sequenceRef.current}${symbol}`.slice(-6);
    sequenceRef.current = next;
    setSequence(next);
    scheduleCommitTimers();
  }, [scheduleCommitTimers]);

  const deleteOutput = useCallback(() => {
    if (sequenceRef.current) {
      const next = sequenceRef.current.slice(0, -1);
      sequenceRef.current = next;
      setSequence(next);
      if (next) scheduleCommitTimers();
      else clearCommitTimers();
      return;
    }
    setDecoded((value) => value.slice(0, -1));
  }, [clearCommitTimers, scheduleCommitTimers]);

  const insertWordGap = useCallback(() => {
    clearCommitTimers();
    commitSequence(true);
  }, [clearCommitTimers, commitSequence]);

  const appendSessionSymbol = useCallback((symbol: "." | "-") => {
    setSessionCode((value) => `${value}${symbol}`.slice(0, 6));
  }, []);

  const appendLearnSymbol = useCallback((symbol: "." | "-") => {
    setLearnResult(null);
    if (learnResultTimerRef.current) clearTimeout(learnResultTimerRef.current);
    setLearnCode((value) => `${value}${symbol}`.slice(0, 6));
  }, []);

  const startLiveTone = useCallback(async (source: "keyboard" | "pointer", target: "keyer" | "session" | "learn" = "keyer") => {
    const input = getInputEngine(target);
    const signal = source === "keyboard"
      ? keyboardSignal("single", "down", performance.now())
      : pointerSignal("single", "down", performance.now());
    const interpretation = input.consume(signal);
    if (interpretation.kind !== "press-start") return;
    activeInputTargetRef.current = target;
    setIsPressing(true);
    if (target !== "keyer") startPressMeter();
    const timing = target === "session" ? trainingStateRef.current?.snapshot.definition.timing : undefined;
    const audio = await ensureAudio(timing);
    if (!audio) {
      input.cancel(source, performance.now());
      setIsPressing(false);
      if (target !== "keyer") stopPressMeter();
      return;
    }
    if (!input.isActive) return;
    await audio.startLiveTone();
    if (!input.isActive) audio.stopLiveTone();
  }, [ensureAudio, getInputEngine, startPressMeter, stopPressMeter]);

  const stopLiveTone = useCallback((source: "keyboard" | "pointer", cancel = false) => {
    const input = getInputEngine(activeInputTargetRef.current);
    const phase = cancel ? "cancel" : "up";
    const signal = source === "keyboard"
      ? keyboardSignal("single", phase, performance.now())
      : pointerSignal("single", phase, performance.now());
    const interpretation = input.consume(signal);
    audioEngineRef.current?.stopLiveTone();
    setIsPressing(false);
    if (interpretation.kind !== "symbol") {
      if (activeInputTargetRef.current !== "keyer") stopPressMeter();
      return;
    }
    if (activeInputTargetRef.current !== "keyer") stopPressMeter(interpretation.durationMs);
    if (activeInputTargetRef.current === "session") appendSessionSymbol(interpretation.symbol);
    else if (activeInputTargetRef.current === "learn") appendLearnSymbol(interpretation.symbol);
    else appendSymbol(interpretation.symbol);
    setSamples((value) => [
      { duration: Math.round(interpretation.durationMs), symbol: interpretation.symbol, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) },
      ...value,
    ].slice(0, 8));
  }, [appendLearnSymbol, appendSessionSymbol, appendSymbol, getInputEngine, stopPressMeter]);

  const tapSymbol = useCallback(async (symbol: "." | "-", source: "keyboard" | "pointer", target: "keyer" | "session" | "learn" = "keyer", keepMeterLive = false) => {
    const input = getInputEngine(target);
    const control = symbol === "." ? "dot" : "dash";
    const signal = source === "keyboard"
      ? keyboardSignal(control, "down", performance.now())
      : pointerSignal(control, "down", performance.now());
    const interpretation = input.consume(signal);
    if (interpretation.kind !== "symbol") return;
    const timing = target === "session" ? trainingStateRef.current?.snapshot.definition.timing : undefined;
    const audio = await ensureAudio(timing);
    if (audio) void audio.playTone(interpretation.durationMs).catch(() => setAudioState("error"));
    if (target !== "keyer" && !keepMeterLive) stopPressMeter(interpretation.durationMs);
    if (target === "session") appendSessionSymbol(interpretation.symbol);
    else if (target === "learn") appendLearnSymbol(interpretation.symbol);
    else appendSymbol(interpretation.symbol);
    setSamples((value) => [
      { duration: Math.round(interpretation.durationMs), symbol: interpretation.symbol, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) },
      ...value,
    ].slice(0, 8));
  }, [appendLearnSymbol, appendSessionSymbol, appendSymbol, ensureAudio, getInputEngine, stopPressMeter]);

  const startDirectSymbol = useCallback((symbol: "." | "-", source: "keyboard" | "pointer", target: "session" | "learn") => {
    setIsPressing(true);
    startPressMeter();
    void tapSymbol(symbol, source, target, true);
  }, [startPressMeter, tapSymbol]);

  const finishDirectSymbol = useCallback(() => {
    setIsPressing(false);
    finishPressMeter();
  }, [finishPressMeter]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const sessionKeying = view === "session" && sessionMode === "character-to-keying" && trainingState?.snapshot.status === "answering";
      const learningKeyer = view === "learn";
      if ((!freeKeyer && !sessionKeying && !learningKeyer) || isEditableTarget(event.target) || event.repeat) return;
      const target = sessionKeying ? "session" : learningKeyer ? "learn" : "keyer";
      if (keyMode === "single" && event.code === bindings.single) {
        event.preventDefault();
        void startLiveTone("keyboard", target);
      }
      if (keyMode === "dual" && event.code === bindings.dot) {
        event.preventDefault();
        if (target === "keyer") void tapSymbol(".", "keyboard", target);
        else startDirectSymbol(".", "keyboard", target);
      }
      if (keyMode === "dual" && event.code === bindings.dash) {
        event.preventDefault();
        if (target === "keyer") void tapSymbol("-", "keyboard", target);
        else startDirectSymbol("-", "keyboard", target);
      }
      if (freeKeyer && event.code === bindings.delete) {
        event.preventDefault();
        deleteOutput();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const sessionKeying = view === "session" && sessionMode === "character-to-keying";
      const learningKeyer = view === "learn";
      if ((freeKeyer || sessionKeying || learningKeyer) && keyMode === "single" && event.code === bindings.single) {
        event.preventDefault();
        stopLiveTone("keyboard");
      }
      if ((sessionKeying || learningKeyer) && keyMode === "dual" && (event.code === bindings.dot || event.code === bindings.dash)) {
        event.preventDefault();
        finishDirectSymbol();
      }
    };
    const release = () => {
      if (keyMode === "dual" && (view === "learn" || (view === "session" && sessionMode === "character-to-keying"))) finishDirectSymbol();
      else stopLiveTone("keyboard", true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [bindings, deleteOutput, finishDirectSymbol, freeKeyer, keyMode, sessionMode, startDirectSymbol, startLiveTone, stopLiveTone, tapSymbol, trainingState?.snapshot.status, view]);

  useEffect(() => {
    if (view !== "learn" || !learnCode || isPressing) return;
    const timer = window.setTimeout(() => {
      learnEvaluationTimerRef.current = null;
      const result = learnCode === MORSE[activeCharacter] ? "correct" : "error";
      setLearnCode("");
      setPressElapsedMs(0);
      setLearnResult(result);
      if (learnResultTimerRef.current) clearTimeout(learnResultTimerRef.current);
      learnResultTimerRef.current = window.setTimeout(() => {
        learnResultTimerRef.current = null;
        setLearnResult(null);
      }, 1100);
    }, Math.max(650, characterGapMs));
    learnEvaluationTimerRef.current = timer;
    return () => {
      if (learnEvaluationTimerRef.current === timer) {
        clearTimeout(timer);
        learnEvaluationTimerRef.current = null;
      }
    };
  }, [activeCharacter, characterGapMs, isPressing, learnCode, view]);

  const getRepository = useCallback(async () => {
    if (!repositoryRef.current) repositoryRef.current = createSessionRepository();
    await repositoryRef.current.initialize();
    return repositoryRef.current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getRepository()
      .then(async (repository) => Promise.all([
        repository.getLatestRecoverableSession(),
        repository.getCharacterStats(),
        repository.getRecentSessions(50),
        repository.getLatestCompletedSession(),
        repository.getSetting<unknown>("preferences"),
      ]))
      .then(([stored, stats, sessions, latest, saved]) => {
        if (cancelled) return;
        if (stored) setRecoverableState(restoreTrainingSession(stored.snapshot, stored.attempts));
        if (latest) setLatestResultState(restoreTrainingSession(latest.snapshot, latest.attempts));
        setCharacterStats(stats);
        setRecentSessions(sessions);
        if (saved) {
          const preferences = sanitizePreferences(saved);
          setFrequency(preferences.frequency);
          setWpm(preferences.wpm);
          setEffectiveWpm(preferences.effectiveWpm);
          setVolume(preferences.volume);
          setWaveform(preferences.waveform);
          setKeyMode(preferences.keyMode);
          setThresholdUnits(preferences.thresholdUnits);
          setCommitGapUnits(preferences.commitGapUnits);
          setQuestionCount(preferences.questionCount);
          setPracticeCharacters(preferences.practiceCharacters);
          setShuffleQuestions(preferences.shuffle);
          setTimeoutMs(preferences.timeoutMs);
          setBindings(preferences.bindings);
        }
        setPreferencesLoaded(true);
        setStorageState("ready");
      })
      .catch(() => {
        if (!cancelled) setStorageState("error");
      });
    return () => {
      cancelled = true;
      const repository = repositoryRef.current;
      repositoryRef.current = null;
      repository?.close();
    };
  }, [getRepository]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    const timer = window.setTimeout(() => {
      const preferences: AppPreferences = {
        frequency, wpm, effectiveWpm, volume, waveform, keyMode, thresholdUnits, commitGapUnits,
        questionCount, practiceCharacters, shuffle: shuffleQuestions, timeoutMs, bindings,
      };
      void getRepository().then((repository) => repository.saveSetting("preferences", preferences)).catch(() => setStorageState("error"));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [bindings, commitGapUnits, effectiveWpm, frequency, getRepository, keyMode, practiceCharacters, preferencesLoaded, questionCount, shuffleQuestions, thresholdUnits, timeoutMs, volume, waveform, wpm]);

  useEffect(() => {
    const sessionId = route.sessionId ?? route.resultSessionId;
    if (!sessionId || storageState !== "ready") return;
    let cancelled = false;
    void getRepository().then((repository) => {
      if (!cancelled) setRouteMessage("");
      return repository.loadSession(sessionId);
    }).then((stored) => {
      if (cancelled) return;
      if (!stored) {
        setRouteMessage("没有在这台设备上找到该练习记录。它可能已被清除，或来自另一台设备。");
        return;
      }
      let restored = restoreTrainingSession(stored.snapshot, stored.attempts);
      if (route.sessionId) {
        const now = new Date().toISOString();
        if (restored.snapshot.status === "answering") restored = interruptTraining(restored, now);
        if (restored.snapshot.status === "interrupted") restored = resumeTraining(restored, now);
        if (restored.snapshot.status === "prompting") restored = markPromptComplete(restored, now);
        if (restored.snapshot.updatedAt !== stored.snapshot.updatedAt || restored.snapshot.status !== stored.snapshot.status) {
          void getRepository().then((repository) => repository.saveSession(restored.snapshot)).catch(() => setStorageState("error"));
        }
      }
      setTrainingState(restored);
      if (stored.snapshot.status === "completed") setLatestResultState(restored);
      setSessionCode("");
      setTypedAnswer("");
      setLastSummary(stored.snapshot.summary);
      if (route.sessionId && stored.snapshot.status === "completed") {
        goTo(`/training/result/${encodeURIComponent(sessionId)}`, true);
      }
    }).catch(() => setRouteMessage("读取本地练习记录时发生错误，请返回练习中心重试。"));
    return () => { cancelled = true; };
  }, [getRepository, goTo, route.resultSessionId, route.sessionId, storageState]);

  useEffect(() => () => {
    clearCommitTimers();
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    if (pressFrameRef.current !== null) window.cancelAnimationFrame(pressFrameRef.current);
    if (learnEvaluationTimerRef.current) clearTimeout(learnEvaluationTimerRef.current);
    if (learnResultTimerRef.current) clearTimeout(learnResultTimerRef.current);
    if (audioEngineRef.current) void audioEngineRef.current.close();
  }, [clearCommitTimers]);

  const navigate = (next: PrimaryView | "progress" | "settings") => {
    stopPlayback();
    stopLiveTone("pointer", true);
    if (
      view === "session" &&
      trainingState &&
      (trainingState.snapshot.status === "prompting" || trainingState.snapshot.status === "answering")
    ) {
      const interrupted = interruptTraining(trainingState, new Date().toISOString());
      setTrainingState(interrupted);
      setRecoverableState(interrupted);
      void getRepository().then((repository) => repository.saveSession(interrupted.snapshot)).catch(() => setStorageState("error"));
    } else if (
      view === "session" &&
      trainingState &&
      ["feedback", "paused", "interrupted"].includes(trainingState.snapshot.status)
    ) {
      setRecoverableState(trainingState);
    }
    goTo(pathForView(next));
  };

  const startSession = async (presetId: TrainingPresetId = "receive.character.audio", characterOverride?: string[], guidedLessonId?: string) => {
    if (sessionStartPendingRef.current) return;
    sessionStartPendingRef.current = true;
    try {
      const now = new Date().toISOString();
      const sessionId = crypto.randomUUID();
      const parsedCharacters = characterOverride ?? parsePracticeCharacters(practiceCharacters);
      const unsupportedCharacters = characterOverride ? [] : [...new Set(Array.from(practiceCharacters.toUpperCase()).filter((character) => !/\s/.test(character) && !MORSE[character]))];
      if (presetId !== "review.mistakes" && unsupportedCharacters.length > 0) {
        setPracticeError(`暂不支持：${unsupportedCharacters.join(" ")}。请删除后再开始练习。`);
        return;
      }
      if (presetId !== "review.mistakes" && parsedCharacters.length === 0) {
        setPracticeError("请输入至少一个受支持的字符；可以直接输入字母、数字或标点。");
        return;
      }
      const defaultDefinition: PracticeDefinition = {
        schemaVersion: DATA_SCHEMA_VERSION,
        mode: PRACTICE_MODE_MAP[presetId],
        characters: parsedCharacters.slice(0, 24),
        questionCount: guidedLessonId ? 8 : questionCount,
        seed: crypto.randomUUID(),
        timing: {
          characterWpm: wpm,
          effectiveWpm,
          frequencyHz: frequency,
          waveform,
          volume,
        },
        timeoutMs,
        feedbackMode: "immediate" as const,
        shuffle: shuffleQuestions,
        guidedLessonId,
      };
      let definition = defaultDefinition;
      if (presetId === "review.mistakes") {
        const currentWithMistakes = trainingState?.attempts.some((attempt) => !attempt.correct) ? trainingState : null;
        const stored = currentWithMistakes ? null : await (await getRepository()).getLatestCompletedSession(true);
        const source = currentWithMistakes ?? (stored ? restoreTrainingSession(stored.snapshot, stored.attempts) : null);
        if (!source) {
          setPracticeError("还没有可重练的错题。先完成一轮练习并答错至少一题吧。");
          return;
        }
        definition = createMistakePracticeDefinition(source, crypto.randomUUID());
      }
      let next = createTrainingSession(definition, { sessionId, now });
      next = startTraining(next, now);
      next = markPromptComplete(next, now);
      const repository = await getRepository();
      await repository.createSession(next.snapshot);
      setTrainingState(next);
      trainingStateRef.current = next;
      setRecoverableState(null);
      setLastSummary(null);
      setPracticeError("");
      setSessionCode("");
      setPressElapsedMs(0);
      setTypedAnswer("");
      setStorageState("ready");
      goTo(`/training/session/${encodeURIComponent(sessionId)}`);
    } catch {
      setStorageState("error");
      setPracticeError("无法创建练习，请检查本地存储后重试。");
    } finally {
      sessionStartPendingRef.current = false;
    }
  };

  const resumeSavedSession = async () => {
    if (!recoverableState || sessionStartPendingRef.current) return;
    sessionStartPendingRef.current = true;
    try {
      const now = new Date().toISOString();
      let next = recoverableState;
      if (next.snapshot.status === "preparing") next = startTraining(next, now);
      if (next.snapshot.status === "answering") next = interruptTraining(next, now);
      if (next.snapshot.status === "paused" || next.snapshot.status === "interrupted") next = resumeTraining(next, now);
      if (next.snapshot.status === "prompting") next = markPromptComplete(next, now);
      await (await getRepository()).saveSession(next.snapshot);
      setTrainingState(next);
      setRecoverableState(null);
      goTo(`/training/session/${encodeURIComponent(next.snapshot.id)}`);
    } catch {
      setStorageState("error");
    } finally {
      sessionStartPendingRef.current = false;
    }
  };

  const answerQuestion = async (answer: string, timingScore: number | null = null) => {
    const active = trainingStateRef.current;
    if (!active || active.snapshot.status !== "answering" || answerPendingRef.current) return;
    answerPendingRef.current = true;
    try {
      const result = submitTrainingAnswer(active, answer, new Date().toISOString(), timingScore);
      await (await getRepository()).saveAttemptAndSession(result.attempt, result.state.snapshot);
      trainingStateRef.current = result.state;
      setTrainingState(result.state);
    } catch {
      setStorageState("error");
    } finally {
      answerPendingRef.current = false;
    }
  };

  const nextQuestion = async () => {
    const active = trainingStateRef.current;
    if (!active || active.snapshot.status !== "feedback" || advancePendingRef.current) return;
    advancePendingRef.current = true;
    try {
      const now = new Date().toISOString();
      let next = advanceTraining(active, now);
      if (next.snapshot.status === "completed") {
        await (await getRepository()).saveSession(next.snapshot);
        setLastSummary(next.snapshot.summary);
        setLatestResultState(next);
        setRecoverableState(null);
        trainingStateRef.current = next;
        setTrainingState(next);
        const repository = await getRepository();
        const [stats, sessions] = await Promise.all([repository.getCharacterStats(), repository.getRecentSessions(7)]);
        setCharacterStats(stats);
        setRecentSessions(sessions);
        goTo(`/training/result/${encodeURIComponent(next.snapshot.id)}`);
        return;
      }
      next = markPromptComplete(next, now);
      await (await getRepository()).saveSession(next.snapshot);
      trainingStateRef.current = next;
      setTrainingState(next);
      setSessionCode("");
      setPressElapsedMs(0);
      setTypedAnswer("");
    } catch {
      setStorageState("error");
    } finally {
      advancePendingRef.current = false;
    }
  };

  const toggleSessionPause = async () => {
    if (!trainingState) return;
    try {
      const now = new Date().toISOString();
      let next = trainingState;
      if (next.snapshot.status === "paused") {
        next = markPromptComplete(resumeTraining(next, now), now);
      } else if (next.snapshot.status === "prompting" || next.snapshot.status === "answering") {
        stopPlayback();
        stopLiveTone("pointer", true);
        next = pauseTraining(next, now);
      } else {
        return;
      }
      await (await getRepository()).saveSession(next.snapshot);
      setTrainingState(next);
    } catch {
      setStorageState("error");
    }
  };

  const playSessionPrompt = async () => {
    if (!trainingState || !currentQuestion) return;
    let next = trainingState;
    if (next.snapshot.status === "prompting" || next.snapshot.status === "answering") {
      next = recordReplay(next, new Date().toISOString());
      trainingStateRef.current = next;
      setTrainingState(next);
      void getRepository().then((repository) => repository.saveSession(next.snapshot)).catch(() => setStorageState("error"));
    }
    if (sessionMode === "sound-to-character") await playText(currentQuestion.target, next.snapshot.definition.timing);
  };

  const submitKeyingAnswer = async () => {
    if (!sessionCode) return;
    const decodedCharacter = REVERSE_MORSE[sessionCode] ?? "?";
    const expected = currentQuestion ? MORSE[currentQuestion.target] : "";
    const lengthDelta = Math.abs(sessionCode.length - expected.length);
    const timingScore = sessionCode === expected ? 1 : Math.max(0, 1 - lengthDelta / Math.max(expected.length, 1));
    await answerQuestion(decodedCharacter, timingScore);
  };

  const leaveSession = async (saveForLater: boolean) => {
    if (!trainingState) return;
    try {
      stopPlayback();
      stopLiveTone("pointer", true);
      let next = trainingState;
      const now = new Date().toISOString();
      if (saveForLater) {
        if (next.snapshot.status === "prompting" || next.snapshot.status === "answering") next = interruptTraining(next, now);
        setRecoverableState(next);
      } else if (!saveForLater && !["completed", "abandoned"].includes(next.snapshot.status)) {
        next = abandonTraining(next, now);
        setRecoverableState(null);
      }
      await (await getRepository()).saveSession(next.snapshot);
      trainingStateRef.current = next;
      setTrainingState(next);
      setShowExitConfirm(false);
      goTo(domainPathForMode(next.snapshot.definition.mode));
    } catch {
      setStorageState("error");
    }
  };

  const exportLearningData = async () => {
    try {
      const payload = await (await getRepository()).exportData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `morse-learning-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setDataMessage("数据已导出。");
    } catch {
      setDataMessage("导出失败，请稍后重试。");
    }
  };

  const importLearningData = async (file: File) => {
    try {
      if (file.size > 20 * 1024 * 1024) {
        setDataMessage("无法导入：文件超过 20 MB 限制。");
        return;
      }
      setPreferencesLoaded(false);
      const payload = JSON.parse(await file.text()) as LearningMorseExport;
      await (await getRepository()).importData(payload);
      setDataMessage("导入完成，页面将重新载入。");
      window.setTimeout(() => window.location.reload(), 500);
    } catch {
      setPreferencesLoaded(true);
      setDataMessage("无法导入：文件格式或版本不受支持。");
    }
  };

  const clearLearningData = async () => {
    if (!window.confirm("确定清空本机的练习记录、统计和设置吗？此操作无法撤销。")) return;
    try {
      setPreferencesLoaded(false);
      await (await getRepository()).clearAll();
      window.localStorage.removeItem("morse-v2-onboarding-complete");
      window.localStorage.removeItem("morse-v2-theme");
      setDataMessage("本地数据已清空，页面将重新载入。");
      window.setTimeout(() => window.location.reload(), 500);
    } catch {
      setPreferencesLoaded(true);
      setDataMessage("清空失败，请稍后重试。");
    }
  };

  useEffect(() => {
    sessionActionsRef.current = {
      pause: () => { void toggleSessionPause(); },
      replay: () => { void playSessionPrompt(); },
      submit: () => { void submitKeyingAnswer(); },
      timeout: () => { void answerQuestion(""); },
    };
  });

  useEffect(() => {
    const onActionKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.repeat) return;
      if (view === "session" && event.code === bindings.pause) {
        event.preventDefault();
        sessionActionsRef.current.pause();
      } else if (view === "session" && event.code === bindings.replay && sessionMode === "sound-to-character") {
        event.preventDefault();
        sessionActionsRef.current.replay();
      } else if (view === "session" && event.code === bindings.submit && sessionMode === "character-to-keying") {
        event.preventDefault();
        sessionActionsRef.current.submit();
      } else if (view === "session" && event.code === bindings.delete && sessionMode === "character-to-keying") {
        event.preventDefault();
        setSessionCode((value) => value.slice(0, -1));
      } else if (freeKeyer && event.code === bindings.replay && decoded) {
        event.preventDefault();
        void playText(decoded);
      }
    };
    window.addEventListener("keydown", onActionKey);
    return () => window.removeEventListener("keydown", onActionKey);
  }, [bindings, decoded, freeKeyer, playText, sessionMode, view]);

  useEffect(() => {
    const configuredTimeout = trainingState?.snapshot.definition.timeoutMs;
    if (view !== "session" || trainingState?.snapshot.status !== "answering" || !configuredTimeout) return;
    const timer = window.setTimeout(() => sessionActionsRef.current.timeout(), configuredTimeout);
    return () => window.clearTimeout(timer);
  }, [sessionStep, trainingState?.snapshot.definition.timeoutMs, trainingState?.snapshot.status, view]);

  const characterGroups = useMemo(() => Object.keys(MORSE).filter((character) => {
    if (learnFilter === "letters") return /^[A-Z]$/.test(character);
    if (learnFilter === "numbers") return /^\d$/.test(character);
    return !/^[A-Z0-9]$/.test(character);
  }), [learnFilter]);
  const completedSessions = useMemo(
    () => recentSessions.filter((session) => session.status === "completed" && session.summary),
    [recentSessions],
  );
  const guidedCompletedIds = useMemo(() => new Set(completedSessions
    .filter((session) => session.definition.guidedLessonId && (session.summary?.accuracy ?? 0) >= 0.8)
    .map((session) => session.definition.guidedLessonId as string)), [completedSessions]);
  const firstIncompleteGuidedIndex = GUIDED_LESSONS.findIndex((lesson) => !guidedCompletedIds.has(lesson.id));
  const guidedUnlockedIndex = firstIncompleteGuidedIndex === -1 ? GUIDED_LESSONS.length - 1 : firstIncompleteGuidedIndex;
  const latestState = trainingState?.snapshot.status === "completed" ? trainingState : latestResultState;
  const latestSummary = lastSummary ?? latestState?.snapshot.summary ?? completedSessions[0]?.summary ?? null;
  const latestMistakes = latestState?.attempts.filter((attempt) => !attempt.correct) ?? [];
  const latestDurationMs = latestState?.snapshot.completedAt
    ? Date.parse(latestState.snapshot.completedAt) - Date.parse(latestState.snapshot.startedAt)
    : 0;
  const trend = completedSessions.slice(0, 12).reverse().map((session) => Math.round((session.summary?.accuracy ?? 0) * 100));
  const aggregatedCharacterStats = useMemo(() => {
    const totals = new Map<string, CharacterStatRecord>();
    for (const stat of characterStats) {
      const current = totals.get(stat.character);
      if (!current) totals.set(stat.character, { ...stat, id: stat.character });
      else totals.set(stat.character, {
        ...current,
        attempts: current.attempts + stat.attempts,
        correct: current.correct + stat.correct,
        totalReactionMs: current.totalReactionMs + stat.totalReactionMs,
        lastPracticedAt: current.lastPracticedAt > stat.lastPracticedAt ? current.lastPracticedAt : stat.lastPracticedAt,
      });
    }
    return [...totals.values()];
  }, [characterStats]);
  const weakestCharacters = useMemo(
    () => aggregatedCharacterStats
      .filter((stat) => stat.attempts >= 3)
      .sort((left, right) => ((left.correct + 1) / (left.attempts + 2)) - ((right.correct + 1) / (right.attempts + 2)))
      .slice(0, 3),
    [aggregatedCharacterStats],
  );
  const activeCharacterStat = aggregatedCharacterStats.find((stat) => stat.character === activeCharacter) ?? null;
  const activeGuidedLesson = GUIDED_LESSONS.find((lesson) => lesson.id === trainingState?.snapshot.definition.guidedLessonId) ?? null;
  const toolEncoded = toolText.trim() ? encodeText(toolText) : "";
  const toolDecoded = toolCode.trim() ? decodeText(toolCode) : "";
  const learnInputState = learnCode === ""
    ? learnResult === "correct"
      ? { label: "输入正确 · 已清空", tone: "success" }
      : learnResult === "error"
        ? { label: "输入错误 · 已清空", tone: "error" }
        : { label: "等待输入", tone: "idle" }
    : MORSE[activeCharacter].startsWith(learnCode) && learnCode !== MORSE[activeCharacter]
      ? { label: "继续输入", tone: "progress" }
      : { label: `停顿 ${Math.round(Math.max(650, characterGapMs))} ms 后判定`, tone: "progress" };

  const activePrimaryView: PrimaryView | null = NAV.some((item) => item.id === view)
    ? view as PrimaryView
    : view === "setup"
      ? domainForPreset(route.presetId)
      : null;

  const pageTitle: Record<AppView, string> = {
    onboarding: "欢迎来到 Morse Lab",
    home: "今天练什么？",
    learn: "基础学习与识别",
    receive: "听抄与接收训练",
    send: route.path === "/send/free" ? "自由拍发练习" : "发报与节奏训练",
    tools: "查询与转换工具",
    setup: "训练设置",
    session: "专注练习",
    progress: route.resultSessionId ? "训练结果" : "学习进度",
    settings: "偏好设置",
    "not-found": "页面未找到",
  };

  const settingsSections: { id: SettingsSection; label: string }[] = [
    { id: "appearance", label: "外观" },
    { id: "audio", label: "音频" },
    { id: "input", label: "输入与按键" },
    { id: "training", label: "训练默认值" },
    { id: "data", label: "数据与隐私" },
    { id: "about", label: "关于与帮助" },
  ];
  const settingsSection = route.settingsSection ?? "appearance";
  const settingsMeta: Record<SettingsSection, { eyebrow: string; title: string; copy: string }> = {
    appearance: { eyebrow: "APPEARANCE", title: "主题与显示", copy: "选择适合当前环境的主题，设置会保存在本机。" },
    audio: { eyebrow: "AUDIO", title: "音频默认值", copy: "调整练习、演示与发报共用的音频参数。" },
    input: { eyebrow: "INPUT", title: "输入与按键", copy: "单键时长或点划双键，触摸与键盘都可使用。" },
    training: { eyebrow: "TRAINING", title: "训练默认值", copy: "定义新练习默认使用的速度、题量和字符组。" },
    data: { eyebrow: "DATA & PRIVACY", title: "数据与隐私", copy: "训练记录保存在浏览器 IndexedDB 中，不会自动上传。" },
    about: { eyebrow: "ABOUT", title: "关于 Morse Lab", copy: "一个声音优先、本地优先、可离线使用的 Morse Code 学习工具。" },
  };

  return (
    <div className={view === "session" ? "prototype session-prototype" : "prototype"} data-theme={theme}>
      {view !== "session" && <aside className="side-rail" aria-label="主导航">
        <button className="brand" onClick={() => navigate("home")} aria-label="返回首页">
          <span className="brand-signal">·—</span>
          <span><strong>MORSE</strong><small>LEARNING LAB</small></span>
        </button>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={activePrimaryView === item.id ? "nav-item active" : "nav-item"}
              onClick={() => navigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <button className={view === "progress" ? "nav-item active" : "nav-item"} onClick={() => navigate("progress")}>
            进度
          </button>
          <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={() => navigate("settings")}>
            设置
          </button>
          <p>V2 FOUNDATION · 0.4.3</p>
        </div>
      </aside>}

      <main className={view === "session" ? "main session-main" : "main"}>
        <header className="topbar">
          <div>
            <p className="eyebrow">RESEARCH BUILD · 本地优先</p>
            <h1>{pageTitle[view]}</h1>
          </div>
          <div className="top-actions">
            <span className={`status ${audioState}`}>声音 {audioState === "ready" ? "已就绪" : audioState === "error" ? "异常" : "待启用"}</span>
            {view !== "session" && <button className="icon-button" onClick={() => navigate("settings")} aria-label="打开设置">设置</button>}
          </div>
        </header>

        <PwaStatus hasActiveSession={view === "session" && Boolean(trainingState) && trainingState?.snapshot.status !== "completed"} />

        {view === "onboarding" && (
          <section className="onboarding card">
            <p className="section-label">FIRST SIGNAL · {onboardingStep + 1} / 3</p>
            <div className="onboarding-mark" aria-hidden="true">{onboardingStep === 0 ? "· —" : onboardingStep === 1 ? "· · ·" : "SPACE"}</div>
            <h2>{onboardingStep === 0 ? "点短，划长" : onboardingStep === 1 ? "声音与字符是一种反射" : "停顿也是 Morse 的一部分"}</h2>
            <p>{onboardingStep === 0 ? "点持续 1 个时间单位，划持续 3 个单位。按下下面的按钮，先用耳朵感受 E（点）和 T（划）。" : onboardingStep === 1 ? "练习会从声音、点划、字符和真实发报四个方向建立连接。播放 S，感受三个均匀的短信号。" : "元素间隔 1 单位、字符间隔 3 单位、单词间隔 7 单位。自由发报时，应用会根据停顿自动提交字符和单词。"}</p>
            {onboardingStep < 2 && <button className="secondary" onClick={() => void playText(onboardingStep === 0 ? "ET" : "S")}>{isPlaying ? "播放中…" : "播放声音示范"}</button>}
            <div className="button-row onboarding-actions">
              <button className="text-button" onClick={() => { window.localStorage.setItem("morse-v2-onboarding-complete", "true"); goTo("/home", true); }}>跳过引导</button>
              {onboardingStep < 2
                ? <button className="primary" onClick={() => { stopPlayback(); setOnboardingStep((step) => step + 1); }}>下一步</button>
                : <button className="primary" onClick={() => { window.localStorage.setItem("morse-v2-onboarding-complete", "true"); goTo("/home", true); }}>开始学习</button>}
            </div>
          </section>
        )}

        {view === "not-found" && (
          <section className="route-error card">
            <p className="section-label">404 · LOST SIGNAL</p>
            <h2>这个频率上没有页面</h2>
            <p>这个地址不存在，或属于已删除的旧版页面。V2 不再提供旧 URL 跳转。</p>
            <button className="primary" onClick={() => goTo("/home", true)}>返回首页</button>
          </section>
        )}

        {view === "home" && (
          <div className="page-stack">
            <section className="hero-panel">
              <div>
                <p className="section-label">NEXT SESSION</p>
                <h2>让声音先于点划</h2>
                <p>从听、认、拍、查四条路径进入训练。当前建议先强化 K、M、R、S 的声音反射。</p>
                <div className="button-row">
                  <button className="primary" onClick={() => void startSession("receive.character.audio")}>开始声音识别</button>
                  <button className="secondary" onClick={() => goTo("/send/free")}>打开自由拍发</button>
                </div>
              </div>
              <div className="hero-signal" aria-hidden="true">
                <span>— · —</span>
                <small>K / 20 WPM</small>
              </div>
            </section>

            <section className="metric-strip" aria-label="学习摘要">
              <div><span>已完成练习</span><strong>{completedSessions.length} 轮</strong><small>仅统计本机记录</small></div>
              <div><span>近期正确率</span><strong>{completedSessions.length ? `${Math.round(completedSessions.reduce((sum, session) => sum + (session.summary?.accuracy ?? 0), 0) / completedSessions.length * 100)}%` : "—"}</strong><small>{completedSessions.length ? "来自最近记录" : "完成练习后显示"}</small></div>
              <div><span>当前速度</span><strong>{wpm} / {effectiveWpm}</strong><small>字符 / 有效 WPM</small></div>
              <div><span>需要加强</span><strong>{weakestCharacters.map((stat) => stat.character).join(" ") || "待积累"}</strong><small>根据真实作答计算</small></div>
            </section>

            <section>
              <div className="section-heading"><div><p className="section-label">FOUR DOMAINS</p><h2>四个专业功能域</h2></div><button className="text-button" onClick={() => navigate("progress")}>查看进度 →</button></div>
              <div className="mode-grid">
                {DOMAIN_CARDS.map((mode) => (
                  <button className="mode-card" key={mode.domain} onClick={() => navigate(mode.domain)}>
                    <span className="mode-mark">{mode.eyebrow}</span>
                    <span><strong>{mode.title}</strong><small>{mode.copy}</small></span>
                    <span className="arrow">↗</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}

        {view === "learn" && (
          <div className="page-stack">
            <section className="intro-row"><div><p className="section-label">FOUNDATION & RECOGNITION</p><h2>先建立字符，再建立反射</h2><p>按课程认识节奏，也可以直接浏览字母、数字与标点，并在学习页实时按键跟拍。</p></div><div className="button-row"><button className="primary" onClick={() => goTo("/training/setup/learn.character.decode")}>Morse → 字符</button><button className="secondary" onClick={() => goTo("/training/setup/learn.character.encode")}>字符 → Morse</button></div></section>
            <section className="guided-course card">
              <div className="guided-course-intro"><div><p className="section-label">BEGINNER RHYTHM COURSE</p><h2>新手基础练习</h2><p>每课认识两个节奏；达到 80% 后解锁下一组。</p></div><div className="guided-course-summary"><strong>{guidedCompletedIds.size} / {GUIDED_LESSONS.length}</strong><span>已掌握课程</span><button className="text-button" onClick={() => setShowGuidedHints((value) => !value)}>{showGuidedHints ? "关闭视觉提示" : "开启视觉提示"}</button></div></div>
              <div className="guided-lesson-track">{GUIDED_LESSONS.map((lesson, index) => { const completed = guidedCompletedIds.has(lesson.id); const locked = index > guidedUnlockedIndex; return <article key={lesson.id} className={completed ? "guided-lesson completed" : locked ? "guided-lesson locked" : "guided-lesson active"}><div className="guided-lesson-number">{completed ? "✓" : locked ? "锁" : String(index + 1).padStart(2, "0")}</div><span>{lesson.title}</span><strong>{lesson.characters.join(" · ")}</strong>{showGuidedHints && <small>{lesson.characters.map((character) => formatCode(MORSE[character])).join(" / ")}</small>}<button className={completed ? "secondary small" : "primary"} disabled={locked} onClick={() => void startSession("send.character.guided", [...lesson.characters], lesson.id)}>{completed ? "再练一次" : locked ? "完成上一课后解锁" : "开始 8 题"}</button></article>; })}</div>
            </section>
            <div className="learn-layout">
            <section className="card character-browser">
              <div className="section-heading compact"><div><p className="section-label">REFERENCE</p><h2>国际 Morse 字符</h2></div><span className="count">{characterGroups.length} / {Object.keys(MORSE).length}</span></div>
              <div className="filter-row" aria-label="字符分类">
                <button className={learnFilter === "letters" ? "chip active" : "chip"} aria-pressed={learnFilter === "letters"} onClick={() => { setLearnFilter("letters"); setLearnCode(""); setLearnResult(null); setPressElapsedMs(0); goTo("/learn/character/K"); }}>字母</button>
                <button className={learnFilter === "numbers" ? "chip active" : "chip"} aria-pressed={learnFilter === "numbers"} onClick={() => { setLearnFilter("numbers"); setLearnCode(""); setLearnResult(null); setPressElapsedMs(0); goTo("/learn/character/0"); }}>数字</button>
                <button className={learnFilter === "punctuation" ? "chip active" : "chip"} aria-pressed={learnFilter === "punctuation"} onClick={() => { setLearnFilter("punctuation"); setLearnCode(""); setLearnResult(null); setPressElapsedMs(0); goTo("/learn/character/."); }}>标点</button>
              </div>
              <div className="character-grid">
                {characterGroups.map((character) => (
                  <button key={character} className={activeCharacter === character ? "character active" : "character"} onClick={() => { stopPlayback(); setLearnCode(""); setLearnResult(null); setPressElapsedMs(0); goTo(`/learn/character/${encodeURIComponent(character)}`); }}>
                    <strong>{character}</strong><span>{formatCode(MORSE[character])}</span>
                  </button>
                ))}
              </div>
            </section>
            <aside className="card character-detail">
              <p className="section-label">CHARACTER DETAIL</p>
              <div className="big-character">{activeCharacter}</div>
              <div className="big-code">{formatCode(MORSE[activeCharacter])}</div>
              <div className="timing-line" aria-hidden="true">
                {MORSE[activeCharacter].split("").map((symbol, index) => <i key={index} className={symbol === "-" ? "dash" : "dot"} />)}
              </div>
              <button className="primary full" onClick={() => void playText(activeCharacter)}>{isPlaying ? "播放中…" : "播放字符"}</button>
              <button className="secondary full" onClick={() => void startSession("receive.character.audio", [activeCharacter])}>只听这个字符</button>
              <section className="learn-keyer" aria-labelledby="learn-keyer-title">
                <div className="learn-keyer-heading">
                  <span id="learn-keyer-title">按键练习</span>
                  <strong className={learnInputState.tone} aria-live="polite">{learnInputState.label}</strong>
                </div>
                <div className={`learn-code-input ${learnInputState.tone}`} aria-label={`当前输入：${learnCode ? formatCode(learnCode) : "空"}`}>
                  {learnCode ? formatCode(learnCode) : learnResult === "correct" ? "✓ 可继续输入" : learnResult === "error" ? `× 正确：${formatCode(MORSE[activeCharacter])}` : "等待输入…"}
                </div>
                <KeyDurationGuide ref={durationGuideRef} elapsedMs={pressElapsedMs} thresholdMs={thresholdMs} dotMs={dotMs} pressing={isPressing} />
                {keyMode === "single" ? (
                  <button
                    className={isPressing ? "key-pad learn-pad pressing" : "key-pad learn-pad"}
                    onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); void startLiveTone("pointer", "learn"); }}
                    onPointerUp={() => stopLiveTone("pointer")}
                    onPointerCancel={() => stopLiveTone("pointer", true)}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    <span>{isPressing ? "正在发声" : "按住发报"}</span>
                    <small>{bindings.single} · 短按点，长按划</small>
                  </button>
                ) : (
                  <div className="dual-pads learn-pads">
                    <button className="key-pad learn-pad" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); startDirectSymbol(".", "pointer", "learn"); }} onPointerUp={finishDirectSymbol} onPointerCancel={finishDirectSymbol} onClick={(event) => { if (event.detail === 0) void tapSymbol(".", "pointer", "learn"); }}><span>点 ·</span><small>{bindings.dot}</small></button>
                    <button className="key-pad learn-pad" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); startDirectSymbol("-", "pointer", "learn"); }} onPointerUp={finishDirectSymbol} onPointerCancel={finishDirectSymbol} onClick={(event) => { if (event.detail === 0) void tapSymbol("-", "pointer", "learn"); }}><span>划 —</span><small>{bindings.dash}</small></button>
                  </div>
                )}
                <small className="learn-auto-note">停止输入 {Math.round(Math.max(650, characterGapMs))} ms 后自动判定并清空</small>
              </section>
              <div className="detail-note"><span>字符速度</span><strong>{wpm} WPM</strong></div>
              <div className="detail-note"><span>近期表现</span><strong>{activeCharacterStat ? `${Math.round(activeCharacterStat.correct / activeCharacterStat.attempts * 100)}% · ${activeCharacterStat.attempts} 次` : "暂无记录"}</strong></div>
            </aside>
            </div>
          </div>
        )}

        {view === "receive" && (
          <div className="page-stack">
            <section className="intro-row"><div><p className="section-label">COPY & RECEIVE</p><h2>让耳朵直接抵达字符</h2><p>当前先提供成熟的字符抄报与随机字符组训练；词组、长文和数字短码将沿用同一训练引擎逐步扩展。</p></div><button className="secondary" onClick={() => void startSession("review.mistakes")}>重练最近错题</button></section>
            {practiceError && <p className="inline-error" role="alert">{practiceError}</p>}
            {recoverableState && <section className="intro-row"><div><p className="section-label">SESSION RECOVERY</p><h2>发现未完成训练</h2><p>已保存到第 {recoverableState.snapshot.currentQuestionIndex + 1} 题，可从当前题恢复。</p></div><button className="primary" onClick={() => void resumeSavedSession()}>继续训练</button></section>}
            <div className="practice-grid">
              <article className="practice-card"><div className="practice-index">01</div><p className="section-label">CHARACTER COPY</p><h2>字母抄报练习</h2><p>听单个字符并输入答案，建立声音与字符的直接反射。</p><dl><div><dt>题量</dt><dd>{questionCount}</dd></div><div><dt>速度</dt><dd>{wpm} / {effectiveWpm}</dd></div><div><dt>字符</dt><dd>{practiceCharacters}</dd></div></dl><div className="button-row"><button className="primary" onClick={() => void startSession("receive.character.audio")}>快速开始</button><button className="text-button" onClick={() => goTo("/training/setup/receive.character.audio")}>自定义</button></div></article>
              <article className="practice-card"><div className="practice-index">02</div><p className="section-label">RANDOM SET</p><h2>随机字母 / 数字</h2><p>在设置中输入任意受支持字符组，随机生成本轮抄报题目。</p><dl><div><dt>示例</dt><dd>A-Z</dd></div><div><dt>数字</dt><dd>0-9</dd></div><div><dt>反馈</dt><dd>即时</dd></div></dl><div className="button-row"><button className="primary" onClick={() => { setPracticeCharacters("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"); goTo("/training/setup/receive.character.audio"); }}>配置字符组</button></div></article>
            </div>
            <section className="card roadmap-strip"><p className="section-label">RECEIVE ROADMAP</p><h2>下一批专业训练</h2><p>词组抄报、长文抄报、数字短码抄报与自定义发报会共用同一套速度、间隔和结果模型。</p></section>
          </div>
        )}

        {view === "setup" && route.presetId && (
          <div className="page-stack">
            {practiceError && <p className="inline-error" role="alert">{practiceError}</p>}
            <section className="card setup-panel">
              <div><p className="section-label">SESSION SETUP · {route.presetId}</p><h2>自定义本轮训练</h2><p>本轮参数会写入 V2 会话快照；旧版设置与会话不会载入。</p></div>
              <label><span>练习字符</span><input value={practiceCharacters} onChange={(event) => setPracticeCharacters(event.target.value)} placeholder="K M R S" /></label>
              <label><span>题量 <b>{questionCount}</b></span><input type="range" min="4" max="40" step="4" value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))} /></label>
              <label><span>字符速度 <b>{wpm} WPM</b></span><input type="range" min="8" max="40" value={wpm} onChange={(event) => updateWpm(Number(event.target.value))} /></label>
              <label><span>有效速度 <b>{effectiveWpm} WPM</b></span><input type="range" min="5" max={wpm} value={Math.min(effectiveWpm, wpm)} onChange={(event) => setEffectiveWpm(Number(event.target.value))} /></label>
              <label className="checkbox-setting"><input type="checkbox" checked={shuffleQuestions} onChange={(event) => setShuffleQuestions(event.target.checked)} /><span>随机打乱题目</span></label>
              <label><span>每题超时</span><select value={timeoutMs ?? 0} onChange={(event) => setTimeoutMs(Number(event.target.value) || null)}><option value="0">关闭</option><option value="5000">5 秒</option><option value="10000">10 秒</option><option value="15000">15 秒</option></select></label>
              <div className="button-row"><button className="primary" onClick={() => void startSession(route.presetId)}>开始训练</button><button className="secondary" onClick={() => goTo(pathForView(domainForPreset(route.presetId)))}>取消</button></div>
            </section>
          </div>
        )}

        {view === "send" && route.path === "/send" && (
          <div className="page-stack">
            <section className="intro-row"><div><p className="section-label">KEYING & RHYTHM</p><h2>从跟拍到自由拍发</h2><p>按真实按压时长判断点划，实时显示时长与阈值，并使用可调停顿自动提交字符。</p></div><button className="primary" onClick={() => goTo("/send/free")}>进入自由拍发</button></section>
            <div className="practice-grid"><article className="practice-card"><div className="practice-index">01</div><p className="section-label">GUIDED KEYING</p><h2>字符跟拍练习</h2><p>看到目标字符后按键发报，实时观察按压时长并获得即时反馈。</p><div className="button-row"><button className="primary" onClick={() => void startSession("send.character.guided")}>快速开始</button><button className="text-button" onClick={() => goTo("/training/setup/send.character.guided")}>自定义</button></div></article><article className="practice-card"><div className="practice-index">02</div><p className="section-label">FREE KEYER</p><h2>自由拍发练习</h2><p>单键时长或点划双键，支持声音、自动解码、可调提交等待与按压记录。</p><div className="button-row"><button className="primary" onClick={() => goTo("/send/free")}>打开工作台</button></div></article></div>
          </div>
        )}

        {view === "session" && currentQuestion && (
          <section className="session-shell">
            <div className="session-header"><button className="text-button" onClick={() => setShowExitConfirm(true)}>← 结束练习</button><span>{sessionStep + 1} / {questions.length}</span><button className="text-button" onClick={() => void toggleSessionPause()}>{trainingState?.snapshot.status === "paused" ? "继续" : "暂停"}</button></div>
            <div className="progress-track"><i style={{ width: `${((sessionStep + 1) / questions.length) * 100}%` }} /></div>
            <div className="session-prompt">
              <p className="section-label">{sessionMode === "sound-to-character" ? "LISTEN AND IDENTIFY" : sessionMode === "code-to-character" ? "READ AND IDENTIFY" : sessionMode === "character-to-code" ? "ENCODE THE CHARACTER" : "KEY THE CHARACTER"}</p>
              {trainingState?.snapshot.status === "paused" ? <div className="paused-mark">PAUSED</div> : hasSessionAnswer ? <div className="prompt-answer">{currentQuestion.target}<small>{formatCode(MORSE[currentQuestion.target])}</small></div> : <>
                {sessionMode === "sound-to-character" && <button className="play-orb" onClick={() => void playSessionPrompt()} aria-label="播放当前字符" disabled={isPlaying}>{isPlaying ? "■" : "▶"}</button>}
                {sessionMode === "code-to-character" && <div className="code-prompt">{formatCode(MORSE[currentQuestion.target])}</div>}
                {(sessionMode === "character-to-code" || sessionMode === "character-to-keying") && <div className="character-prompt">{currentQuestion.target}</div>}
              </>}
              {activeGuidedLesson && !hasSessionAnswer && <div className="guided-session-cues">
                <div className="guided-session-cue-heading"><span>第 {GUIDED_LESSONS.findIndex((lesson) => lesson.id === activeGuidedLesson.id) + 1} 课 · {activeGuidedLesson.title}</span><button className="text-button" onClick={() => setShowGuidedHints((value) => !value)}>{showGuidedHints ? "隐藏提示" : "显示提示"}</button></div>
                 {showGuidedHints && <div className="guided-cue-grid">{activeGuidedLesson.characters.map((character, index) => <button key={character} className={character === currentQuestion.target ? "current" : ""} onClick={() => void playText(character, sessionTiming)}><strong>{character}</strong><span>{formatCode(MORSE[character])}</span><small>{activeGuidedLesson.cues[index]}</small></button>)}</div>}
                 <button className="secondary small" onClick={() => void playText(currentQuestion.target, sessionTiming)}>听一遍当前节奏</button>
              </div>}
              <h2>{trainingState?.snapshot.status === "paused" ? "练习已暂停" : hasSessionAnswer ? "已提交答案" : sessionMode === "sound-to-character" ? "听声音，选择对应字符" : sessionMode === "code-to-character" ? "这个点划组合对应哪个字符？" : sessionMode === "character-to-code" ? "选择正确的 Morse Code" : activeGuidedLesson ? "跟随提示，发出这个字符" : "用真实按键发出这个字符"}</h2>
              <p>Character {sessionTiming?.characterWpm ?? wpm} WPM · Effective {sessionTiming?.effectiveWpm ?? effectiveWpm} WPM</p>
            </div>
            {(sessionMode === "sound-to-character" || sessionMode === "code-to-character") && !hasSessionAnswer && <form className="typed-answer" onSubmit={(event) => { event.preventDefault(); if (typedAnswer.trim()) void answerQuestion(typedAnswer); }}><label><span>输入字符</span><input value={typedAnswer} maxLength={1} autoCapitalize="characters" autoComplete="off" onChange={(event) => setTypedAnswer(event.target.value.toUpperCase())} disabled={trainingState?.snapshot.status !== "answering"} /></label><button className="secondary" type="submit" disabled={!typedAnswer.trim() || trainingState?.snapshot.status !== "answering"}>提交</button></form>}
            {sessionMode !== "character-to-keying" && <div className="answer-grid">
              {currentQuestion.choices.map((answer) => {
                const state = hasSessionAnswer ? answer === currentQuestion.target ? "correct" : answer === sessionAnswer ? "wrong" : "" : "";
                return <button key={answer} aria-label={sessionMode === "character-to-code" ? `选择 ${formatCode(MORSE[answer])}` : `选择字符 ${answer}`} className={`answer ${state}`} onClick={() => void answerQuestion(answer)} disabled={hasSessionAnswer || trainingState?.snapshot.status !== "answering"}>{sessionMode === "character-to-code" ? formatCode(MORSE[answer]) : answer}</button>;
              })}
            </div>}
            {sessionMode === "character-to-keying" && !hasSessionAnswer && <div className="session-keyer">
              <div className="keying-code" aria-live="polite">{sessionCode ? formatCode(sessionCode) : "等待输入…"}</div>
              <KeyDurationGuide ref={durationGuideRef} elapsedMs={pressElapsedMs} thresholdMs={sessionThresholdMs} dotMs={sessionDotMs} pressing={isPressing} />
              {keyMode === "single" ? <button className={isPressing ? "key-pad compact pressing" : "key-pad compact"} disabled={trainingState?.snapshot.status !== "answering"} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); void startLiveTone("pointer", "session"); }} onPointerUp={() => stopLiveTone("pointer")} onPointerCancel={() => stopLiveTone("pointer", true)}><span>按住发报</span><small>{bindings.single} · 短按点，长按划</small></button> : <div className="dual-pads"><button className="key-pad compact" disabled={trainingState?.snapshot.status !== "answering"} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); startDirectSymbol(".", "pointer", "session"); }} onPointerUp={finishDirectSymbol} onPointerCancel={finishDirectSymbol} onClick={(event) => { if (event.detail === 0) void tapSymbol(".", "pointer", "session"); }}><span>点 ·</span><small>{bindings.dot}</small></button><button className="key-pad compact" disabled={trainingState?.snapshot.status !== "answering"} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); startDirectSymbol("-", "pointer", "session"); }} onPointerUp={finishDirectSymbol} onPointerCancel={finishDirectSymbol} onClick={(event) => { if (event.detail === 0) void tapSymbol("-", "pointer", "session"); }}><span>划 —</span><small>{bindings.dash}</small></button></div>}
              <div className="button-row"><button className="secondary" onClick={() => setSessionCode((value) => value.slice(0, -1))} disabled={!sessionCode}>删除一划</button><button className="primary" onClick={() => void submitKeyingAnswer()} disabled={!sessionCode}>提交发报</button></div>
            </div>}
            {hasSessionAnswer && <div className={sessionAnswer === currentQuestion.target ? "feedback success" : "feedback error"}><span>{sessionAnswer === currentQuestion.target ? "正确 · 已保存" : `${sessionAnswer ? `你的答案：${sessionAnswer}` : "已超时"} · 已保存`}</span><strong>{formatCode(MORSE[currentQuestion.target])}</strong><button className="secondary small" onClick={() => void playText(currentQuestion.target, sessionTiming)}>播放正确节奏</button><button className="primary" onClick={() => void nextQuestion()}>{sessionStep === questions.length - 1 ? "查看结果" : "下一题"}</button></div>}
            {showExitConfirm && <div className="dialog-backdrop" role="presentation"><section className="confirm-dialog card" role="dialog" aria-modal="true" aria-labelledby="leave-title"><p className="section-label">LEAVE SESSION</p><h2 id="leave-title">要如何处理这轮练习？</h2><p>保存后可从练习中心继续；结束练习会保留已提交记录，但本轮不计入完成统计。</p><div className="button-row"><button className="text-button" onClick={() => setShowExitConfirm(false)}>继续练习</button><button className="secondary" onClick={() => void leaveSession(true)}>保存后离开</button><button className="primary danger-action" onClick={() => void leaveSession(false)}>结束练习</button></div></section></div>}
          </section>
        )}

        {view === "session" && !currentQuestion && (
          <section className="route-error card">
            <p className="section-label">SESSION</p>
            <h2>{routeMessage ? "无法恢复练习" : "正在读取本地练习…"}</h2>
            {routeMessage && <p>{routeMessage}</p>}
            {routeMessage && <button className="primary" onClick={() => goTo(domainPathForMode(trainingState?.snapshot.definition.mode), true)}>返回功能域</button>}
          </section>
        )}

        {freeKeyer && (
          <div className="lab-layout">
            <section className="lab-workbench">
              <div className="lab-toolbar">
                <div className="segmented" aria-label="发报模式">
                  <button className={keyMode === "single" ? "active" : ""} onClick={() => setKeyMode("single")}>单键时长</button>
                  <button className={keyMode === "dual" ? "active" : ""} onClick={() => setKeyMode("dual")}>点划双键</button>
                </div>
                <button className="secondary small" onClick={() => void playText("SOS")}>{isPlaying ? "演示中…" : "播放 SOS"}</button>
              </div>

              <div className="decoded-output">
                <span className="section-label">DECODED OUTPUT</span>
                <p>{decoded || <em>开始按键，识别结果会出现在这里</em>}<b>{formatCode(sequence)}</b></p>
                <div className="output-actions"><button onClick={deleteOutput}>退格</button><button onClick={insertWordGap}>空格</button><button onClick={() => { setDecoded(""); setSequence(""); sequenceRef.current = ""; clearCommitTimers(); }}>清空</button><button onClick={() => void playText(decoded)} disabled={!decoded}>重新播放</button><button onClick={() => void copyText(decoded)} disabled={!decoded}>复制</button></div>
              </div>

              <div className="signal-monitor">
                <div><span>点单位</span><strong>{Math.round(dotMs)} ms</strong></div>
                <div><span>判定阈值</span><strong>{Math.round(thresholdMs)} ms</strong></div>
                <div><span>提交等待</span><strong>{Math.round(characterGapMs)} ms</strong></div>
                <div><span>声音状态</span><strong>{audioState === "ready" ? "RUNNING" : "LOCKED"}</strong></div>
                <div className="signal-line" data-active={isPressing}><i /></div>
              </div>

              {keyMode === "single" ? (
                <button
                  className={isPressing ? "key-pad pressing" : "key-pad"}
                  onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); void startLiveTone("pointer"); }}
                  onPointerUp={() => stopLiveTone("pointer")}
                  onPointerCancel={() => stopLiveTone("pointer", true)}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <span>{isPressing ? "正在发声" : "按住发报"}</span>
                  <small>键盘：{bindings.single} · 短按为点，长按为划</small>
                </button>
              ) : (
                <div className="dual-pads">
                  <button className="key-pad" onPointerDown={(event) => { event.preventDefault(); void tapSymbol(".", "pointer"); }}><span>点 ·</span><small>{bindings.dot}</small></button>
                  <button className="key-pad" onPointerDown={(event) => { event.preventDefault(); void tapSymbol("-", "pointer"); }}><span>划 —</span><small>{bindings.dash}</small></button>
                </div>
              )}
            </section>

            <aside className="lab-controls">
              <div className="card control-card">
                <p className="section-label">LIVE PARAMETERS</p>
                <label><span>字符速度 <b>{wpm} WPM</b></span><input type="range" min="8" max="40" value={wpm} onChange={(event) => updateWpm(Number(event.target.value))} /></label>
                <label><span>点划阈值 <b>{thresholdUnits.toFixed(1)} units</b></span><input type="range" min="1.4" max="2.6" step="0.1" value={thresholdUnits} onChange={(event) => setThresholdUnits(Number(event.target.value))} /></label>
                <label><span>自动提交等待 <b>{commitGapUnits.toFixed(1)} units · {Math.round(characterGapMs)} ms</b></span><input aria-label="自动提交等待" type="range" min="3" max="10" step="0.5" value={commitGapUnits} onChange={(event) => setCommitGapUnits(Number(event.target.value))} /></label>
                <label><span>音调 <b>{frequency} Hz</b></span><input type="range" min="400" max="900" step="25" value={frequency} onChange={(event) => setFrequency(Number(event.target.value))} /></label>
                <label><span>音量 <b>{Math.round(volume * 100)}%</b></span><input type="range" min="0.1" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
                <button className="secondary full" onClick={() => void ensureAudio()}>启用 / 恢复声音</button>
              </div>
              <div className="card sample-log">
                <div className="section-heading compact"><div><p className="section-label">PRESS LOG</p><h3>最近按压</h3></div><button className="text-button" onClick={() => setSamples([])}>清空</button></div>
                {samples.length === 0 ? <p className="empty-copy">尚无样本。按住发报区开始测试。</p> : <ol>{samples.map((sample, index) => <li key={`${sample.at}-${index}`}><span>{sample.at}</span><strong>{sample.duration} ms</strong><b>{formatCode(sample.symbol)}</b></li>)}</ol>}
              </div>
            </aside>
          </div>
        )}

        {view === "tools" && (
          <div className="page-stack">
            <nav className="stats-tabs" aria-label="工具视图"><button className={route.path === "/tools" ? "active" : ""} onClick={() => goTo("/tools")}>工具首页</button><button className={route.path === "/tools/morse" ? "active" : ""} onClick={() => goTo("/tools/morse")}>Morse 转换</button><button className={route.path === "/tools/reference" ? "active" : ""} onClick={() => goTo("/tools/reference")}>字符查询</button></nav>
            {route.path !== "/tools/reference" && <section className="card tool-panel">
              <div className="section-heading compact"><div><p className="section-label">MORSE CONVERTER</p><h2>文本与国际 Morse Code 双向转换</h2></div><button className="secondary small" onClick={() => void playText(toolText)} disabled={!toolText.trim()}>播放文本</button></div>
              <div className="tool-layout">
                <label><span>文本</span><textarea value={toolText} onChange={(event) => setToolText(event.target.value)} placeholder="输入英文、数字或受支持标点" /><small>自动转为大写；不支持的字符显示为 ?</small></label>
                <div className="conversion-output"><span>转换结果</span><strong>{toolEncoded ? formatCode(toolEncoded) : "等待文本…"}</strong><div className="button-row"><button className="secondary small" onClick={() => { setToolCode(toolEncoded); void copyText(toolEncoded); }} disabled={!toolEncoded}>复制并送入解码</button></div></div>
                <label><span>Morse Code</span><textarea value={toolCode} onChange={(event) => setToolCode(event.target.value)} placeholder="... --- ... / .-" /><small>字符之间用空格，单词之间用 /</small></label>
                <div className="conversion-output"><span>解码结果</span><strong>{toolDecoded || "等待电码…"}</strong><div className="button-row"><button className="secondary small" onClick={() => { setToolText(toolDecoded); void copyText(toolDecoded); }} disabled={!toolDecoded}>复制并送入编码</button></div></div>
              </div>
            </section>}
            {route.path !== "/tools/morse" && <section className="card reference-panel"><div className="section-heading compact"><div><p className="section-label">INTERNATIONAL MORSE</p><h2>字符速查表</h2></div><span className="count">{Object.keys(MORSE).length} 个字符</span></div><div className="reference-grid">{Object.entries(MORSE).map(([character, code]) => <button key={character} onClick={() => void playText(character)} aria-label={`播放 ${character}`}><strong>{character}</strong><span>{formatCode(code)}</span></button>)}</div></section>}
            <section className="card roadmap-strip"><p className="section-label">TOOL ROADMAP</p><h2>中文电码转换</h2><p>汉字转电码与电码转汉字需要权威四位报码表和版本说明；数据准备完成前不发布空白入口。</p></section>
          </div>
        )}

        {view === "progress" && (
          <div className="page-stack">
            {routeMessage && <section className="route-error card"><h2>找不到这次练习</h2><p>{routeMessage}</p></section>}
            <nav className="stats-tabs" aria-label="进度视图"><button className={route.path === "/progress" || route.resultSessionId ? "active" : ""} onClick={() => goTo("/progress")}>概览</button><button className={route.path === "/progress/content" ? "active" : ""} onClick={() => goTo("/progress/content")}>字符</button><button className={route.path === "/progress/history" ? "active" : ""} onClick={() => goTo("/progress/history")}>历史</button></nav>
            {route.path === "/progress/content" ? <section className="card stats-table"><div className="section-heading compact"><div><p className="section-label">CHARACTER PERFORMANCE</p><h2>字符表现</h2></div><span className="count">至少 3 次后参与薄弱项排序</span></div>{aggregatedCharacterStats.length ? aggregatedCharacterStats.slice().sort((left, right) => left.character.localeCompare(right.character)).map((stat) => <button key={stat.character} onClick={() => goTo(`/learn/character/${encodeURIComponent(stat.character)}`)}><strong>{stat.character}</strong><span>{formatCode(MORSE[stat.character])}</span><span>{Math.round(stat.correct / stat.attempts * 100)}%</span><small>{stat.attempts} 次 · 平均 {(stat.totalReactionMs / stat.attempts / 1000).toFixed(1)}s</small></button>) : <p className="empty-copy">完成训练后，这里会显示每个字符的真实表现。</p>}</section>
            : route.path === "/progress/history" ? <section className="card history-list"><p className="section-label">SESSION HISTORY</p><h2>训练历史</h2>{completedSessions.length ? completedSessions.map((session) => <button key={session.id} onClick={() => goTo(`/training/result/${encodeURIComponent(session.id)}`)}><span><strong>{practiceModeLabel(session.definition.mode)}</strong><small>{new Date(session.completedAt ?? session.updatedAt).toLocaleString("zh-CN")}</small></span><b>{Math.round((session.summary?.accuracy ?? 0) * 100)}%</b><small>{session.summary?.correct}/{session.summary?.total}</small></button>) : <p className="empty-copy">还没有已完成的训练。</p>}</section>
            : <>
              {latestSummary ? <><section className="result-banner"><div><p className="section-label">LATEST SESSION</p><h2>{latestSummary.correct} / {latestSummary.total}</h2><span>本轮正确</span></div><div><strong>{Math.round(latestSummary.accuracy * 100)}%</strong><span>正确率</span></div><div><strong>{(latestSummary.averageReactionMs / 1000).toFixed(1)} s</strong><span>平均反应</span></div><div><strong>{formatDuration(latestDurationMs)}</strong><span>总用时</span></div><button className="primary" onClick={() => void startSession(latestMistakes.length ? "review.mistakes" : presetForPracticeMode(latestState?.snapshot.definition.mode))}>{latestMistakes.length ? `重练 ${latestMistakes.length} 个错题` : "再练一轮"}</button></section>{latestMistakes.length > 0 && <section className="card mistake-list"><p className="section-label">MISTAKES</p><h2>本轮错题</h2><div>{latestMistakes.map((attempt) => <button key={attempt.id} onClick={() => void playText(attempt.target)}><strong>{attempt.target}</strong><span>{formatCode(MORSE[attempt.target])}</span><small>你的答案：{attempt.response || "未识别"} · 播放</small></button>)}</div></section>}</> : <section className="empty-state card"><p className="section-label">NO SESSIONS YET</p><h2>完成第一轮训练后，这里会出现真实统计</h2><button className="primary" onClick={() => goTo("/receive")}>前往听抄训练</button></section>}
              <section className="stats-grid"><div className="card chart-card"><p className="section-label">RECENT SESSIONS</p><h2>{trend.length ? "最近练习正确率" : "等待第一组数据"}</h2>{trend.length ? <div className="bars" aria-label="最近练习正确率">{trend.map((height, index) => <i key={index} style={{ height: `${Math.max(height, 4)}%` }}><span>{height}</span></i>)}</div> : <p className="empty-copy">这里不会用演示数据填充。你的每轮结果会从本地数据库读取。</p>}</div><div className="card weak-card"><p className="section-label">NEEDS WORK</p><h2>薄弱字符</h2>{weakestCharacters.length ? weakestCharacters.map((stat) => <button key={stat.id} onClick={() => goTo(`/learn/character/${encodeURIComponent(stat.character)}`)}><strong>{stat.character}</strong><span>{formatCode(MORSE[stat.character] ?? "")}</span><small>{Math.round((stat.correct / stat.attempts) * 100)}%</small></button>) : <p className="empty-copy">每个字符至少练习 3 次后开始分析。</p>}</div></section>
            </>}
          </div>
        )}

        {view === "settings" && (
          <div className="settings-layout">
            <aside className="settings-menu">{settingsSections.map((section) => <button key={section.id} className={settingsSection === section.id ? "active" : ""} onClick={() => goTo(`/settings/${section.id}`)}>{section.label}</button>)}</aside>
            <section className="card settings-panel">
              <p className="section-label">{settingsMeta[settingsSection].eyebrow}</p><h2>{settingsMeta[settingsSection].title}</h2><p>{settingsMeta[settingsSection].copy}</p>
              {settingsSection === "appearance" && <div className="theme-grid">{(["light", "dark", "amber", "contrast"] as Theme[]).map((item) => <button key={item} className={theme === item ? `theme-swatch ${item} active` : `theme-swatch ${item}`} onClick={() => setTheme(item)}><i /><span>{item === "light" ? "浅色" : item === "dark" ? "深色" : item === "amber" ? "无线电琥珀" : "高对比度"}</span></button>)}</div>}
              {settingsSection === "audio" && <><div className="segmented" aria-label="音色"><button className={waveform === "sine" ? "active" : ""} onClick={() => setWaveform("sine")}>正弦波</button><button className={waveform === "square" ? "active" : ""} onClick={() => setWaveform("square")}>方波</button></div><label className="setting-range"><span>默认音调 <b>{frequency} Hz</b></span><input type="range" min="400" max="900" step="25" value={frequency} onChange={(event) => setFrequency(Number(event.target.value))} /></label><label className="setting-range"><span>音量 <b>{Math.round(volume * 100)}%</b></span><input type="range" min="0.1" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label><div className="button-row"><button className="secondary" onClick={() => void playText("TEST")}>播放测试音</button><button className="text-button" onClick={stopPlayback}>停止播放</button></div></>}
              {settingsSection === "input" && <><div className="segmented"><button className={keyMode === "single" ? "active" : ""} onClick={() => setKeyMode("single")}>单键时长</button><button className={keyMode === "dual" ? "active" : ""} onClick={() => setKeyMode("dual")}>点划双键</button></div><label className="setting-range"><span>自由发报自动提交等待 <b>{commitGapUnits.toFixed(1)} units · {Math.round(characterGapMs)} ms</b></span><input aria-label="自由发报自动提交等待" type="range" min="3" max="10" step="0.5" value={commitGapUnits} onChange={(event) => setCommitGapUnits(Number(event.target.value))} /></label><div className="binding-grid">{([['single','单键'],['dot','点'],['dash','划'],['submit','提交'],['delete','删除'],['replay','重播'],['pause','暂停']] as [keyof KeyBindings, string][]).map(([control, label]) => <label key={control}><span>{label}</span><input readOnly value={bindings[control]} onKeyDown={(event) => { event.preventDefault(); setBindings((value) => ({ ...value, [control]: event.code })); }} aria-label={`${label}按键，聚焦后按下新键`} /></label>)}</div>{new Set(Object.values(bindings)).size !== Object.values(bindings).length && <p className="inline-error" role="alert">检测到重复键位，请为每项操作设置不同按键。</p>}<div className="button-row"><button className="secondary" onClick={() => setBindings(DEFAULT_BINDINGS)}>恢复默认</button><button className="secondary" onClick={() => setBindings({ ...DEFAULT_BINDINGS, single: "Space", dot: "KeyF", dash: "KeyD" })}>左手预设</button><button className="secondary" onClick={() => setBindings({ ...DEFAULT_BINDINGS, single: "Space", dot: "KeyJ", dash: "KeyK" })}>右手预设</button><button className="text-button" onClick={() => goTo("/send/free")}>前往自由拍发</button></div></>}
              {settingsSection === "training" && <><label className="setting-range"><span>默认题量 <b>{questionCount}</b></span><input type="range" min="4" max="40" step="4" value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))} /></label><label className="setting-range"><span>字符速度 <b>{wpm} WPM</b></span><input type="range" min="8" max="40" value={wpm} onChange={(event) => updateWpm(Number(event.target.value))} /></label><label className="setting-range"><span>有效速度 <b>{effectiveWpm} WPM</b></span><input type="range" min="5" max={wpm} value={Math.min(effectiveWpm, wpm)} onChange={(event) => setEffectiveWpm(Number(event.target.value))} /></label><label className="setting-text"><span>默认字符组</span><input value={practiceCharacters} onChange={(event) => setPracticeCharacters(event.target.value)} /></label><label className="setting-text"><span>每题超时</span><select value={timeoutMs ?? 0} onChange={(event) => setTimeoutMs(Number(event.target.value) || null)}><option value="0">关闭</option><option value="5000">5 秒</option><option value="10000">10 秒</option><option value="15000">15 秒</option></select></label><label className="checkbox-setting"><input type="checkbox" checked={shuffleQuestions} onChange={(event) => setShuffleQuestions(event.target.checked)} /><span>随机打乱题目</span></label></>}
              {settingsSection === "data" && <><div className="setting-row"><span><strong>本地训练数据库</strong><small>逐题写入 IndexedDB，可在刷新后恢复</small></span><b>{storageState === "ready" ? "READY" : storageState === "error" ? "ERROR" : "LOADING"}</b></div><div className="setting-row"><span><strong>已记录字符</strong><small>仅统计真实作答</small></span><b>{aggregatedCharacterStats.length}</b></div><input ref={importInputRef} className="visually-hidden" type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importLearningData(file); event.target.value = ""; }} /><div className="button-row data-actions"><button className="secondary" onClick={() => void exportLearningData()}>导出 JSON</button><button className="secondary" onClick={() => importInputRef.current?.click()}>导入数据</button><button className="primary danger-action" onClick={() => void clearLearningData()}>清空本机数据</button></div>{dataMessage && <p className="status-message" role="status">{dataMessage}</p>}</>}
              {settingsSection === "about" && <><div className="setting-row"><span><strong>版本</strong><small>V2 Foundation · Web / PWA</small></span><b>0.4.3</b></div><div className="setting-row"><span><strong>运行方式</strong><small>浏览器、可安装 PWA，后续可封装原生壳</small></span><b>LOCAL FIRST</b></div><button className="secondary" onClick={() => { setOnboardingStep(0); goTo("/onboarding"); }}>重新查看新手引导</button></>}
            </section>
          </div>
        )}
      </main>

      {view !== "session" && <nav className="bottom-nav" aria-label="移动端主导航">{NAV.map((item) => <button key={item.id} className={activePrimaryView === item.id ? "active" : ""} onClick={() => navigate(item.id)}>{item.label}</button>)}</nav>}
    </div>
  );
}
