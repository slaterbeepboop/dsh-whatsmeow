# WhatsApp

Links a WhatsApp account to DSH through a native [whatsmeow](https://github.com/tulir/whatsmeow) sidecar, then bridges each chat to its own DSH Session.

## Linking a device

Open **Settings → Plugins → WhatsApp** and press **Link a device**. A pairing code appears; scan it from your phone under WhatsApp → Linked devices → Link a device. The code rotates every 20 seconds and the panel follows it. Once the phone confirms, the panel shows the linked number and the code disappears.

**Unlink** ends the session on the server and deletes the stored credentials, so the next pairing starts clean.

## The pairing persists

Scanning once is enough. The device is stored in `store.db` under the state directory and reused on every start, so a DSH restart reconnects without a new code. If the first connect fails because the network is down, it retries in the background rather than sitting on `disconnected`.

## How a chat becomes a Session

The first message you receive from a chat creates a DSH Session named `whatsapp-<jid>`, which appears in the sidebar like any other. The message arrives as a user-role prompt, so the agent answers it with its normal tools and permissions. When the turn ends, the assistant text is sent back to that chat.

Typing in that Session from the DSH GUI sends your reply to WhatsApp too, so the conversation is bidirectional.

## Limits

- Group chats are ignored by default. Set `selfOnly: false` on the plugin row to bridge them.
- Only text is bridged outbound. Inbound images, video, audio, stickers, and documents arrive as a `[kind message]` placeholder with the caption when the message has one; media is not downloaded.
- The QR panel lives on the Plugins page, not in a chat, because the pairing code has to update while it is on screen.
- The sidecar is built for Linux x86-64. Other platforms need `sidecar/build.sh` with Go 1.26 or newer.
- This uses an unofficial WhatsApp client. WhatsApp's terms do not permit it, and an account used this way can be banned. A dedicated number is the only sensible mitigation.
