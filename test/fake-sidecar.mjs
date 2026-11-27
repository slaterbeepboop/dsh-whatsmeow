#!/usr/bin/env node
// Stand-in for the Go sidecar: speaks the same line protocol so the Host half
// can be exercised without a real WhatsApp account. It records every outbound
// send so the test can assert what reached WhatsApp.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const SENT_LOG = new URL('./.sent.jsonl', import.meta.url).pathname
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

let pairingStarted = false
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const req = JSON.parse(line)

  if (req.cmd === 'status') {
    out({ id: req.id, ok: true, data: { state: 'connected', jid: '628111@s.whatsapp.net', pushName: 'Tester', loggedIn: true, connected: true } })
    return
  }

  if (req.cmd === 'login') {
    out({ id: req.id, ok: true, data: { state: 'qr' } })
    if (pairingStarted) return
    pairingStarted = true
    out({ event: 'status', state: 'qr' })
    out({ event: 'qr', code: 'fake-code', png: 'data:image/png;base64,AAAA', timeout: 20 })
    // One inbound text, one inbound group image, and one echo of our own send.
    setTimeout(() => out({
      event: 'message', id: 'm1', chat: '628222@s.whatsapp.net', chatName: '628222',
      sender: '628222@s.whatsapp.net', text: 'halo dari wa', kind: 'text',
      timestamp: 1, fromMe: false, isGroup: false,
    }), 50)
    setTimeout(() => out({
      event: 'message', id: 'm2', chat: '120363@g.us', chatName: '120363@g.us',
      sender: '628333@s.whatsapp.net', text: '', kind: 'image',
      timestamp: 2, fromMe: false, isGroup: true,
    }), 80)
    setTimeout(() => out({
      event: 'message', id: 'm3', chat: '628222@s.whatsapp.net', chatName: '628222',
      sender: '628111@s.whatsapp.net', text: 'echo', kind: 'text',
      timestamp: 3, fromMe: true, isGroup: false,
    }), 100)
    // A stranger, so the allowlist has something to decide about.
    setTimeout(() => out({
      event: 'message', id: 'm4', chat: '628999@lid', chatName: '628999',
      sender: '628999@lid', senderPN: '628999@s.whatsapp.net', text: 'halo stranger',
      kind: 'text', timestamp: 4, fromMe: false, isGroup: false,
    }), 120)
    return
  }

  if (req.cmd === 'send') {
    appendFileSync(SENT_LOG, `${JSON.stringify({ to: req.to, text: req.text })}\n`)
    out({ id: req.id, ok: true, data: { id: 'sent-1' } })
    return
  }

  if (req.cmd === 'logout') {
    out({ event: 'status', state: 'logged_out' })
    out({ id: req.id, ok: true })
    return
  }

  out({ id: req.id, ok: false, error: 'unknown command' })
})
