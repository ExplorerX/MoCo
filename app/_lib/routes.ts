export type TrainingPresetId =
  | "learn.character.encode"
  | "learn.character.decode"
  | "receive.character.audio"
  | "send.character.guided"
  | "review.mistakes";

export type AppView =
  | "onboarding"
  | "home"
  | "learn"
  | "receive"
  | "send"
  | "tools"
  | "setup"
  | "session"
  | "progress"
  | "settings"
  | "not-found";

export type AppRoute = {
  path: string;
  view: AppView;
  character?: string;
  presetId?: TrainingPresetId;
  sessionId?: string;
  resultSessionId?: string;
  settingsSection?: SettingsSection;
};

export type SettingsSection = "appearance" | "audio" | "input" | "training" | "data" | "about";
export type PrimaryView = "home" | "learn" | "receive" | "send" | "tools";

export const VIEW_PATHS: Record<PrimaryView | "progress" | "settings", string> = {
  home: "/home",
  learn: "/learn",
  receive: "/receive",
  send: "/send",
  tools: "/tools",
  progress: "/progress",
  settings: "/settings/appearance",
};

const TRAINING_PRESETS = new Set<TrainingPresetId>([
  "learn.character.encode",
  "learn.character.decode",
  "receive.character.audio",
  "send.character.guided",
  "review.mistakes",
]);
const SETTINGS_SECTIONS = new Set<SettingsSection>(["appearance", "audio", "input", "training", "data", "about"]);

export function normalizePath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  if (path === "/") return path;
  return `/${path.split("/").filter(Boolean).join("/")}`;
}

export function routeFromPath(pathname: string): AppRoute {
  const path = normalizePath(pathname);
  if (path === "/" || path === "/onboarding") return { path, view: "onboarding" };
  if (path === "/home") return { path, view: "home" };
  if (path === "/learn" || path === "/learn/courses" || path === "/learn/characters") return { path, view: "learn" };
  if (path.startsWith("/learn/character/")) {
    const character = decodeSegment(path.slice("/learn/character/".length)).toUpperCase();
    return character ? { path, view: "learn", character } : { path, view: "not-found" };
  }
  if (path === "/receive") return { path, view: "receive" };
  if (path === "/send" || path === "/send/free") return { path, view: "send" };
  if (path === "/tools" || path === "/tools/morse" || path === "/tools/reference") return { path, view: "tools" };
  if (path === "/progress" || path === "/progress/content" || path === "/progress/history") return { path, view: "progress" };
  if (path.startsWith("/training/setup/")) {
    const presetId = decodeSegment(path.slice("/training/setup/".length)) as TrainingPresetId;
    return TRAINING_PRESETS.has(presetId) ? { path, view: "setup", presetId } : { path, view: "not-found" };
  }
  if (path.startsWith("/training/session/")) {
    const sessionId = decodeSegment(path.slice("/training/session/".length));
    return sessionId ? { path, view: "session", sessionId } : { path, view: "not-found" };
  }
  if (path.startsWith("/training/result/")) {
    const resultSessionId = decodeSegment(path.slice("/training/result/".length));
    return resultSessionId ? { path, view: "progress", resultSessionId } : { path, view: "not-found" };
  }
  if (path === "/settings") return { path, view: "settings", settingsSection: "appearance" };
  if (path.startsWith("/settings/")) {
    const settingsSection = decodeSegment(path.slice("/settings/".length)) as SettingsSection;
    return SETTINGS_SECTIONS.has(settingsSection) ? { path, view: "settings", settingsSection } : { path, view: "not-found" };
  }
  return { path, view: "not-found" };
}

export function pathForView(view: PrimaryView | "progress" | "settings"): string {
  return VIEW_PATHS[view];
}

export function domainForPreset(presetId?: TrainingPresetId): PrimaryView {
  if (presetId?.startsWith("learn.")) return "learn";
  if (presetId?.startsWith("send.")) return "send";
  return "receive";
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
