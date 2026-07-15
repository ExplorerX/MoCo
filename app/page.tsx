"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioEngine } from "@learning-morse/audio-engine";
import { InputEngine, keyboardSignal, pointerSignal } from "@learning-morse/input-engine";
import { MORSE as MORSE_TABLE, REVERSE_MORSE, createFarnsworthTimeline, dotUnitMs, formatMorse as formatCode } from "@learning-morse/morse-core";
import { createSessionRepository, type DexieSessionRepository } from "@learning-morse/storage";
import {
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
import { DATA_SCHEMA_VERSION, type PracticeMode, type SessionSummary } from "@learning-morse/shared-types";

type View = "home" | "learn" | "practice" | "session" | "keyer" | "stats" | "settings";
type Theme = "light" | "dark" | "amber" | "contrast";
type KeyMode = "single" | "dual";
type PressSample = { duration: number; symbol: "." | "-"; at: string };

const MORSE: Readonly<Record<string, string>> = MORSE_TABLE;

const NAV: { id: View; label: string; mark: string }[] = [
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

const PRACTICE_MODE_MAP: Record<string, PracticeMode> = {
  sound: "sound-to-character",
  code: "code-to-character",
  encode: "character-to-code",
  send: "character-to-keying",
  mistakes: "sound-to-character",
};

function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
}

export default function MorsePrototype() {
  const [view, setView] = useState<View>("home");
  const [theme, setTheme] = useState<Theme>("dark");
  const [frequency, setFrequency] = useState(600);
  const [wpm, setWpm] = useState(20);
  const [effectiveWpm] = useState(10);
  const [volume, setVolume] = useState(0.6);
  const [keyMode, setKeyMode] = useState<KeyMode>("single");
  const [thresholdUnits, setThresholdUnits] = useState(2);
  const [selectedCharacter, setSelectedCharacter] = useState("K");
  const [sequence, setSequence] = useState("");
  const [decoded, setDecoded] = useState("");
  const [isPressing, setIsPressing] = useState(false);
  const [audioState, setAudioState] = useState<"locked" | "ready" | "error">("locked");
  const [isPlaying, setIsPlaying] = useState(false);
  const [samples, setSamples] = useState<PressSample[]>([]);
  const [trainingState, setTrainingState] = useState<TrainingState | null>(null);
  const [recoverableState, setRecoverableState] = useState<TrainingState | null>(null);
  const [lastSummary, setLastSummary] = useState<SessionSummary | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedMode, setSelectedMode] = useState("sound");

  const audioEngineRef = useRef<AudioEngine | null>(null);
  const inputEngineRef = useRef<InputEngine | null>(null);
  const repositoryRef = useRef<DexieSessionRepository | null>(null);
  const sequenceRef = useRef("");
  const charTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dotMs = dotUnitMs(wpm);
  const thresholdMs = dotMs * thresholdUnits;
  const sessionStep = trainingState?.snapshot.currentQuestionIndex ?? 0;
  const questions = trainingState?.snapshot.questions ?? [];
  const currentQuestion = trainingState ? getCurrentQuestion(trainingState) : null;
  const currentAttempt = trainingState?.attempts.find((attempt) => attempt.questionIndex === sessionStep) ?? null;
  const sessionAnswer = currentAttempt?.response ?? null;
  const sessionScore = trainingState?.attempts.filter((attempt) => attempt.correct).length ?? 0;

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
        config: { frequencyHz: frequency, volume },
        onStateChange: (state) => {
          if (state === "running") setAudioState("ready");
          if (state === "failed") setAudioState("error");
          if (state === "locked" || state === "suspended" || state === "recovering") setAudioState("locked");
        },
      });
    }
    audioEngineRef.current.setConfig({ frequencyHz: frequency, volume });
    return audioEngineRef.current;
  }, [frequency, volume]);

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

  const clearCommitTimers = useCallback(() => {
    if (charTimerRef.current) clearTimeout(charTimerRef.current);
    if (wordTimerRef.current) clearTimeout(wordTimerRef.current);
  }, []);

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
    charTimerRef.current = setTimeout(commitSequence, dotMs * 3);
    wordTimerRef.current = setTimeout(() => {
      commitSequence();
      setDecoded((value) => value.endsWith(" ") || value.length === 0 ? value : `${value} `);
    }, dotMs * 7);
  }, [clearCommitTimers, commitSequence, dotMs]);

  const startLiveTone = useCallback(async (source: "keyboard" | "pointer") => {
    const input = getInputEngine();
    const signal = source === "keyboard"
      ? keyboardSignal("single", "down", performance.now())
      : pointerSignal("single", "down", performance.now());
    const interpretation = input.consume(signal);
    if (interpretation.kind !== "press-start") return;
    setIsPressing(true);
    const audio = await ensureAudio();
    if (!audio) {
      input.cancel(source, performance.now());
      setIsPressing(false);
      return;
    }
    if (!input.isActive) return;
    await audio.startLiveTone();
    if (!input.isActive) audio.stopLiveTone();
  }, [ensureAudio, getInputEngine]);

  const stopLiveTone = useCallback((source: "keyboard" | "pointer", cancel = false) => {
    const input = getInputEngine();
    const phase = cancel ? "cancel" : "up";
    const signal = source === "keyboard"
      ? keyboardSignal("single", phase, performance.now())
      : pointerSignal("single", phase, performance.now());
    const interpretation = input.consume(signal);
    audioEngineRef.current?.stopLiveTone();
    setIsPressing(false);
    if (interpretation.kind !== "symbol") return;
    appendSymbol(interpretation.symbol);
    setSamples((value) => [
      { duration: Math.round(interpretation.durationMs), symbol: interpretation.symbol, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) },
      ...value,
    ].slice(0, 8));
  }, [appendSymbol, getInputEngine]);

  const tapSymbol = useCallback(async (symbol: "." | "-", source: "keyboard" | "pointer") => {
    const input = getInputEngine();
    const control = symbol === "." ? "dot" : "dash";
    const signal = source === "keyboard"
      ? keyboardSignal(control, "down", performance.now())
      : pointerSignal(control, "down", performance.now());
    const interpretation = input.consume(signal);
    if (interpretation.kind !== "symbol") return;
    const audio = await ensureAudio();
    if (audio) void audio.playTone(interpretation.durationMs);
    appendSymbol(interpretation.symbol);
    setSamples((value) => [
      { duration: Math.round(interpretation.durationMs), symbol: interpretation.symbol, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) },
      ...value,
    ].slice(0, 8));
  }, [appendSymbol, ensureAudio, getInputEngine]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (view !== "keyer" || isEditableTarget(event.target) || event.repeat) return;
      if (keyMode === "single" && event.code === "Space") {
        event.preventDefault();
        void startLiveTone("keyboard");
      }
      if (keyMode === "dual" && (event.code === "KeyZ" || event.code === "Period")) {
        event.preventDefault();
        void tapSymbol(".", "keyboard");
      }
      if (keyMode === "dual" && (event.code === "KeyX" || event.code === "Minus")) {
        event.preventDefault();
        void tapSymbol("-", "keyboard");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (view === "keyer" && keyMode === "single" && event.code === "Space") {
        event.preventDefault();
        stopLiveTone("keyboard");
      }
    };
    const release = () => stopLiveTone("keyboard", true);
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
  }, [keyMode, startLiveTone, stopLiveTone, tapSymbol, view]);

  const getRepository = useCallback(async () => {
    if (!repositoryRef.current) repositoryRef.current = createSessionRepository();
    await repositoryRef.current.initialize();
    return repositoryRef.current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getRepository()
      .then((repository) => repository.getLatestRecoverableSession())
      .then((stored) => {
        if (cancelled) return;
        if (stored) setRecoverableState(restoreTrainingSession(stored.snapshot, stored.attempts));
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

  useEffect(() => () => {
    clearCommitTimers();
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    if (audioEngineRef.current) void audioEngineRef.current.close();
  }, [clearCommitTimers]);

  const navigate = (next: View) => {
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
    setView(next);
  };

  const startSession = async (mode = "sound") => {
    try {
      const now = new Date().toISOString();
      const sessionId = crypto.randomUUID();
      const defaultDefinition = {
        schemaVersion: DATA_SCHEMA_VERSION,
        mode: PRACTICE_MODE_MAP[mode] ?? "sound-to-character",
        characters: ["K", "M", "R", "S"],
        questionCount: 4,
        seed: crypto.randomUUID(),
        timing: {
          characterWpm: wpm,
          effectiveWpm,
          frequencyHz: frequency,
          waveform: "sine" as const,
          volume,
        },
        timeoutMs: null,
        feedbackMode: "immediate" as const,
      };
      const definition = mode === "mistakes" && trainingState
        ? createMistakePracticeDefinition(trainingState, crypto.randomUUID())
        : defaultDefinition;
      let next = createTrainingSession(definition, { sessionId, now });
      next = startTraining(next, now);
      next = markPromptComplete(next, now);
      const repository = await getRepository();
      await repository.createSession(next.snapshot);
      setTrainingState(next);
      setRecoverableState(null);
      setLastSummary(null);
      setSelectedMode(mode);
      setStorageState("ready");
      setView("session");
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
      setSelectedMode(next.snapshot.definition.mode === "sound-to-character" ? "sound" : "code");
      setView("session");
    } catch {
      setStorageState("error");
    }
  };

  const answerQuestion = async (answer: string) => {
    if (!trainingState || trainingState.snapshot.status !== "answering") return;
    try {
      const result = submitTrainingAnswer(trainingState, answer, new Date().toISOString());
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
        setRecoverableState(null);
        setTrainingState(next);
        setView("stats");
        return;
      }
      next = markPromptComplete(next, now);
      await (await getRepository()).saveSession(next.snapshot);
      setTrainingState(next);
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
    await playText(currentQuestion.target);
  };

  const characterGroups = useMemo(() => Object.keys(MORSE).slice(0, 36), []);

  const pageTitle: Record<View, string> = {
    home: "今天练什么？",
    learn: "字符学习",
    practice: "练习中心",
    session: "专注练习",
    keyer: "音频与按键实验室",
    stats: "学习统计",
    settings: "偏好设置",
  };

  return (
    <div className="prototype" data-theme={theme}>
      <aside className="side-rail" aria-label="主导航">
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
          <p>PROTOTYPE 0.1</p>
        </div>
      </aside>

      <main className={view === "session" ? "main session-main" : "main"}>
        <header className="topbar">
          <div>
            <p className="eyebrow">RESEARCH BUILD · 本地优先</p>
            <h1>{pageTitle[view]}</h1>
          </div>
          <div className="top-actions">
            <span className={`status ${audioState}`}>声音 {audioState === "ready" ? "已就绪" : audioState === "error" ? "异常" : "待启用"}</span>
            <button className="icon-button" onClick={() => navigate("settings")} aria-label="打开设置">设置</button>
          </div>
        </header>

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
              <div><span>今日练习</span><strong>12 min</strong><small>目标 15 min</small></div>
              <div><span>近期正确率</span><strong>84%</strong><small>↑ 6% 本周</small></div>
              <div><span>当前速度</span><strong>20 / 10</strong><small>字符 / 有效 WPM</small></div>
              <div><span>需要加强</span><strong>K M R</strong><small>开始专项练习</small></div>
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
              <div className="section-heading compact"><div><p className="section-label">REFERENCE</p><h2>国际 Morse 字符</h2></div><span className="count">36 / 48</span></div>
              <div className="filter-row"><button className="chip active">字母</button><button className="chip">数字</button><button className="chip">标点</button></div>
              <div className="character-grid">
                {characterGroups.map((character) => (
                  <button key={character} className={selectedCharacter === character ? "character active" : "character"} onClick={() => setSelectedCharacter(character)}>
                    <strong>{character}</strong><span>{formatCode(MORSE[character])}</span>
                  </button>
                ))}
              </div>
            </section>
            <aside className="card character-detail">
              <p className="section-label">CHARACTER DETAIL</p>
              <div className="big-character">{selectedCharacter}</div>
              <div className="big-code">{formatCode(MORSE[selectedCharacter])}</div>
              <div className="timing-line" aria-hidden="true">
                {MORSE[selectedCharacter].split("").map((symbol, index) => <i key={index} className={symbol === "-" ? "dash" : "dot"} />)}
              </div>
              <button className="primary full" onClick={() => void playText(selectedCharacter)}>{isPlaying ? "播放中…" : "播放字符"}</button>
              <button className="secondary full" onClick={() => void startSession("sound")}>包含此字符的练习</button>
              <div className="detail-note"><span>字符速度</span><strong>{wpm} WPM</strong></div>
              <div className="detail-note"><span>近期表现</span><strong>需要加强</strong></div>
            </aside>
          </div>
        )}

        {view === "practice" && (
          <div className="page-stack">
            <section className="intro-row"><div><p className="section-label">PRACTICE MODES</p><h2>选择要建立的反射</h2><p>快速开始沿用上次设置；每一道答案都会立即保存到本机。</p></div><button className="secondary" onClick={() => void startSession("mistakes")}>重练 3 个薄弱字符</button></section>
            {recoverableState && <section className="intro-row"><div><p className="section-label">SESSION RECOVERY</p><h2>发现未完成练习</h2><p>已保存到第 {recoverableState.snapshot.currentQuestionIndex + 1} 题，可从当前题安全恢复。</p></div><button className="primary" onClick={() => void resumeSavedSession()}>继续练习</button></section>}
            <div className="practice-grid">
              {PRACTICE_MODES.map((mode, index) => (
                <article className="practice-card" key={mode.id}>
                  <div className="practice-index">0{index + 1}</div>
                  <p className="section-label">{mode.eyebrow} · CORE LOOP</p>
                  <h2>{mode.title}</h2>
                  <p>{mode.copy}</p>
                  <dl><div><dt>题量</dt><dd>20</dd></div><div><dt>速度</dt><dd>20 / 10</dd></div><div><dt>字符</dt><dd>K M R S</dd></div></dl>
                  <div className="button-row"><button className="primary" onClick={() => void startSession(mode.id)}>快速开始</button><button className="text-button">自定义</button></div>
                </article>
              ))}
            </div>
          </div>
        )}

        {view === "session" && currentQuestion && (
          <section className="session-shell">
            <div className="session-header"><button className="text-button" onClick={() => navigate("practice")}>← 结束练习</button><span>{sessionStep + 1} / {questions.length}</span><button className="text-button" onClick={() => void toggleSessionPause()}>{trainingState?.snapshot.status === "paused" ? "继续" : "暂停"}</button></div>
            <div className="progress-track"><i style={{ width: `${((sessionStep + 1) / questions.length) * 100}%` }} /></div>
            <div className="session-prompt">
              <p className="section-label">{selectedMode === "sound" ? "LISTEN AND IDENTIFY" : "FOCUS SESSION"}</p>
              <button className="play-orb" onClick={() => void playSessionPrompt()} aria-label="播放当前字符" disabled={trainingState?.snapshot.status === "paused"}>{isPlaying ? "■" : "▶"}</button>
              <h2>{trainingState?.snapshot.status === "paused" ? "练习已暂停" : sessionAnswer ? `答案：${currentQuestion.target}` : "听声音，选择对应字符"}</h2>
              <p>Character {wpm} WPM · Effective {effectiveWpm} WPM</p>
            </div>
            <div className="answer-grid">
              {currentQuestion.choices.map((answer) => {
                const state = sessionAnswer ? answer === currentQuestion.target ? "correct" : answer === sessionAnswer ? "wrong" : "" : "";
                return <button key={answer} className={`answer ${state}`} onClick={() => void answerQuestion(answer)} disabled={Boolean(sessionAnswer) || trainingState?.snapshot.status !== "answering"}>{answer}<small>{formatCode(MORSE[answer])}</small></button>;
              })}
            </div>
            {sessionAnswer && <div className={sessionAnswer === currentQuestion.target ? "feedback success" : "feedback error"}><span>{sessionAnswer === currentQuestion.target ? "正确 · 已保存" : "再听一次节奏 · 已保存"}</span><strong>{formatCode(MORSE[currentQuestion.target])}</strong><button className="primary" onClick={() => void nextQuestion()}>{sessionStep === questions.length - 1 ? "查看结果" : "下一题"}</button></div>}
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
                <div className="output-actions"><button onClick={() => setDecoded((value) => value.slice(0, -1))}>退格</button><button onClick={() => { setDecoded(""); setSequence(""); sequenceRef.current = ""; clearCommitTimers(); }}>清空</button><button onClick={() => navigator.clipboard?.writeText(decoded)}>复制</button></div>
              </div>

              <div className="signal-monitor">
                <div><span>点单位</span><strong>{Math.round(dotMs)} ms</strong></div>
                <div><span>判定阈值</span><strong>{Math.round(thresholdMs)} ms</strong></div>
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
                  <small>键盘：SPACE · 短按为点，长按为划</small>
                </button>
              ) : (
                <div className="dual-pads">
                  <button className="key-pad" onPointerDown={(event) => { event.preventDefault(); void tapSymbol(".", "pointer"); }}><span>点 ·</span><small>Z 或 .</small></button>
                  <button className="key-pad" onPointerDown={(event) => { event.preventDefault(); void tapSymbol("-", "pointer"); }}><span>划 —</span><small>X 或 -</small></button>
                </div>
              )}
            </section>

            <aside className="lab-controls">
              <div className="card control-card">
                <p className="section-label">LIVE PARAMETERS</p>
                <label><span>字符速度 <b>{wpm} WPM</b></span><input type="range" min="8" max="40" value={wpm} onChange={(event) => setWpm(Number(event.target.value))} /></label>
                <label><span>点划阈值 <b>{thresholdUnits.toFixed(1)} units</b></span><input type="range" min="1.4" max="2.6" step="0.1" value={thresholdUnits} onChange={(event) => setThresholdUnits(Number(event.target.value))} /></label>
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
            <section className="result-banner"><div><p className="section-label">LATEST SESSION</p><h2>{lastSummary?.correct ?? trainingState?.snapshot.summary?.correct ?? sessionScore} / {(lastSummary?.total ?? trainingState?.snapshot.summary?.total ?? questions.length) || 4}</h2><span>本轮正确</span></div><div><strong>{Math.round((lastSummary?.accuracy ?? trainingState?.snapshot.summary?.accuracy ?? 0.75) * 100)}%</strong><span>正确率</span></div><div><strong>{((lastSummary?.averageReactionMs ?? trainingState?.snapshot.summary?.averageReactionMs ?? 1800) / 1000).toFixed(1)} s</strong><span>平均反应</span></div><button className="primary" onClick={() => void startSession("mistakes")}>重练错题</button></section>
            <section className="stats-grid"><div className="card chart-card"><p className="section-label">7 DAY TREND</p><h2>声音识别稳定上升</h2><div className="bars">{[38, 56, 48, 68, 62, 78, 84].map((height, index) => <i key={index} style={{ height: `${height}%` }}><span>{height}</span></i>)}</div></div><div className="card weak-card"><p className="section-label">NEEDS WORK</p><h2>薄弱字符</h2>{["K", "R", "M"].map((character, index) => <button key={character} onClick={() => { setSelectedCharacter(character); navigate("learn"); }}><strong>{character}</strong><span>{formatCode(MORSE[character])}</span><small>{[68, 72, 78][index]}%</small></button>)}</div></section>
          </div>
        )}

        {view === "settings" && (
          <div className="settings-layout">
            <aside className="settings-menu"><button className="active">外观</button><button>音频</button><button>输入与按键</button><button>训练默认值</button><button>数据与隐私</button><button>关于与帮助</button></aside>
            <section className="card settings-panel">
              <p className="section-label">APPEARANCE</p><h2>主题与显示</h2><p>原型阶段用于验证主题令牌是否能覆盖所有核心训练状态。</p>
              <div className="theme-grid">{(["light", "dark", "amber", "contrast"] as Theme[]).map((item) => <button key={item} className={theme === item ? `theme-swatch ${item} active` : `theme-swatch ${item}`} onClick={() => setTheme(item)}><i /><span>{item === "light" ? "浅色" : item === "dark" ? "深色" : item === "amber" ? "无线电琥珀" : "高对比度"}</span></button>)}</div>
              <hr />
              <p className="section-label">AUDIO DEFAULTS</p><div className="setting-row"><span><strong>默认音调</strong><small>练习和演示使用同一音频核心</small></span><b>{frequency} Hz</b></div><div className="setting-row"><span><strong>字符 / 有效速度</strong><small>Farnsworth 时间轴已进入领域核心</small></span><b>{wpm} / {effectiveWpm} WPM</b></div><div className="setting-row"><span><strong>本地训练数据库</strong><small>逐题写入 IndexedDB，可在刷新后恢复</small></span><b>{storageState === "ready" ? "READY" : storageState === "error" ? "ERROR" : "LOADING"}</b></div><button className="secondary" onClick={() => navigate("keyer")}>前往音频实验室</button>
            </section>
          </div>
        )}
      </main>

      {view !== "session" && <nav className="bottom-nav" aria-label="移动端主导航">{NAV.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)}><span>{item.mark}</span>{item.label}</button>)}</nav>}
    </div>
  );
}
