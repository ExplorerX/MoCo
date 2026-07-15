"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AudioEngine } from "@learning-morse/audio-engine";
import { InputEngine, keyboardSignal, pointerSignal } from "@learning-morse/input-engine";
import { MORSE as MORSE_TABLE, REVERSE_MORSE, createFarnsworthTimeline, dotUnitMs, formatMorse as formatCode } from "@learning-morse/morse-core";
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
import { DATA_SCHEMA_VERSION, type AudioWaveform, type PracticeDefinition, type PracticeMode, type SessionSummary } from "@learning-morse/shared-types";
import type { SessionSnapshot } from "@learning-morse/shared-types";
import type { CharacterStatRecord, LearningMorseExport } from "@learning-morse/storage";
import PwaStatus from "./pwa-status";
import { pathForView, routeFromPath, type AppRoute, type AppView, type SettingsSection } from "../_lib/routes";

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

type MainView = "home" | "learn" | "practice" | "keyer" | "stats";

const NAV: { id: MainView; label: string; mark: string }[] = [
  { id: "home", label: "首页", mark: "01" },
  { id: "learn", label: "学习", mark: "02" },
  { id: "practice", label: "练习", mark: "03" },
  { id: "keyer", label: "发报", mark: "04" },
  { id: "stats", label: "统计", mark: "05" },
];

const PRACTICE_MODES = [
  { id: "sound", eyebrow: "听", title: "声音 → 字符", copy: "建立声音与字母之间的直接反射。" },
  { id: "code", eyebrow: "认", title: "Morse → 字符", copy: "从点划组合识别对应字符。" },
  { id: "encode", eyebrow: "译", title: "字符 → Morse", copy: "根据字符选择正确的点划组合。" },
  { id: "send", eyebrow: "敲", title: "字符 → 发报", copy: "用真实按压时长发出目标字符。" },
];

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

const PRACTICE_MODE_MAP: Record<string, PracticeMode> = {
  sound: "sound-to-character",
  code: "code-to-character",
  encode: "character-to-code",
  send: "character-to-keying",
  mistakes: "sound-to-character",
};
function parsePracticeCharacters(value: string): string[] {
  return [...new Set(Array.from(value.toUpperCase()).filter((character) => Boolean(MORSE[character])))];
}

function practiceModeLabel(mode: PracticeMode): string {
  return mode === "sound-to-character" ? "声音 → 字符" : mode === "code-to-character" ? "Morse → 字符" : mode === "character-to-code" ? "字符 → Morse" : mode === "character-to-keying" ? "字符 → 发报" : mode;
}

function modeIdForPractice(mode?: PracticeMode): string {
  return mode === "code-to-character" ? "code" : mode === "character-to-code" ? "encode" : mode === "character-to-keying" ? "send" : "sound";
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
        void repositoryRef.current?.saveSession(interrupted.snapshot);
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
      if (browserPath === "/" && window.localStorage.getItem("morse-onboarding-complete") === "true") goTo("/home", true);
      if (browserPath === "/settings") goTo("/settings/appearance", true);
    });
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPopState);
    };
  }, [goTo, initialPath]);

  useEffect(() => {
    const saved = window.localStorage.getItem("morse-prototype-theme") as Theme | null;
    if (!saved || !["light", "dark", "amber", "contrast"].includes(saved)) return;
    const frame = window.requestAnimationFrame(() => setTheme(saved));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("morse-prototype-theme", theme);
  }, [theme]);

  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  const getInputEngine = useCallback(() => {
    if (!inputEngineRef.current) {
      inputEngineRef.current = new InputEngine({ characterWpm: wpm, thresholdUnits });
    }
    inputEngineRef.current.setConfig({ characterWpm: wpm, thresholdUnits });
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

  const ensureAudio = useCallback(async () => {
    try {
      const engine = getAudioEngine();
      await engine.ensureRunning();
      setAudioState("ready");
      return engine;
    } catch {
      setAudioState("error");
      return null;
    }
  }, [getAudioEngine]);

  const playText = useCallback(async (text: string) => {
    if (isPlaying) return;
    const engine = await ensureAudio();
    if (!engine) return;

    setIsPlaying(true);
    const timeline = createFarnsworthTimeline(text, wpm, effectiveWpm);
    const cursorMs = await engine.playTimeline(timeline);

    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    playbackTimerRef.current = setTimeout(() => setIsPlaying(false), cursorMs + 100);
  }, [effectiveWpm, ensureAudio, isPlaying, wpm]);

  const stopPlayback = useCallback(() => {
    audioEngineRef.current?.stopPlayback();
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    playbackTimerRef.current = null;
    setIsPlaying(false);
  }, []);

  const clearCommitTimers = useCallback(() => {
    if (charTimerRef.current) clearTimeout(charTimerRef.current);
    if (wordTimerRef.current) clearTimeout(wordTimerRef.current);
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

  const commitSequence = useCallback(() => {
    const current = sequenceRef.current;
    if (!current) return;
    const character = REVERSE_MORSE[current] ?? "?";
    setDecoded((value) => `${value}${character}`);
    sequenceRef.current = "";
    setSequence("");
  }, []);

  const appendSymbol = useCallback((symbol: "." | "-") => {
    clearCommitTimers();
    setSequence((value) => {
      const next = `${value}${symbol}`.slice(-6);
      sequenceRef.current = next;
      return next;
    });
    charTimerRef.current = setTimeout(commitSequence, characterGapMs);
    wordTimerRef.current = setTimeout(() => {
      commitSequence();
      setDecoded((value) => value.endsWith(" ") || value.length === 0 ? value : `${value} `);
    }, wordGapMs);
  }, [characterGapMs, clearCommitTimers, commitSequence, wordGapMs]);

  const appendSessionSymbol = useCallback((symbol: "." | "-") => {
    setSessionCode((value) => `${value}${symbol}`.slice(0, 6));
  }, []);

  const appendLearnSymbol = useCallback((symbol: "." | "-") => {
    setLearnResult(null);
    if (learnResultTimerRef.current) clearTimeout(learnResultTimerRef.current);
    setLearnCode((value) => `${value}${symbol}`.slice(0, 6));
  }, []);

  const startLiveTone = useCallback(async (source: "keyboard" | "pointer", target: "keyer" | "session" | "learn" = "keyer") => {
    const input = getInputEngine();
    const signal = source === "keyboard"
      ? keyboardSignal("single", "down", performance.now())
      : pointerSignal("single", "down", performance.now());
    const interpretation = input.consume(signal);
    if (interpretation.kind !== "press-start") return;
    activeInputTargetRef.current = target;
    setIsPressing(true);
    if (target !== "keyer") startPressMeter();
    const audio = await ensureAudio();
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
    const input = getInputEngine();
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
    const input = getInputEngine();
    const control = symbol === "." ? "dot" : "dash";
    const signal = source === "keyboard"
      ? keyboardSignal(control, "down", performance.now())
      : pointerSignal(control, "down", performance.now());
    const interpretation = input.consume(signal);
    if (interpretation.kind !== "symbol") return;
    const audio = await ensureAudio();
    if (audio) void audio.playTone(interpretation.durationMs);
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
      const sessionKeying = view === "session" && sessionMode === "character-to-keying";
      const learningKeyer = view === "learn";
      if ((view !== "keyer" && !sessionKeying && !learningKeyer) || isEditableTarget(event.target) || event.repeat) return;
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
      if (view === "keyer" && event.code === bindings.delete) {
        event.preventDefault();
        setSequence((value) => value.slice(0, -1));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const sessionKeying = view === "session" && sessionMode === "character-to-keying";
      const learningKeyer = view === "learn";
      if ((view === "keyer" || sessionKeying || learningKeyer) && keyMode === "single" && event.code === bindings.single) {
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
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [bindings, finishDirectSymbol, keyMode, sessionMode, startDirectSymbol, startLiveTone, stopLiveTone, tapSymbol, view]);

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
        repository.getSetting<AppPreferences>("preferences"),
      ]))
      .then(([stored, stats, sessions, latest, saved]) => {
        if (cancelled) return;
        if (stored) setRecoverableState(restoreTrainingSession(stored.snapshot, stored.attempts));
        if (latest) setLatestResultState(restoreTrainingSession(latest.snapshot, latest.attempts));
        setCharacterStats(stats);
        setRecentSessions(sessions);
        if (saved) {
          setFrequency(saved.frequency ?? 600);
          setWpm(saved.wpm ?? 20);
          setEffectiveWpm(saved.effectiveWpm ?? 10);
          setVolume(saved.volume ?? 0.6);
          setWaveform(saved.waveform ?? "sine");
          setKeyMode(saved.keyMode ?? "single");
          setThresholdUnits(saved.thresholdUnits ?? 2);
          setCommitGapUnits(saved.commitGapUnits ?? 6);
          setQuestionCount(saved.questionCount ?? 4);
          setPracticeCharacters(saved.practiceCharacters ?? "K M R S");
          setShuffleQuestions(saved.shuffle ?? true);
          setTimeoutMs(saved.timeoutMs ?? null);
          setBindings({ ...DEFAULT_BINDINGS, ...(saved.bindings ?? {}) });
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
          void getRepository().then((repository) => repository.saveSession(restored.snapshot));
        }
      }
      setTrainingState(restored);
      if (stored.snapshot.status === "completed") setLatestResultState(restored);
      setSessionCode("");
      setTypedAnswer("");
      setLastSummary(stored.snapshot.summary);
      if (route.sessionId && stored.snapshot.status === "completed") {
        goTo(`/practice/result/${encodeURIComponent(sessionId)}`, true);
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

  const navigate = (next: MainView | "settings") => {
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
      void getRepository().then((repository) => repository.saveSession(interrupted.snapshot));
    } else if (
      view === "session" &&
      trainingState &&
      ["feedback", "paused", "interrupted"].includes(trainingState.snapshot.status)
    ) {
      setRecoverableState(trainingState);
    }
    goTo(pathForView(next));
  };

  const startSession = async (mode = "sound", characterOverride?: string[], guidedLessonId?: string) => {
    try {
      const now = new Date().toISOString();
      const sessionId = crypto.randomUUID();
      const parsedCharacters = characterOverride ?? parsePracticeCharacters(practiceCharacters);
      const unsupportedCharacters = characterOverride ? [] : [...new Set(Array.from(practiceCharacters.toUpperCase()).filter((character) => !/\s/.test(character) && !MORSE[character]))];
      if (mode !== "mistakes" && unsupportedCharacters.length > 0) {
        setPracticeError(`暂不支持：${unsupportedCharacters.join(" ")}。请删除后再开始练习。`);
        return;
      }
      if (mode !== "mistakes" && parsedCharacters.length === 0) {
        setPracticeError("请输入至少一个受支持的字符；可以直接输入字母、数字或标点。");
        return;
      }
      const defaultDefinition: PracticeDefinition = {
        schemaVersion: DATA_SCHEMA_VERSION,
        mode: PRACTICE_MODE_MAP[mode] ?? "sound-to-character",
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
      if (mode === "mistakes") {
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
      goTo(`/practice/session/${encodeURIComponent(sessionId)}`);
    } catch {
      setStorageState("error");
    }
  };

  const resumeSavedSession = async () => {
    if (!recoverableState) return;
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
      goTo(`/practice/session/${encodeURIComponent(next.snapshot.id)}`);
    } catch {
      setStorageState("error");
    }
  };

  const answerQuestion = async (answer: string, timingScore: number | null = null) => {
    if (!trainingState || trainingState.snapshot.status !== "answering") return;
    try {
      const result = submitTrainingAnswer(trainingState, answer, new Date().toISOString(), timingScore);
      await (await getRepository()).saveAttemptAndSession(result.attempt, result.state.snapshot);
      setTrainingState(result.state);
    } catch {
      setStorageState("error");
    }
  };

  const nextQuestion = async () => {
    if (!trainingState || trainingState.snapshot.status !== "feedback") return;
    try {
      const now = new Date().toISOString();
      let next = advanceTraining(trainingState, now);
      if (next.snapshot.status === "completed") {
        await (await getRepository()).saveSession(next.snapshot);
        setLastSummary(next.snapshot.summary);
        setLatestResultState(next);
        setRecoverableState(null);
        setTrainingState(next);
        const repository = await getRepository();
        const [stats, sessions] = await Promise.all([repository.getCharacterStats(), repository.getRecentSessions(7)]);
        setCharacterStats(stats);
        setRecentSessions(sessions);
        goTo(`/practice/result/${encodeURIComponent(next.snapshot.id)}`);
        return;
      }
      next = markPromptComplete(next, now);
      await (await getRepository()).saveSession(next.snapshot);
      setTrainingState(next);
      setSessionCode("");
      setPressElapsedMs(0);
      setTypedAnswer("");
    } catch {
      setStorageState("error");
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
      setTrainingState(next);
      void getRepository().then((repository) => repository.saveSession(next.snapshot));
    }
    if (sessionMode === "sound-to-character") await playText(currentQuestion.target);
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
    goTo("/practice");
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
      URL.revokeObjectURL(url);
      setDataMessage("数据已导出。");
    } catch {
      setDataMessage("导出失败，请稍后重试。");
    }
  };

  const importLearningData = async (file: File) => {
    try {
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
    setPreferencesLoaded(false);
    await (await getRepository()).clearAll();
    window.localStorage.removeItem("morse-onboarding-complete");
    window.localStorage.removeItem("morse-prototype-theme");
    setDataMessage("本地数据已清空，页面将重新载入。");
    window.setTimeout(() => window.location.reload(), 500);
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
      } else if (view === "keyer" && event.code === bindings.replay && decoded) {
        event.preventDefault();
        void playText(decoded);
      }
    };
    window.addEventListener("keydown", onActionKey);
    return () => window.removeEventListener("keydown", onActionKey);
  }, [bindings, decoded, playText, sessionMode, view]);

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
  const trend = completedSessions.slice().reverse().map((session) => Math.round((session.summary?.accuracy ?? 0) * 100));
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
  const learnInputState = learnCode === ""
    ? learnResult === "correct"
      ? { label: "输入正确 · 已清空", tone: "success" }
      : learnResult === "error"
        ? { label: "输入错误 · 已清空", tone: "error" }
        : { label: "等待输入", tone: "idle" }
    : MORSE[activeCharacter].startsWith(learnCode) && learnCode !== MORSE[activeCharacter]
      ? { label: "继续输入", tone: "progress" }
      : { label: `停顿 ${Math.round(Math.max(650, characterGapMs))} ms 后判定`, tone: "progress" };

  const pageTitle: Record<AppView, string> = {
    onboarding: "欢迎来到 Morse Lab",
    home: "今天练什么？",
    learn: "字符学习",
    practice: "练习中心",
    session: "专注练习",
    keyer: "音频与按键实验室",
    stats: "学习统计",
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
              className={view === item.id ? "nav-item active" : "nav-item"}
              onClick={() => navigate(item.id)}
            >
              <span>{item.mark}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={() => navigate("settings")}>
            <span>06</span>设置
          </button>
          <p>STAGE C.1 · 0.3.6</p>
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
              <button className="text-button" onClick={() => { window.localStorage.setItem("morse-onboarding-complete", "true"); goTo("/home", true); }}>跳过引导</button>
              {onboardingStep < 2
                ? <button className="primary" onClick={() => { stopPlayback(); setOnboardingStep((step) => step + 1); }}>下一步</button>
                : <button className="primary" onClick={() => { window.localStorage.setItem("morse-onboarding-complete", "true"); goTo("/home", true); }}>开始学习</button>}
            </div>
          </section>
        )}

        {view === "not-found" && (
          <section className="route-error card">
            <p className="section-label">404 · LOST SIGNAL</p>
            <h2>这个频率上没有页面</h2>
            <p>地址可能已失效，现有本地训练数据不会受到影响。</p>
            <button className="primary" onClick={() => goTo("/home", true)}>返回首页</button>
          </section>
        )}

        {view === "home" && (
          <div className="page-stack">
            <section className="hero-panel">
              <div>
                <p className="section-label">NEXT SESSION</p>
                <h2>让声音先于点划</h2>
                <p>继续 20 WPM 的声音识别训练。今天先强化 K、M、R、S 四个字符。</p>
                <div className="button-row">
                  <button className="primary" onClick={() => void startSession("sound")}>开始 4 题实验</button>
                  <button className="secondary" onClick={() => navigate("keyer")}>打开按键实验室</button>
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
              <div className="section-heading"><div><p className="section-label">QUICK START</p><h2>训练四种反射</h2></div><button className="text-button" onClick={() => navigate("practice")}>全部练习 →</button></div>
              <div className="mode-grid">
                {PRACTICE_MODES.map((mode) => (
                  <button className="mode-card" key={mode.id} onClick={() => void startSession(mode.id)}>
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
              <button className="secondary full" onClick={() => void startSession("sound", [activeCharacter])}>只练这个字符</button>
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
        )}

        {view === "practice" && (
          <div className="page-stack">
            <section className="intro-row"><div><p className="section-label">PRACTICE MODES</p><h2>选择要建立的反射</h2><p>快速开始沿用上次设置；每一道答案都会立即保存到本机。</p></div><button className="secondary" onClick={() => void startSession("mistakes")}>重练最近错题</button></section>
            {practiceError && <p className="inline-error" role="alert">{practiceError}</p>}
            {recoverableState && <section className="intro-row"><div><p className="section-label">SESSION RECOVERY</p><h2>发现未完成练习</h2><p>已保存到第 {recoverableState.snapshot.currentQuestionIndex + 1} 题，可从当前题安全恢复。</p></div><button className="primary" onClick={() => void resumeSavedSession()}>继续练习</button></section>}
            <section className="guided-course card">
              <div className="guided-course-intro">
                <div><p className="section-label">GUIDED RHYTHM COURSE</p><h2>每次认识两个节奏</h2><p>先看提示、听声音，再用当前键位跟敲。单课达到 80% 后解锁下一组。</p></div>
                <div className="guided-course-summary"><strong>{guidedCompletedIds.size} / {GUIDED_LESSONS.length}</strong><span>已掌握课程</span><button className="text-button" onClick={() => setShowGuidedHints((value) => !value)}>{showGuidedHints ? "关闭视觉提示" : "开启视觉提示"}</button></div>
              </div>
              <div className="guided-lesson-track">
                {GUIDED_LESSONS.map((lesson, index) => {
                  const completed = guidedCompletedIds.has(lesson.id);
                  const locked = index > guidedUnlockedIndex;
                  return <article key={lesson.id} className={completed ? "guided-lesson completed" : locked ? "guided-lesson locked" : "guided-lesson active"}>
                    <div className="guided-lesson-number">{completed ? "✓" : locked ? "锁" : String(index + 1).padStart(2, "0")}</div>
                    <span>{lesson.title}</span>
                    <strong>{lesson.characters.join(" · ")}</strong>
                    {showGuidedHints && <small>{lesson.characters.map((character) => formatCode(MORSE[character])).join(" / ")}</small>}
                    <button className={completed ? "secondary small" : "primary"} disabled={locked} onClick={() => void startSession("send", [...lesson.characters], lesson.id)}>{completed ? "再练一次" : locked ? "完成上一课后解锁" : "开始 8 题"}</button>
                  </article>;
                })}
              </div>
            </section>
            {route.practiceMode && (
              <section className="card setup-panel">
                <div><p className="section-label">SESSION SETUP</p><h2>自定义本轮练习</h2><p>设置会写入本次会话快照，刷新后仍能准确恢复。</p></div>
                <label><span>练习字符</span><input value={practiceCharacters} onChange={(event) => setPracticeCharacters(event.target.value)} placeholder="K M R S" /></label>
                <label><span>题量 <b>{questionCount}</b></span><input type="range" min="4" max="40" step="4" value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))} /></label>
                <label><span>字符速度 <b>{wpm} WPM</b></span><input type="range" min="8" max="40" value={wpm} onChange={(event) => setWpm(Number(event.target.value))} /></label>
                <label><span>有效速度 <b>{effectiveWpm} WPM</b></span><input type="range" min="5" max={wpm} value={Math.min(effectiveWpm, wpm)} onChange={(event) => setEffectiveWpm(Number(event.target.value))} /></label>
                <label className="checkbox-setting"><input type="checkbox" checked={shuffleQuestions} onChange={(event) => setShuffleQuestions(event.target.checked)} /><span>随机打乱题目</span></label>
                <label><span>每题超时</span><select value={timeoutMs ?? 0} onChange={(event) => setTimeoutMs(Number(event.target.value) || null)}><option value="0">关闭</option><option value="5000">5 秒</option><option value="10000">10 秒</option><option value="15000">15 秒</option></select></label>
                <div className="button-row"><button className="primary" onClick={() => void startSession(route.practiceMode)}>开始练习</button><button className="secondary" onClick={() => goTo("/practice")}>取消</button></div>
              </section>
            )}
            <div className="practice-grid">
              {PRACTICE_MODES.map((mode, index) => (
                <article className="practice-card" key={mode.id}>
                  <div className="practice-index">0{index + 1}</div>
                  <p className="section-label">{mode.eyebrow} · CORE LOOP</p>
                  <h2>{mode.title}</h2>
                  <p>{mode.copy}</p>
                  <dl><div><dt>题量</dt><dd>{questionCount}</dd></div><div><dt>速度</dt><dd>{wpm} / {effectiveWpm}</dd></div><div><dt>字符</dt><dd>{practiceCharacters}</dd></div></dl>
                  <div className="button-row"><button className="primary" onClick={() => void startSession(mode.id)}>快速开始</button><button className="text-button" onClick={() => goTo(`/practice/setup/${mode.id}`)}>自定义</button></div>
                </article>
              ))}
            </div>
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
                {showGuidedHints && <div className="guided-cue-grid">{activeGuidedLesson.characters.map((character, index) => <button key={character} className={character === currentQuestion.target ? "current" : ""} onClick={() => void playText(character)}><strong>{character}</strong><span>{formatCode(MORSE[character])}</span><small>{activeGuidedLesson.cues[index]}</small></button>)}</div>}
                <button className="secondary small" onClick={() => void playText(currentQuestion.target)}>听一遍当前节奏</button>
              </div>}
              <h2>{trainingState?.snapshot.status === "paused" ? "练习已暂停" : hasSessionAnswer ? "已提交答案" : sessionMode === "sound-to-character" ? "听声音，选择对应字符" : sessionMode === "code-to-character" ? "这个点划组合对应哪个字符？" : sessionMode === "character-to-code" ? "选择正确的 Morse Code" : activeGuidedLesson ? "跟随提示，发出这个字符" : "用真实按键发出这个字符"}</h2>
              <p>Character {wpm} WPM · Effective {effectiveWpm} WPM</p>
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
              <KeyDurationGuide ref={durationGuideRef} elapsedMs={pressElapsedMs} thresholdMs={thresholdMs} dotMs={dotMs} pressing={isPressing} />
              {keyMode === "single" ? <button className={isPressing ? "key-pad compact pressing" : "key-pad compact"} disabled={trainingState?.snapshot.status !== "answering"} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); void startLiveTone("pointer", "session"); }} onPointerUp={() => stopLiveTone("pointer")} onPointerCancel={() => stopLiveTone("pointer", true)}><span>按住发报</span><small>{bindings.single} · 短按点，长按划</small></button> : <div className="dual-pads"><button className="key-pad compact" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); startDirectSymbol(".", "pointer", "session"); }} onPointerUp={finishDirectSymbol} onPointerCancel={finishDirectSymbol} onClick={(event) => { if (event.detail === 0) void tapSymbol(".", "pointer", "session"); }}><span>点 ·</span><small>{bindings.dot}</small></button><button className="key-pad compact" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); startDirectSymbol("-", "pointer", "session"); }} onPointerUp={finishDirectSymbol} onPointerCancel={finishDirectSymbol} onClick={(event) => { if (event.detail === 0) void tapSymbol("-", "pointer", "session"); }}><span>划 —</span><small>{bindings.dash}</small></button></div>}
              <div className="button-row"><button className="secondary" onClick={() => setSessionCode((value) => value.slice(0, -1))} disabled={!sessionCode}>删除一划</button><button className="primary" onClick={() => void submitKeyingAnswer()} disabled={!sessionCode}>提交发报</button></div>
            </div>}
            {hasSessionAnswer && <div className={sessionAnswer === currentQuestion.target ? "feedback success" : "feedback error"}><span>{sessionAnswer === currentQuestion.target ? "正确 · 已保存" : `${sessionAnswer ? `你的答案：${sessionAnswer}` : "已超时"} · 已保存`}</span><strong>{formatCode(MORSE[currentQuestion.target])}</strong><button className="secondary small" onClick={() => void playText(currentQuestion.target)}>播放正确节奏</button><button className="primary" onClick={() => void nextQuestion()}>{sessionStep === questions.length - 1 ? "查看结果" : "下一题"}</button></div>}
            {showExitConfirm && <div className="dialog-backdrop" role="presentation"><section className="confirm-dialog card" role="dialog" aria-modal="true" aria-labelledby="leave-title"><p className="section-label">LEAVE SESSION</p><h2 id="leave-title">要如何处理这轮练习？</h2><p>保存后可从练习中心继续；结束练习会保留已提交记录，但本轮不计入完成统计。</p><div className="button-row"><button className="text-button" onClick={() => setShowExitConfirm(false)}>继续练习</button><button className="secondary" onClick={() => void leaveSession(true)}>保存后离开</button><button className="primary danger-action" onClick={() => void leaveSession(false)}>结束练习</button></div></section></div>}
          </section>
        )}

        {view === "session" && !currentQuestion && (
          <section className="route-error card">
            <p className="section-label">SESSION</p>
            <h2>{routeMessage ? "无法恢复练习" : "正在读取本地练习…"}</h2>
            {routeMessage && <p>{routeMessage}</p>}
            {routeMessage && <button className="primary" onClick={() => goTo("/practice", true)}>返回练习中心</button>}
          </section>
        )}

        {view === "keyer" && (
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
                <div className="output-actions"><button onClick={() => setDecoded((value) => value.slice(0, -1))}>退格</button><button onClick={() => setDecoded((value) => value.endsWith(" ") || !value ? value : `${value} `)}>空格</button><button onClick={() => { setDecoded(""); setSequence(""); sequenceRef.current = ""; clearCommitTimers(); }}>清空</button><button onClick={() => void playText(decoded)} disabled={!decoded}>重新播放</button><button onClick={() => navigator.clipboard?.writeText(decoded)}>复制</button></div>
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
                <label><span>字符速度 <b>{wpm} WPM</b></span><input type="range" min="8" max="40" value={wpm} onChange={(event) => setWpm(Number(event.target.value))} /></label>
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

        {view === "stats" && (
          <div className="page-stack">
            {routeMessage && <section className="route-error card"><h2>找不到这次练习</h2><p>{routeMessage}</p></section>}
            <nav className="stats-tabs" aria-label="统计视图"><button className={route.path === "/stats" || route.resultSessionId ? "active" : ""} onClick={() => goTo("/stats")}>概览</button><button className={route.path === "/stats/characters" ? "active" : ""} onClick={() => goTo("/stats/characters")}>字符</button><button className={route.path === "/stats/history" ? "active" : ""} onClick={() => goTo("/stats/history")}>历史</button></nav>
            {route.path === "/stats/characters" ? <section className="card stats-table"><div className="section-heading compact"><div><p className="section-label">CHARACTER PERFORMANCE</p><h2>字符表现</h2></div><span className="count">至少 3 次后参与薄弱项排序</span></div>{aggregatedCharacterStats.length ? aggregatedCharacterStats.sort((left, right) => left.character.localeCompare(right.character)).map((stat) => <button key={stat.character} onClick={() => goTo(`/learn/character/${encodeURIComponent(stat.character)}`)}><strong>{stat.character}</strong><span>{formatCode(MORSE[stat.character])}</span><span>{Math.round(stat.correct / stat.attempts * 100)}%</span><small>{stat.attempts} 次 · 平均 {(stat.totalReactionMs / stat.attempts / 1000).toFixed(1)}s</small></button>) : <p className="empty-copy">完成练习后，这里会显示每个字符的真实表现。</p>}</section>
            : route.path === "/stats/history" ? <section className="card history-list"><p className="section-label">SESSION HISTORY</p><h2>练习历史</h2>{completedSessions.length ? completedSessions.map((session) => <button key={session.id} onClick={() => goTo(`/practice/result/${encodeURIComponent(session.id)}`)}><span><strong>{practiceModeLabel(session.definition.mode)}</strong><small>{new Date(session.completedAt ?? session.updatedAt).toLocaleString("zh-CN")}</small></span><b>{Math.round((session.summary?.accuracy ?? 0) * 100)}%</b><small>{session.summary?.correct}/{session.summary?.total}</small></button>) : <p className="empty-copy">还没有已完成的练习。</p>}</section>
            : <>
              {latestSummary ? <><section className="result-banner"><div><p className="section-label">LATEST SESSION</p><h2>{latestSummary.correct} / {latestSummary.total}</h2><span>本轮正确</span></div><div><strong>{Math.round(latestSummary.accuracy * 100)}%</strong><span>正确率</span></div><div><strong>{(latestSummary.averageReactionMs / 1000).toFixed(1)} s</strong><span>平均反应</span></div><div><strong>{formatDuration(latestDurationMs)}</strong><span>总用时</span></div><button className="primary" onClick={() => void startSession(latestMistakes.length ? "mistakes" : modeIdForPractice(latestState?.snapshot.definition.mode))}>{latestMistakes.length ? `重练 ${latestMistakes.length} 个错题` : "再练一轮"}</button></section>{latestMistakes.length > 0 && <section className="card mistake-list"><p className="section-label">MISTAKES</p><h2>本轮错题</h2><div>{latestMistakes.map((attempt) => <button key={attempt.id} onClick={() => void playText(attempt.target)}><strong>{attempt.target}</strong><span>{formatCode(MORSE[attempt.target])}</span><small>你的答案：{attempt.response || "未识别"} · 播放</small></button>)}</div></section>}</> : <section className="empty-state card"><p className="section-label">NO SESSIONS YET</p><h2>完成第一轮练习后，这里会出现真实统计</h2><button className="primary" onClick={() => goTo("/practice")}>前往练习中心</button></section>}
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
              {settingsSection === "input" && <><div className="segmented"><button className={keyMode === "single" ? "active" : ""} onClick={() => setKeyMode("single")}>单键时长</button><button className={keyMode === "dual" ? "active" : ""} onClick={() => setKeyMode("dual")}>点划双键</button></div><label className="setting-range"><span>自由发报自动提交等待 <b>{commitGapUnits.toFixed(1)} units · {Math.round(characterGapMs)} ms</b></span><input aria-label="自由发报自动提交等待" type="range" min="3" max="10" step="0.5" value={commitGapUnits} onChange={(event) => setCommitGapUnits(Number(event.target.value))} /></label><div className="binding-grid">{([['single','单键'],['dot','点'],['dash','划'],['submit','提交'],['delete','删除'],['replay','重播'],['pause','暂停']] as [keyof KeyBindings, string][]).map(([control, label]) => <label key={control}><span>{label}</span><input readOnly value={bindings[control]} onKeyDown={(event) => { event.preventDefault(); setBindings((value) => ({ ...value, [control]: event.code })); }} aria-label={`${label}按键，聚焦后按下新键`} /></label>)}</div>{new Set(Object.values(bindings)).size !== Object.values(bindings).length && <p className="inline-error" role="alert">检测到重复键位，请为每项操作设置不同按键。</p>}<div className="button-row"><button className="secondary" onClick={() => setBindings(DEFAULT_BINDINGS)}>恢复默认</button><button className="secondary" onClick={() => setBindings({ ...DEFAULT_BINDINGS, single: "Space", dot: "KeyF", dash: "KeyD" })}>左手预设</button><button className="secondary" onClick={() => setBindings({ ...DEFAULT_BINDINGS, single: "Space", dot: "KeyJ", dash: "KeyK" })}>右手预设</button><button className="text-button" onClick={() => navigate("keyer")}>前往按键实验室</button></div></>}
              {settingsSection === "training" && <><label className="setting-range"><span>默认题量 <b>{questionCount}</b></span><input type="range" min="4" max="40" step="4" value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))} /></label><label className="setting-range"><span>字符速度 <b>{wpm} WPM</b></span><input type="range" min="8" max="40" value={wpm} onChange={(event) => { const next = Number(event.target.value); setWpm(next); setEffectiveWpm((value) => Math.min(value, next)); }} /></label><label className="setting-range"><span>有效速度 <b>{effectiveWpm} WPM</b></span><input type="range" min="5" max={wpm} value={Math.min(effectiveWpm, wpm)} onChange={(event) => setEffectiveWpm(Number(event.target.value))} /></label><label className="setting-text"><span>默认字符组</span><input value={practiceCharacters} onChange={(event) => setPracticeCharacters(event.target.value)} /></label><label className="setting-text"><span>每题超时</span><select value={timeoutMs ?? 0} onChange={(event) => setTimeoutMs(Number(event.target.value) || null)}><option value="0">关闭</option><option value="5000">5 秒</option><option value="10000">10 秒</option><option value="15000">15 秒</option></select></label><label className="checkbox-setting"><input type="checkbox" checked={shuffleQuestions} onChange={(event) => setShuffleQuestions(event.target.checked)} /><span>随机打乱题目</span></label></>}
              {settingsSection === "data" && <><div className="setting-row"><span><strong>本地训练数据库</strong><small>逐题写入 IndexedDB，可在刷新后恢复</small></span><b>{storageState === "ready" ? "READY" : storageState === "error" ? "ERROR" : "LOADING"}</b></div><div className="setting-row"><span><strong>已记录字符</strong><small>仅统计真实作答</small></span><b>{aggregatedCharacterStats.length}</b></div><input ref={importInputRef} className="visually-hidden" type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importLearningData(file); event.target.value = ""; }} /><div className="button-row data-actions"><button className="secondary" onClick={() => void exportLearningData()}>导出 JSON</button><button className="secondary" onClick={() => importInputRef.current?.click()}>导入数据</button><button className="primary danger-action" onClick={() => void clearLearningData()}>清空本机数据</button></div>{dataMessage && <p className="status-message" role="status">{dataMessage}</p>}</>}
              {settingsSection === "about" && <><div className="setting-row"><span><strong>版本</strong><small>Stage C.1 · Web / PWA</small></span><b>0.3.6</b></div><div className="setting-row"><span><strong>运行方式</strong><small>浏览器、可安装 PWA，后续可封装原生壳</small></span><b>LOCAL FIRST</b></div><button className="secondary" onClick={() => { setOnboardingStep(0); goTo("/onboarding"); }}>重新查看新手引导</button></>}
            </section>
          </div>
        )}
      </main>

      {view !== "session" && <nav className="bottom-nav" aria-label="移动端主导航">{NAV.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)}><span>{item.mark}</span>{item.label}</button>)}</nav>}
    </div>
  );
}
