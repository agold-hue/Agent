# Local browser relay (extension)

Some sites block hosted browsers outright (banks, card issuers, airlines). This extension lets the secretary drive one tab in the customer's own browser for those sites, from the machine and IP address they already use.

How it works

- The customer creates a relay token in the app (Settings › Local browser), installs this extension and pastes the app address and the token into its options page.
- The extension polls `GET /api/relay?action=next&token=…` (every 1.2 s while active, every 5 s when idle) and runs the command it gets in a tab it opened itself: `goto`, `snapshot`, `click`, `type`, `text`, `find`, `back`. It posts the result to `POST /api/relay?action=result&token=…`.
- The agent's `local_browser` tool queues a command and waits for the result (30 s at most). The tool exists only while a device has polled within the last 25 s, and the customer's context says whether the relay is online.
- Only a hash of the token is stored. The extension never sends page passwords: a password field's value is excluded from snapshots, and typing happens in the page.

Install (unpacked, for now)

1. Open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and pick this folder.
2. The options page opens: enter the app address (`https://…`) and the token from the app, then Save. "Connected" means the server accepted the token.
3. Leave the browser open. The secretary uses a tab of its own; the customer sees everything it does there.

Limits

- One round trip per command (about one to two seconds). Fine for a sign-in and a few clicks, not for long browsing.
- Serverless functions cannot hold a socket, so this is long-polling over HTTPS through the same API as the app.
- Verification codes still go through the usual `request_code` flow.
