import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseDisplaySetting,
  readDisplaySetting,
  settingsPath,
  writeDisplaySetting,
} from "./settings";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-turn-tps-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("parseDisplaySetting", () => {
  test("accepts both display modes", () => {
    expect(parseDisplaySetting({ display: "full" })).toEqual({ display: "full" });
    expect(parseDisplaySetting({ display: "compact" })).toEqual({ display: "compact" });
  });

  test("defaults to full when the key is absent", () => {
    expect(parseDisplaySetting({})).toEqual({ display: "full" });
  });

  test("falls back to full with an error on malformed values", () => {
    for (const raw of [null, [], "compact", { display: "FULL" }, { display: 1 }, { display: null }]) {
      const parsed = parseDisplaySetting(raw);
      expect(parsed.display).toBe("full");
      expect(parsed.error).toBeString();
    }
  });
});

describe("settings file", () => {
  test("points at pi-turn-tps.json in the agent directory", () => {
    expect(settingsPath("/tmp/agent")).toBe("/tmp/agent/pi-turn-tps.json");
  });

  test("reads a missing file as the default without an error", async () => {
    await withTempDir(async (dir) => {
      expect(await readDisplaySetting(join(dir, "missing.json"))).toEqual({ display: "full" });
    });
  });

  test("reads a valid file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "pi-turn-tps.json");
      await writeFile(file, JSON.stringify({ display: "compact" }), "utf8");
      expect(await readDisplaySetting(file)).toEqual({ display: "compact" });
    });
  });

  test("reports malformed JSON and falls back to full", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "pi-turn-tps.json");
      await writeFile(file, "{ not json", "utf8");
      const setting = await readDisplaySetting(file);
      expect(setting.display).toBe("full");
      expect(setting.error).toContain("malformed JSON");
    });
  });

  test("writes atomically and leaves no temporary file behind", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "pi-turn-tps.json");
      expect(await writeDisplaySetting(file, "compact")).toBeNull();
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ display: "compact" });
      expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("creates missing parent directories", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "nested", "pi-turn-tps.json");
      expect(await writeDisplaySetting(file, "compact")).toBeNull();
      expect(await readDisplaySetting(file)).toEqual({ display: "compact" });
    });
  });

  test("reports a write failure without leaving a temporary file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "pi-turn-tps.json");
      await mkdir(file);

      const error = await writeDisplaySetting(file, "compact");
      expect(error).toContain("could not save");
      expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });
});
