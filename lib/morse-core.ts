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

export function dotUnitMs(wpm: number): number {
  if (!Number.isFinite(wpm) || wpm <= 0) throw new RangeError("WPM must be greater than zero");
  return 1200 / wpm;
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

export function createStandardTimeline(text: string, wpm: number): ToneEvent[] {
  const unit = dotUnitMs(wpm);
  const words = text.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const events: ToneEvent[] = [];
  let cursorMs = 0;

  words.forEach((word, wordIndex) => {
    const characters = Array.from(word).filter((character): character is MorseCharacter => character in MORSE);
    characters.forEach((character, characterIndex) => {
      const symbols = MORSE[character].split("") as MorseSymbol[];
      symbols.forEach((symbol, symbolIndex) => {
        const durationMs = symbol === "." ? unit : unit * 3;
        events.push({ character, symbol, startMs: cursorMs, durationMs });
        cursorMs += durationMs;
        if (symbolIndex < symbols.length - 1) cursorMs += unit;
      });
      if (characterIndex < characters.length - 1) cursorMs += unit * 3;
    });
    if (wordIndex < words.length - 1) cursorMs += unit * 7;
  });

  return events;
}
