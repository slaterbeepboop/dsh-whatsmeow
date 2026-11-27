# dsh-whatsmeow

WhatsApp for [DSH](https://github.com/deepseek-ai/deepseek-harness), built on a native Go [whatsmeow](https://github.com/tulir/whatsmeow) sidecar instead of a JavaScript client.

Each WhatsApp chat becomes its own DSH Session. Messages arrive as prompts, replies go back to the chat, and the pairing code is shown in the Web GUI.

## How it fits together

```
DSH Host plugin (index.js)          sidecar (Go, static binary)
  ├─ spawn + supervise        ────►   whatsmeow client
  ├─ HTTP routes for the GUI  ◄────   newline-delimited JSON on stdio
  └─ Session bridge           ◄────   events: qr, status, message
```

Two processes, one contract: one JSON object per line, requests carry an `id`, events carry an `event`. WhatsApp state lives in SQLite under `~/.dsh-whatsmeow/store.db`, so restarting DSH reconnects without a new pairing.

## Install

```sh
git clone https://github.com/slaterbeepboop/dsh-whatsmeow.git
```

Then in DSH: **Plugins → Add plugin →** the cloned directory. Open **Settings → Plugins → WhatsApp** and press **Link a device**.

The repository ships a prebuilt Linux x86-64 binary at `bin/whatsmeow-sidecar`. To rebuild it for another platform, install Go 1.26 or newer and run:

```sh
sidecar/build.sh
```

## The pairing persists

Scanning the code once is enough. The paired device is written to `store.db` in the state directory, and the sidecar reconnects with it on every start, so restarting DSH never asks for a new code. A transient network failure at startup is retried in the background instead of leaving the account stuck.

The database holds the device's private keys, so it is created owner-only (`0600`) inside a `0700` directory. **Unlink** is the only way to remove it, and it deletes the credentials on purpose.

## Configuration

The plugin row accepts these optional fields:

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | `~/.dsh-whatsmeow` | Where the WhatsApp session database lives |
| `workspace` | process cwd | Working directory for the Sessions it creates |
| `selfOnly` | `true` | Ignore group chats |
| `sidecarPath` | bundled `bin/whatsmeow-sidecar` | Use a binary elsewhere |

## Routes

The Host half registers two same-origin routes, both behind DSH's own connection admission:

| Route | Method | Purpose |
|---|---|---|
| `/dsh-whatsmeow/state` | `GET` | Connection state and the current pairing code |
| `/dsh-whatsmeow/action` | `POST` | `{"action": "login"}` or `{"action": "logout"}` |

## Warnings

- **Unofficial client.** whatsmeow is not an approved WhatsApp client. Using it violates WhatsApp's terms of service and can get the number banned. Use a dedicated number.
- **Not for broadcasting.** Bulk or automated messaging raises the ban risk sharply.
- **Text only outbound.** Inbound media is not downloaded.

## Licences

This repository is MIT. The sidecar links [whatsmeow](https://github.com/tulir/whatsmeow) (MPL-2.0) and [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) (BSD-3-Clause); their terms apply to the built binary.
