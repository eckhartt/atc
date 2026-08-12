// Runs as a Claude Code hook inside wrangled sessions. Reads the hook event
// from stdin and forwards it to the atc unix socket. Must always exit 0 so it
// never blocks the session it reports on.
import { isRecord, sendReport } from './report';

const sock = process.env['ATC_SOCKET'];
const atcId = process.env['ATC_SESSION_ID'];

if (sock !== undefined && sock !== '' && atcId !== undefined && atcId !== '') {
  const raw = await new Response(Bun.stdin.stream()).text();

  let payload: Record<string, unknown> = {};

  try {
    const parsed: unknown = JSON.parse(raw);

    if (isRecord(parsed)) {
      payload = parsed;
    }
  } catch {}

  const line = `${JSON.stringify({ atcId, event: payload['hook_event_name'], payload })}\n`;

  await sendReport(sock, line, 2000);
}

process.exit(0);
