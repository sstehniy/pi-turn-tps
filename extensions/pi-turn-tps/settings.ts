/**
 * Persistence for the display preference.
 *
 * Stored as a dedicated file in Pi's agent directory so the setting never
 * collides with other extensions' keys:
 *   ~/.pi/agent/pi-turn-tps.json  ->  { "display": "full" | "compact" }
 *
 * Writes go through a temporary file and rename so a crash or full disk cannot
 * leave a half-written settings file behind.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_DISPLAY, type DisplayMode } from "./tps";

export const SETTINGS_FILE = "pi-turn-tps.json";

export function settingsPath(agentDir: string): string {
  return join(agentDir, SETTINGS_FILE);
}

export interface DisplaySetting {
  display: DisplayMode;
  /** Present when the stored file existed but could not be used. */
  error?: string;
}

/** Parses an arbitrary JSON value into a display setting. */
export function parseDisplaySetting(raw: unknown): DisplaySetting {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { display: DEFAULT_DISPLAY, error: "settings must be a JSON object" };
  }
  const value = (raw as Record<string, unknown>).display;
  if (value === undefined) return { display: DEFAULT_DISPLAY };
  if (value === "full" || value === "compact") return { display: value };
  return {
    display: DEFAULT_DISPLAY,
    error: `invalid display value ${JSON.stringify(value)}`,
  };
}

/** Reads the display setting, falling back to the default on any problem. */
export async function readDisplaySetting(filePath: string): Promise<DisplaySetting> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { display: DEFAULT_DISPLAY };
    }
    return { display: DEFAULT_DISPLAY, error: `could not read ${filePath}: ${describe(error)}` };
  }

  try {
    return parseDisplaySetting(JSON.parse(text));
  } catch (error) {
    return { display: DEFAULT_DISPLAY, error: `malformed JSON in ${filePath}: ${describe(error)}` };
  }
}

/**
 * Persists the display setting atomically.
 *
 * @returns null on success, otherwise a message describing the failure.
 */
export async function writeDisplaySetting(
  filePath: string,
  display: DisplayMode,
): Promise<string | null> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify({ display }, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
    return null;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    return `could not save ${filePath}: ${describe(error)}`;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
