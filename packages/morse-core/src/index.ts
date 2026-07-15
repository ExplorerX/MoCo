export const MORSE = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.",
  H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.",
  O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-",
  V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
  "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "/": "-..-.", "=": "-...-",
  "+": ".-.-.", "-": "-....-", "(": "-.--.", ")": "-.--.-", ":": "---...",
  "'": ".----.",
} as const;

export type MorseCharacter = keyof typeof MORSE;
export type MorseSymbol = "." | "-";

export const REVERSE_MORSE: Readonly<Record<string, MorseCharacter>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MORSE).map(([character, code]) => [code, character as MorseCharacter]),
  ),
);

export type ToneEvent = {
  character: MorseCharacter;
  symbol: MorseSymbol;
  startMs: number;
  durationMs: number;
};

export type MorseTiming = {
  characterWpm: number;
  effectiveWpm: number;
  unitMs: number;
  elementGapMs: number;
  characterGapMs: number;
  wordGapMs: number;
  gapScale: number;
};

const PARIS_CHARACTER_UNITS = 31;
const PARIS_SPACING_UNITS = 19;
const PARIS_TOTAL_UNITS = PARIS_CHARACTER_UNITS + PARIS_SPACING_UNITS;

export function dotUnitMs(wpm: number): number {
  if (!Number.isFinite(wpm) || wpm <= 0) throw new RangeError("WPM must be greater than zero");
  return 1200 / wpm;
}

export function farnsworthGapScale(characterWpm: number, effectiveWpm: number): number {
  dotUnitMs(characterWpm);
  dotUnitMs(effectiveWpm);
  if (effectiveWpm > characterWpm) {
    throw new RangeError("Effective WPM cannot exceed character WPM");
  }

  return (
    PARIS_TOTAL_UNITS * (characterWpm / effectiveWpm) - PARIS_CHARACTER_UNITS
  ) / PARIS_SPACING_UNITS;
}

export function createMorseTiming(
  characterWpm: number,
  effectiveWpm = characterWpm,
): MorseTiming {
  const unitMs = dotUnitMs(characterWpm);
  const gapScale = farnsworthGapScale(characterWpm, effectiveWpm);

  return {
    characterWpm,
    effectiveWpm,
    unitMs,
    elementGapMs: unitMs,
    characterGapMs: unitMs * 3 * gapScale,
    wordGapMs: unitMs * 7 * gapScale,
    gapScale,
  };
}

export function formatMorse(code: string): string {
  return code.replaceAll(".", "·").replaceAll("-", "—");
}

export function normalizeMorse(code: string): string {
  return code
    .trim()
    .replace(/[·•]/g, ".")
    .replace(/[—–−]/g, "-")
    .replace(/\s+/g, " ");
}

export function encodeText(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .map((word) => Array.from(word, (character) => MORSE[character as MorseCharacter] ?? "?").join(" "))
    .join(" / ");
}

export function decodeText(code: string): string {
  return normalizeMorse(code)
    .split(/\s*\/\s*/)
    .map((word) => word.split(/\s+/).map((token) => REVERSE_MORSE[token] ?? "?").join(""))
    .join(" ");
}

export function classifyPress(durationMs: number, wpm: number, thresholdUnits = 2): MorseSymbol {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError("Duration cannot be negative");
  if (!Number.isFinite(thresholdUnits) || thresholdUnits <= 1 || thresholdUnits >= 3) {
    throw new RangeError("Threshold must stay between the standard dot and dash durations");
  }
  return durationMs < dotUnitMs(wpm) * thresholdUnits ? "." : "-";
}

export function createTimeline(text: string, timing: MorseTiming): ToneEvent[] {
  const words = text
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .map((word) => Array.from(word).filter((character): character is MorseCharacter => character in MORSE))
    .filter((characters) => characters.length > 0);
  const events: ToneEvent[] = [];
  let cursorMs = 0;

  words.forEach((characters, wordIndex) => {
    characters.forEach((character, characterIndex) => {
      const symbols = MORSE[character].split("") as MorseSymbol[];
      symbols.forEach((symbol, symbolIndex) => {
        const durationMs = symbol === "." ? timing.unitMs : timing.unitMs * 3;
        events.push({ character, symbol, startMs: cursorMs, durationMs });
        cursorMs += durationMs;
        if (symbolIndex < symbols.length - 1) cursorMs += timing.elementGapMs;
      });
      if (characterIndex < characters.length - 1) cursorMs += timing.characterGapMs;
    });
    if (wordIndex < words.length - 1) cursorMs += timing.wordGapMs;
  });

  return events;
}

export function createStandardTimeline(text: string, wpm: number): ToneEvent[] {
  return createTimeline(text, createMorseTiming(wpm));
}

export function createFarnsworthTimeline(
  text: string,
  characterWpm: number,
  effectiveWpm: number,
): ToneEvent[] {
  return createTimeline(text, createMorseTiming(characterWpm, effectiveWpm));
}
