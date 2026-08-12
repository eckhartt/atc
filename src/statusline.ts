// Injected as the statusLine command for wrangled sessions. Chains the
// user's own statusline (from ~/.claude/settings.json), appends the atc
// fleet segment, and heartbeats the session id back to the atc socket.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { statusFile } from "./config";

const raw = await new Response(Bun.stdin.stream()).text();

const sock = process.env.ATC_SOCKET;
const atcId = process.env.ATC_SESSION_ID;
if (sock && atcId) {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw);
  } catch {}
  const line = JSON.stringify({ atcId, event: "Statusline", payload }) + "\n";
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    Bun.connect({
      unix: sock,
      socket: {
        open(s) {
          s.write(line);
          s.end();
        },
        close() {
          clearTimeout(timer);
          resolve();
        },
        error() {
          clearTimeout(timer);
          resolve();
        },
        data() {},
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let chained = "";
try {
  const settings = JSON.parse(
    readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"),
  );
  const cmd: string | undefined = settings?.statusLine?.command;
  if (cmd && !cmd.includes("statusline.ts")) {
    const proc = Bun.spawn(["bash", "-c", cmd], {
      stdin: new TextEncoder().encode(raw),
      stdout: "pipe",
      stderr: "ignore",
    });
    const t = setTimeout(() => proc.kill(), 1500);
    chained = (await new Response(proc.stdout).text()).trimEnd();
    clearTimeout(t);
  }
} catch {}

let segment = "";
try {
  const st = JSON.parse(readFileSync(statusFile, "utf8"));
  const parts: string[] = [];
  if (st.needs_you > 0)
    parts.push(
      `\x1b[1;31m● ${st.needs_you} need you${st.urgent ? `: ${st.urgent}` : ""}\x1b[0m`,
    );
  if (st.done > 0) parts.push(`\x1b[32m✓ ${st.done}\x1b[0m`);
  if (st.running > 0) parts.push(`\x1b[36m◐ ${st.running}\x1b[0m`);
  segment = parts.join(" ");
} catch {}

console.log([chained, segment].filter(Boolean).join(" \x1b[90m▏\x1b[0m "));
process.exit(0);
