// Application logger, gated on the Log level setting.
//
// The setting existed before anything consumed it, so choosing a level did
// nothing. Everything that wants to say something at runtime routes through
// here, and the level in Settings → Power user decides what reaches the
// console. "silent" is genuinely silent.

import { settings } from "~/settings/store";
import type { LogLevel } from "~/settings/schema";

// Ascending verbosity. A message is emitted when its own level is at or below
// the configured one.
const RANK: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

function enabled(level: Exclude<LogLevel, "silent">): boolean {
  return RANK[settings.power.developer.logLevel] >= RANK[level];
}

// A short tag identifying the subsystem, so filtering the console is possible.
function emit(
  level: Exclude<LogLevel, "silent">,
  method: "error" | "warn" | "log" | "debug",
  scope: string,
  args: unknown[],
): void {
  if (!enabled(level)) return;
  console[method](`[${scope}]`, ...args);
}

export const log = {
  error: (scope: string, ...args: unknown[]) => emit("error", "error", scope, args),
  warn: (scope: string, ...args: unknown[]) => emit("error", "warn", scope, args),
  info: (scope: string, ...args: unknown[]) => emit("info", "log", scope, args),
  debug: (scope: string, ...args: unknown[]) => emit("debug", "debug", scope, args),
};
