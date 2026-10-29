# ws-canary (temporary)

Which network hop is resetting uw-stream's UW websocket connections (50–260 drops a day)? This service holds four long-lived websockets from Railway `us-west2`, uw-stream's region, with the same client and keepalive (`websockets==17.3`, 20 s ping interval, 20 s ping timeout). All four go to the same Fly-hosted echo server. Two go through Cloudflare and two go direct:

| Connection      | URL                                             | Traffic                              |
| --------------- | ----------------------------------------------- | ------------------------------------ |
| `cf-quiet`      | `wss://ws.ifelse.io` (Cloudflare → Fly)         | pings only                           |
| `cf-chatty`     | `wss://ws.ifelse.io`                            | 200-byte text every 1 s, echoed back |
| `direct-quiet`  | `wss://echo.websocket.org` (Fly, no Cloudflare) | pings only                           |
| `direct-chatty` | `wss://echo.websocket.org`                      | 200-byte text every 1 s, echoed back |

Spec, and later the verdict: `docs/superpowers/specs/ws-canary-2026-10-28.md`.

**Temporary.** Once the verdict is written, delete the `ws-canary` Railway service (ask the owner first) and this directory.

## Output

Each event prints one JSON line to stdout, with `ts` (ISO, UTC) and `event`:

- `start`: websockets and Python versions, and the connection URLs.
- `connect`: `conn`, `url`, `local_addr`, `remote_addr`.
- `drop`: one per ended connection attempt, with the same fields as uw-stream's disconnect log: `conn`, `url`, `exc_type`, `err`, `close_rcvd`, `close_sent`, `cause_type`, `cause`, `cause_errno`, `session_s`, `frames`, `since_last_frame_s`, `local_addr`, `remote_addr`. A failed connect is also a drop line, with `session_s`, `frames` and both addresses null.
- `heartbeat`: every 10 min, per connection: `up`, `drops`, `failed_connects` and `frames` since boot, `backoff_s`, plus `sent` and `echoes` on the chatty pair. `backoff_s` is the reconnect delay in force, null while connected. It is 1 at boot and after a connected session drops, and doubles with each consecutive failed connect up to 60. Between attempts it is the wait in progress. During a handshake it is the wait that came before it.
- `sender_error`: `conn`, `exc_type`, `err`. Printed once, when the chatty sender stops on anything other than a closed socket. The connection keeps receiving, but that arm sends nothing more until its next reconnect.

Reconnects: 1 s after a session that connected and then dropped (that drop is the measurement). After a failed connect (refused, DNS, TLS, HTTP 429), the wait doubles from 1 s up to a 60 s cap, so a stuck connection prints at most one drop line a minute. The next successful connect resets it.

The reset under investigation looks like this in uw-stream: `exc_type` `ConnectionClosedError`, `err` `no close frame received or sent`, both close frames null. `cause_type` tells a TCP reset (`ConnectionResetError`, with `cause_errno`) from a bare EOF (null).

## Reading the result

Compare drops per hour against uw-stream over the same hours, split by regime: options session, futures-only hours, Globex closed. Minimum per run: one full options session plus one overnight (run 1 Serverless on, then run 2 Serverless off; see Deploy).

| Canary result                                              | Points to                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Both `cf-*` and `direct-*` drop like uw-stream, same shape | Railway's network                                                         |
| Only `cf-*` drops                                          | Cloudflare's edge (raise with UW: their websocket sits behind Cloudflare) |
| Neither drops                                              | Something specific to UW's path or account                                |
| Chatty drops more than quiet                               | A volume-sensitive middlebox                                              |

When counting resets, skip drop lines from failed connects (`session_s` null). Discount a host that drops on a fixed schedule, because that is its own idle or rate policy.

## Known limit: echo.websocket.org refuses a fourth socket per IP

In a local test on 2026-10-28, one IP opened four sockets to `echo.websocket.org`. The fourth got `HTTP 429` on every 1 s retry for 90 s while the other three stayed up. `ws.ifelse.io` accepted four, probably because Fly sees Cloudflare's IPs there rather than ours. The canary opens two sockets per host, so on its own it stays under that limit. That limit is also why the Serverless comparison runs in sequence on one service: a second service could share the egress IP.

A sustained `InvalidStatus … HTTP 429` on a `direct-*` connection means another client on the same egress IP holds sockets to `echo.websocket.org`. Those are failed connects (`session_s` null), not drops, and that arm's coverage is lost while they last. Failed connects back off to one attempt a minute, so this prints about one line a minute.

## Run locally

```bash
cd scripts/ws-canary
python -m venv .venv
.venv/Scripts/python -m pip install websockets==17.3 pytest ruff  # .venv/bin/python on Linux/macOS
.venv/Scripts/python canary.py  # Ctrl-C to stop
.venv/Scripts/python -m pytest -q
.venv/Scripts/python -m ruff check . && .venv/Scripts/python -m ruff format --check .
```

## Deploy

One Railway service, `ws-canary`, in project Theta-Options, connected to this repo's `main`. A new service can't use config-as-code, and Railway stops reading `railway.toml` files on 2026-12-01. So set these on the service itself; `railway.toml` only records them:

| Setting        | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Region         | `us-west2` (uw-stream's)                                |
| Root directory | `/scripts/ws-canary`                                    |
| Builder        | Dockerfile                                              |
| Restart policy | Always                                                  |
| Watch path     | `/scripts/ws-canary/**`                                 |
| Serverless     | **On** for run 1 (matches uw-stream), **off** for run 2 |
| IPv6 egress    | Off                                                     |
| Runtime        | V2                                                      |
| Healthcheck    | None (the canary serves no HTTP)                        |
| Env vars       | None                                                    |

Serverless is tested in sequence on this one service. Run 1 has it on; then switch it off and redeploy for run 2. Each run needs the per-run minimum under "Reading the result". If drops fall in run 2, Serverless is the next suspect for uw-stream.

`scripts/` is in Vercel's `ignoreCommand`, so changes here never trigger a Vercel build.
