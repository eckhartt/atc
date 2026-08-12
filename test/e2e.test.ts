import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type IPty } from "bun-pty";

const repo = join(import.meta.dir, "..");
let home: string;
let p: IPty | null = null;
let out = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "atc-test-"));
  mkdirSync(join(home, ".config", "atc"), { recursive: true });
  const fakeClaude = join(home, "fake-claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | "${process.execPath}" "${join(repo, "src", "hook-report.ts")}"
sleep 0.3
printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | "${process.execPath}" "${join(repo, "src", "hook-report.ts")}"
sleep 30
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(home, ".config", "atc", "config.json"),
    JSON.stringify({ claudeBin: fakeClaude, claudeArgs: [] }),
  );
});

afterEach(() => {
  p?.kill();
  p = null;
  out = "";
  rmSync(home, { recursive: true, force: true });
});

function boot(): IPty {
  const pty = spawn(process.execPath, [join(repo, "src", "index.ts")], {
    name: "xterm-256color",
    cols: 110,
    rows: 30,
    cwd: repo,
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      XDG_RUNTIME_DIR: home,
      PATH: "/usr/sbin:/usr/bin:/bin",
    },
  });
  pty.onData((d) => {
    out += d;
  });
  return pty;
}

async function waitFor(needle: string, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (out.includes(needle)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}; tail: ${JSON.stringify(out.slice(-400))}`);
}

async function spawnSession(name: string) {
  p!.write("n");
  await waitFor("spawn: directory");
  p!.write("\r");
  await waitFor("spawn: name");
  out = "";
  p!.write(`${name}\r`);
  await waitFor("spawn: initial prompt");
  out = "";
  p!.write("\r");
  await waitFor("FAKE_CLAUDE_UP");
}

test("spawn, hook status, overlay, kill, quit", async () => {
  p = boot();
  await waitFor("atc — control tower");
  await spawnSession("testsess");
  expect(out).toContain("--settings");
  p.write("\x00");
  await waitFor("NEEDS YOU");
  await waitFor("need you: testsess"); // overlay-mode status bar
  p.write("K");
  await waitFor("kill selected session?");
  p.write("y");
  await Bun.sleep(300);
  let exited = false;
  p.onExit(() => {
    exited = true;
  });
  p.write("q");
  await Bun.sleep(500);
  expect(exited).toBe(true);
});

test("adopt passes --resume and yank copies resume command", async () => {
  p = boot();
  await waitFor("adopt an existing session");
  p.write("r");
  await waitFor("adopt: directory");
  p.write("\r");
  await waitFor("adopt: name");
  out = "";
  p.write("adopted\r");
  await waitFor("FAKE_CLAUDE_UP");
  expect(out).toContain("--resume");
  p.write("\x00");
  await waitFor("need you: adopted");
  await waitFor("yank cmd");
  out = "";
  p.write("y");
  await waitFor("resume cmd copied");
  const b64 = out.split("]52;c;")[1]?.split("\x07")[0];
  expect(b64).toBeTruthy();
  const cmd = Buffer.from(b64!, "base64").toString();
  expect(cmd).toContain("claude --resume fake-1");
  expect(cmd.startsWith("cd '")).toBe(true);
});

test("statusline chains user command and appends fleet segment", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "echo CHAINED-SEGMENT" } }),
  );
  mkdirSync(join(home, ".local", "state", "atc"), { recursive: true });
  writeFileSync(
    join(home, ".local", "state", "atc", "status.json"),
    JSON.stringify({ needs_you: 2, running: 1, done: 0, exited: 0, urgent: "auth-bug" }),
  );
  const proc = Bun.spawn([process.execPath, join(repo, "src", "statusline.ts")], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "sl-1" })),
    env: { ...(process.env as Record<string, string>), HOME: home, PATH: "/usr/sbin:/usr/bin:/bin" },
    stdout: "pipe",
  });
  const line = await new Response(proc.stdout).text();
  expect(line).toContain("CHAINED-SEGMENT");
  expect(line).toContain("2 need you: auth-bug");
  expect(line).toContain("◐ 1");
});

test("session name pulled from claude transcript custom-title", async () => {
  writeFileSync(
    join(home, "fake-transcript.jsonl"),
    JSON.stringify({ type: "custom-title", customTitle: "claude-named", sessionId: "fake-1" }) + "\n",
  );
  p = boot();
  await waitFor("atc — control tower");
  await spawnSession("typedname");
  p.write("\x00");
  await waitFor("claude-named"); // /rename in claude overrides even a typed atc name
});

test("fleet survives crash and restores with recorded id", async () => {
  p = boot();
  await waitFor("atc — control tower");
  await spawnSession("fleettest");

  // SessionStart alone must be enough to enter the fleet — no interaction,
  // no notification required.
  const fleetFile = Bun.file(join(home, ".local", "state", "atc", "fleet.json"));
  const start = Date.now();
  let fleet: unknown[] = [];
  while (Date.now() - start < 3000) {
    fleet = await fleetFile.json().catch(() => []);
    if (fleet.length > 0) break;
    await Bun.sleep(50);
  }
  p.kill(); // simulate atc crash
  await Bun.sleep(300);
  expect(fleet).toEqual([{ name: "fleettest", cwd: home, claudeId: "fake-1" }]);

  out = "";
  p = boot();
  await waitFor("restore last fleet (1 sessions)");
  out = "";
  p.write("R");
  await waitFor("FAKE_CLAUDE_UP");
  await waitFor("--resume fake-1");
});
