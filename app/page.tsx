"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MORSE as MORSE_TABLE, REVERSE_MORSE, classifyPress, createFarnsworthTimeline, dotUnitMs, formatMorse as formatCode } from "@learning-morse/morse-core";

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

function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
}

function scheduleOscillator(context: AudioContext, start: number, durationMs: number, frequency: number, volume: number) {
  const end = start + durationMs / 1000;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), start + 0.006);
  gain.gain.setValueAtTime(Math.max(0.001, volume), Math.max(start + 0.006, end - 0.008));
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(end + 0.012);
  return end;
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
  const [sessionStep, setSessionStep] = useState(0);
  const [sessionAnswer, setSessionAnswer] = useState<string | null>(null);
  const [sessionScore, setSessionScore] = useState(0);
  const [selectedMode, setSelectedMode] = useState("sound");

  const audioContextRef = useRef<AudioContext | null>(null);
  const liveToneRef = useRef<{ oscillator: OscillatorNode; gain: GainNode } | null>(null);
  const pressStartRef = useRef<number | null>(null);
  const sequenceRef = useRef("");
  const charTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dotMs = dotUnitMs(wpm);
  const thresholdMs = dotMs * thresholdUnits;
  const questions = ["K", "M", "R", "S"];

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

  const ensureAudio = useCallback(async () => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ latencyHint: "interactive" });
      }
      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }
      setAudioState("ready");
      return audioContextRef.current;
    } catch {
      setAudioState("error");
      return null;
    }
  }, []);

  const scheduleTone = useCallback(async (durationMs: number, offsetMs = 0) => {
    const context = await ensureAudio();
    if (!context) return 0;
    const start = context.currentTime + 0.025 + offsetMs / 1000;
    return scheduleOscillator(context, start, durationMs, frequency, volume);
  }, [ensureAudio, frequency, volume]);

  const playText = useCallback(async (text: string) => {
    if (isPlaying) return;
    const context = await ensureAudio();
    if (!context) return;

    setIsPlaying(true);
    const timeline = createFarnsworthTimeline(text, wpm, effectiveWpm);
    const baseTime = context.currentTime + 0.03;
    timeline.forEach((event) => {
      scheduleOscillator(context, baseTime + event.startMs / 1000, event.durationMs, frequency, volume);
    });
    const lastEvent = timeline.at(-1);
    const cursorMs = lastEvent ? lastEvent.startMs + lastEvent.durationMs : 0;

    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    playbackTimerRef.current = setTimeout(() => setIsPlaying(false), cursorMs + 100);
  }, [effectiveWpm, ensureAudio, frequency, isPlaying, volume, wpm]);

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

  const startLiveTone = useCallback(async () => {
    if (liveToneRef.current || pressStartRef.current !== null) return;
    const context = await ensureAudio();
    if (!context) return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + 0.006);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    liveToneRef.current = { oscillator, gain };
    pressStartRef.current = performance.now();
    setIsPressing(true);
  }, [ensureAudio, frequency, volume]);

  const stopLiveTone = useCallback(() => {
    if (pressStartRef.current === null) return;
    const duration = Math.max(1, performance.now() - pressStartRef.current);
    const symbol = classifyPress(duration, wpm, thresholdUnits);
    const live = liveToneRef.current;
    const context = audioContextRef.current;
    if (live && context) {
      const now = context.currentTime;
      live.gain.gain.cancelScheduledValues(now);
      live.gain.gain.setValueAtTime(Math.max(0.001, live.gain.gain.value), now);
      live.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.008);
      live.oscillator.stop(now + 0.014);
    }
    liveToneRef.current = null;
    pressStartRef.current = null;
    setIsPressing(false);
    appendSymbol(symbol);
    setSamples((value) => [
      { duration: Math.round(duration), symbol, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) },
      ...value,
    ].slice(0, 8));
  }, [appendSymbol, thresholdUnits, wpm]);

  const tapSymbol = useCallback(async (symbol: "." | "-") => {
    const duration = symbol === "." ? dotMs : dotMs * 3;
    void scheduleTone(duration);
    appendSymbol(symbol);
    setSamples((value) => [
      { duration: Math.round(duration), symbol, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) },
      ...value,
    ].slice(0, 8));
  }, [appendSymbol, dotMs, scheduleTone]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (view !== "keyer" || isEditableTarget(event.target) || event.repeat) return;
      if (keyMode === "single" && event.code === "Space") {
        event.preventDefault();
        void startLiveTone();
      }
      if (keyMode === "dual" && (event.code === "KeyZ" || event.code === "Period")) {
        event.preventDefault();
        void tapSymbol(".");
      }
      if (keyMode === "dual" && (event.code === "KeyX" || event.code === "Minus")) {
        event.preventDefault();
        void tapSymbol("-");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (view === "keyer" && keyMode === "single" && event.code === "Space") {
        event.preventDefault();
        stopLiveTone();
      }
    };
    const release = () => stopLiveTone();
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

  useEffect(() => () => {
    clearCommitTimers();
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    if (audioContextRef.current) void audioContextRef.current.close();
  }, [clearCommitTimers]);

  const navigate = (next: View) => {
    stopLiveTone();
    setView(next);
  };

  const startSession = (mode = "sound") => {
    setSelectedMode(mode);
    setSessionStep(0);
    setSessionAnswer(null);
    setSessionScore(0);
    setView("session");
  };

  const answerQuestion = (answer: string) => {
    if (sessionAnswer) return;
    setSessionAnswer(answer);
    if (answer === questions[sessionStep]) setSessionScore((score) => score + 1);
  };

  const nextQuestion = () => {
    if (sessionStep === questions.length - 1) {
      setView("stats");
      return;
    }
    setSessionStep((step) => step + 1);
    setSessionAnswer(null);
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
                  <button className="primary" onClick={() => startSession("sound")}>开始 4 题实验</button>
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
                  <button className="mode-card" key={mode.id} onClick={() => startSession(mode.id)}>
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
              <button className="secondary full" onClick={() => startSession("sound")}>包含此字符的练习</button>
              <div className="detail-note"><span>字符速度</span><strong>{wpm} WPM</strong></div>
              <div className="detail-note"><span>近期表现</span><strong>需要加强</strong></div>
            </aside>
          </div>
        )}

        {view === "practice" && (
          <div className="page-stack">
            <section className="intro-row"><div><p className="section-label">PRACTICE MODES</p><h2>选择要建立的反射</h2><p>快速开始沿用上次设置；自定义参数将在正式配置页展开。</p></div><button className="secondary" onClick={() => startSession("mistakes")}>重练 3 个薄弱字符</button></section>
            <div className="practice-grid">
              {PRACTICE_MODES.map((mode, index) => (
                <article className="practice-card" key={mode.id}>
                  <div className="practice-index">0{index + 1}</div>
                  <p className="section-label">{mode.eyebrow} · CORE LOOP</p>
                  <h2>{mode.title}</h2>
                  <p>{mode.copy}</p>
                  <dl><div><dt>题量</dt><dd>20</dd></div><div><dt>速度</dt><dd>20 / 10</dd></div><div><dt>字符</dt><dd>K M R S</dd></div></dl>
                  <div className="button-row"><button className="primary" onClick={() => startSession(mode.id)}>快速开始</button><button className="text-button">自定义</button></div>
                </article>
              ))}
            </div>
          </div>
        )}

        {view === "session" && (
          <section className="session-shell">
            <div className="session-header"><button className="text-button" onClick={() => navigate("practice")}>← 结束练习</button><span>{sessionStep + 1} / {questions.length}</span><button className="text-button">暂停</button></div>
            <div className="progress-track"><i style={{ width: `${((sessionStep + 1) / questions.length) * 100}%` }} /></div>
            <div className="session-prompt">
              <p className="section-label">{selectedMode === "sound" ? "LISTEN AND IDENTIFY" : "FOCUS SESSION"}</p>
              <button className="play-orb" onClick={() => void playText(questions[sessionStep])} aria-label="播放当前字符">{isPlaying ? "■" : "▶"}</button>
              <h2>{sessionAnswer ? `答案：${questions[sessionStep]}` : "听声音，选择对应字符"}</h2>
              <p>Character {wpm} WPM · Effective {effectiveWpm} WPM</p>
            </div>
            <div className="answer-grid">
              {[questions[sessionStep], "N", "A", "T"].filter((value, index, array) => array.indexOf(value) === index).slice(0, 4).map((answer) => {
                const state = sessionAnswer ? answer === questions[sessionStep] ? "correct" : answer === sessionAnswer ? "wrong" : "" : "";
                return <button key={answer} className={`answer ${state}`} onClick={() => answerQuestion(answer)} disabled={Boolean(sessionAnswer)}>{answer}<small>{formatCode(MORSE[answer])}</small></button>;
              })}
            </div>
            {sessionAnswer && <div className={sessionAnswer === questions[sessionStep] ? "feedback success" : "feedback error"}><span>{sessionAnswer === questions[sessionStep] ? "正确" : "再听一次节奏"}</span><strong>{formatCode(MORSE[questions[sessionStep]])}</strong><button className="primary" onClick={nextQuestion}>{sessionStep === questions.length - 1 ? "查看结果" : "下一题"}</button></div>}
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
                  onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); void startLiveTone(); }}
                  onPointerUp={stopLiveTone}
                  onPointerCancel={stopLiveTone}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <span>{isPressing ? "正在发声" : "按住发报"}</span>
                  <small>键盘：SPACE · 短按为点，长按为划</small>
                </button>
              ) : (
                <div className="dual-pads">
                  <button className="key-pad" onPointerDown={(event) => { event.preventDefault(); void tapSymbol("."); }}><span>点 ·</span><small>Z 或 .</small></button>
                  <button className="key-pad" onPointerDown={(event) => { event.preventDefault(); void tapSymbol("-"); }}><span>划 —</span><small>X 或 -</small></button>
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
            <section className="result-banner"><div><p className="section-label">LATEST SESSION</p><h2>{sessionScore || 3} / {questions.length}</h2><span>本轮正确</span></div><div><strong>{Math.round(((sessionScore || 3) / questions.length) * 100)}%</strong><span>正确率</span></div><div><strong>1.8 s</strong><span>平均反应</span></div><button className="primary" onClick={() => startSession("mistakes")}>重练错题</button></section>
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
              <p className="section-label">AUDIO DEFAULTS</p><div className="setting-row"><span><strong>默认音调</strong><small>练习和演示使用同一音频核心</small></span><b>{frequency} Hz</b></div><div className="setting-row"><span><strong>字符 / 有效速度</strong><small>Farnsworth 时间轴已进入领域核心</small></span><b>{wpm} / {effectiveWpm} WPM</b></div><button className="secondary" onClick={() => navigate("keyer")}>前往音频实验室</button>
            </section>
          </div>
        )}
      </main>

      {view !== "session" && <nav className="bottom-nav" aria-label="移动端主导航">{NAV.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)}><span>{item.mark}</span>{item.label}</button>)}</nav>}
    </div>
  );
}
