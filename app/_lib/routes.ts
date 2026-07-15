export type AppView =
  | "onboarding"
  | "home"
  | "learn"
  | "practice"
  | "session"
  | "keyer"
  | "stats"
  | "settings"
  | "not-found";

export type AppRoute = {
  path: string;
  view: AppView;
  character?: string;
  practiceMode?: string;
  sessionId?: string;
  resultSessionId?: string;
  settingsSection?: SettingsSection;
};

export type SettingsSection = "appearance" | "audio" | "input" | "training" | "data" | "about";

export const VIEW_PATHS: Record<Exclude<AppView, "onboarding" | "session" | "not-found">, string> = {
  home: "/home",
  learn: "/learn",
  practice: "/practice",
  keyer: "/keyer",
  stats: "/stats",
  settings: "/settings/appearance",
};

const PRACTICE_MODES = new Set(["sound", "code", "encode", "send"]);
const SETTINGS_SECTIONS = new Set<SettingsSection>(["appearance", "audio", "input", "training", "data", "about"]);

export function normalizePath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  if (path === "/") return path;
  return `/${path.split("/").filter(Boolean).join("/")}`;
}

export function routeFromPath(pathname: string): AppRoute {
  const path = normalizePath(pathname);
  if (path === "/") return { path, view: "onboarding" };
  if (path === "/onboarding") return { path, view: "onboarding" };
  if (path === "/home") return { path, view: "home" };
  if (path === "/learn") return { path, view: "learn" };
  if (path.startsWith("/learn/character/")) {
    const character = decodeSegment(path.slice("/learn/character/".length)).toUpperCase();
    return character ? { path, view: "learn", character } : { path, view: "not-found" };
  }
  if (path === "/practice") return { path, view: "practice" };
  if (path.startsWith("/practice/setup/")) {
    const practiceMode = decodeSegment(path.slice("/practice/setup/".length));
    return PRACTICE_MODES.has(practiceMode)
      ? { path, view: "practice", practiceMode }
      : { path, view: "not-found" };
  }
  if (path.startsWith("/practice/session/")) {
    const sessionId = decodeSegment(path.slice("/practice/session/".length));
    return sessionId ? { path, view: "session", sessionId } : { path, view: "not-found" };
  }
  if (path.startsWith("/practice/result/")) {
    const resultSessionId = decodeSegment(path.slice("/practice/result/".length));
    return resultSessionId ? { path, view: "stats", resultSessionId } : { path, view: "not-found" };
  }
  if (path === "/keyer") return { path, view: "keyer" };
  if (path === "/stats" || path === "/stats/characters" || path === "/stats/history") return { path, view: "stats" };
  if (path === "/settings") return { path, view: "settings", settingsSection: "appearance" };
  if (path.startsWith("/settings/")) {
    const settingsSection = decodeSegment(path.slice("/settings/".length)) as SettingsSection;
    return SETTINGS_SECTIONS.has(settingsSection)
      ? { path, view: "settings", settingsSection }
      : { path, view: "not-found" };
  }
  return { path, view: "not-found" };
}

export function pathForView(view: Exclude<AppView, "onboarding" | "session" | "not-found">): string {
  return VIEW_PATHS[view];
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
