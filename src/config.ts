import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  claudeBin: string;
  claudeArgs: string[];
}

const DEFAULTS: Config = {
  claudeBin: "claude",
  claudeArgs: [],
};

export const configDir = join(homedir(), ".config", "atc");
export const stateDir = join(homedir(), ".local", "state", "atc");
export const socketPath =
  join(process.env.XDG_RUNTIME_DIR ?? stateDir, "atc.sock");
export const statusFile = join(stateDir, "status.json");

export function loadConfig(): Config {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const file = join(configDir, "config.json");
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + "\n");
    return { ...DEFAULTS };
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}
