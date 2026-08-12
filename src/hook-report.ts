// Runs as a Claude Code hook inside wrangled sessions. Reads the hook event
// from stdin and forwards it to the atc unix socket. Must always exit 0 so it
// never blocks the session it reports on.
const sock = process.env.ATC_SOCKET;
const atcId = process.env.ATC_SESSION_ID;

async function main() {
  if (!sock || !atcId) return;
  const raw = await new Response(Bun.stdin.stream()).text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw);
  } catch {}
  const line =
    JSON.stringify({ atcId, event: payload.hook_event_name, payload }) + "\n";
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    Bun.connect({
      unix: sock!,
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

main().finally(() => process.exit(0));
