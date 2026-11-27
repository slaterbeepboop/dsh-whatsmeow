window.__ModuleLoader__.load({
  id: 'dsh-whatsmeow',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const STATE_URL = '/dsh-whatsmeow/state'
    const ACTION_URL = '/dsh-whatsmeow/action'
    /** The pairing code rotates on the sidecar's own schedule; polling faster adds nothing. */
    const POLL_MS = 2000

    const stateLabel = {
      connected: 'Connected',
      qr: 'Scan to link',
      connecting: 'Connecting',
      disconnected: 'Disconnected',
      logged_out: 'Not linked',
      stopped: 'Bridge stopped',
      starting: 'Starting',
      failed: 'Bridge failed',
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 4, maxWidth: 460 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      dot: (color) => ({ width: 8, height: 8, borderRadius: 4, background: color, flex: 'none' }),
      muted: { opacity: 0.7, fontSize: 13, lineHeight: 1.5, margin: 0 },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 },
      qrBox: { background: '#fff', padding: 12, borderRadius: 8, width: 'fit-content' },
      qr: { display: 'block', width: 240, height: 240 },
      button: {
        font: 'inherit', fontSize: 13, padding: '6px 14px', borderRadius: 6,
        border: '1px solid currentColor', background: 'transparent',
        color: 'inherit', cursor: 'pointer',
      },
      error: { color: '#d9534f', fontSize: 13, margin: 0, wordBreak: 'break-word' },
      field: {
        font: 'inherit', fontSize: 13, padding: '6px 10px', borderRadius: 6,
        border: '1px solid currentColor', background: 'transparent',
        color: 'inherit', minWidth: 0, flex: 1,
      },
      section: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid rgba(128,128,128,0.25)' },
      number: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, fontSize: 13,
      },
      remove: {
        font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 5,
        border: '1px solid currentColor', background: 'transparent',
        color: 'inherit', cursor: 'pointer', opacity: 0.7,
      },
      radio: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' },
    }

    const dotColor = (state) => {
      if (state === 'connected') return '#3ba55d'
      if (state === 'qr' || state === 'connecting') return '#d9a441'
      if (state === 'failed') return '#d9534f'
      return '#8a8a8a'
    }

    /** Nav glyph beside the section label; the shell falls back to a gear without it. */
    function WhatsAppIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor',
        'aria-hidden': true, style: { display: 'block' },
      }, h('path', {
        d: 'M12 2a10 10 0 0 0-8.5 15.3L2 22l4.9-1.4A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.2 14.8l-.4-.2-2.6.7.7-2.5-.2-.4A8 8 0 0 1 12 4zm-3 4.2c-.3 0-.7.1-1 .4-.4.4-.9 1-.9 2 0 1.1.8 2.2 1 2.4.1.2 1.6 2.6 4 3.5 2 .8 2.4.7 2.9.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2 0-.1-.2-.2-.4-.3l-1.4-.7c-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1-.2-.1-.9-.4-1.8-1.2-.6-.6-1.1-1.3-1.2-1.5-.1-.2 0-.3.1-.4l.4-.5c.1-.2.2-.3.2-.4 0-.2 0-.3-.1-.4l-.6-1.5c-.2-.4-.3-.4-.5-.4z',
      }))
    }

    /**
     * Who may reach the agent. An empty list in `list` mode locks everyone
     * out on purpose, so the panel says so instead of looking broken.
     */
    function Allowlist({ allow, blocked, onSave, busy }) {
      const [draft, setDraft] = useState('')
      const list = allow?.numbers ?? []
      const mode = allow?.mode ?? 'all'

      const commit = (next) => void onSave(next)
      const add = () => {
        const digits = draft.replace(/\D/g, '')
        if (digits === '' || list.includes(digits)) {
          setDraft('')
          return
        }
        commit({ mode, numbers: [...list, digits] })
        setDraft('')
      }

      return h('div', { style: styles.section },
        h('strong', null, 'Who can reach the agent'),
        h('label', { style: styles.radio },
          h('input', {
            type: 'radio',
            checked: mode === 'all',
            disabled: busy,
            onChange: () => commit({ mode: 'all', numbers: list }),
          }),
          'Anyone who messages this number'),
        h('label', { style: styles.radio },
          h('input', {
            type: 'radio',
            checked: mode === 'list',
            disabled: busy,
            onChange: () => commit({ mode: 'list', numbers: list }),
          }),
          'Only these numbers'),
        mode === 'list'
          ? h('div', null,
            list.length === 0
              ? h('p', { style: styles.muted }, 'The list is empty, so every sender is currently ignored.')
              : list.map((number) => h('div', { key: number, style: styles.number },
                h('span', { style: styles.code }, `+${number}`),
                h('button', {
                  type: 'button',
                  style: styles.remove,
                  disabled: busy,
                  onClick: () => commit({ mode, numbers: list.filter((entry) => entry !== number) }),
                }, 'Remove'))),
            h('div', { style: { ...styles.row, marginTop: 8 } },
              h('input', {
                type: 'tel',
                value: draft,
                placeholder: '628123456789',
                style: styles.field,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') add() },
              }),
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: add }, 'Add')))
          : null,
        blocked.length > 0 && mode === 'list'
          ? h('p', { style: styles.muted },
            `Last ignored: ${blocked.map((entry) => `+${(entry.sender ?? '').split('@')[0].replace(/\D/g, '')}`).join(', ')}`)
          : null)
    }

    function WhatsAppSection() {
      const [snapshot, setSnapshot] = useState(null)
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)

      useEffect(() => {
        let cancelled = false
        let timer
        const tick = async () => {
          try {
            const response = await fetch(STATE_URL, { credentials: 'same-origin' })
            const next = await response.json()
            if (!cancelled) setSnapshot(next)
          } catch (error) {
            if (!cancelled) setSnapshot({ state: 'failed', error: String(error) })
          }
          if (!cancelled) timer = setTimeout(tick, POLL_MS)
        }
        void tick()
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [])

      const act = useCallback(async (action, payload = {}) => {
        setBusy(true)
        setActionError(null)
        try {
          const response = await fetch(ACTION_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...payload }),
          })
          const result = await response.json()
          if (!result.ok) setActionError(result.error ?? 'request failed')
        } catch (error) {
          setActionError(String(error))
        } finally {
          setBusy(false)
        }
      }, [])

      if (!snapshot) {
        return h('div', { style: styles.root }, h('p', { style: styles.muted }, 'Loading bridge state…'))
      }

      const state = snapshot.state
      const linked = state === 'connected'
      return h('div', { style: styles.root },
        h('div', { style: styles.row },
          h('span', { style: styles.dot(dotColor(state)) }),
          h('strong', null, stateLabel[state] ?? state),
          snapshot.pushName ? h('span', { style: styles.muted }, `· ${snapshot.pushName}`) : null),
        snapshot.jid
          ? h('p', { style: styles.muted }, 'Linked number: ', h('span', { style: styles.code }, snapshot.jid.split('@')[0]))
          : null,
        snapshot.qr
          ? h('div', null,
            h('p', { style: styles.muted }, 'Open WhatsApp on your phone, then Linked devices → Link a device.'),
            h('div', { style: styles.qrBox },
              h('img', { src: snapshot.qr, alt: 'WhatsApp pairing code', style: styles.qr })))
          : null,
        !linked && !snapshot.qr && state !== 'connecting'
          ? h('p', { style: styles.muted },
            snapshot.process === 'running'
              ? 'Not linked yet. Start pairing to show a code.'
              : 'The bridge process is not running. Reinstall the plugin or check its row in Plugins.')
          : null,
        linked
          ? h('p', { style: styles.muted },
            'Each chat you message becomes its own Session in the sidebar. Replies you send there go back to WhatsApp.')
          : null,
        h('div', { style: styles.row },
          !linked
            ? h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy || snapshot.process !== 'running',
              onClick: () => void act('login'),
            }, busy ? 'Working…' : 'Link a device')
            : h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy,
              onClick: () => void act('logout'),
            }, busy ? 'Working…' : 'Unlink'),
          // Reloads the bridge process, which is what picks up a rebuilt
          // sidecar binary without restarting DSH.
          snapshot.process !== 'running'
            ? h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy,
              onClick: () => void act('restart'),
            }, busy ? 'Working…' : 'Restart bridge')
            : null),
        snapshot.error ? h('p', { style: styles.error }, snapshot.error) : null,
        actionError ? h('p', { style: styles.error }, actionError) : null,
        h(Allowlist, {
          allow: snapshot.allow,
          blocked: snapshot.blocked ?? [],
          busy,
          onSave: (next) => void act('allow', { allow: next }),
        }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // A settings section, beside Wallpaper Engine and the official pages,
        // rather than a tab on the Plugins page.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'whatsapp',
          order: 60,
          label: () => 'WhatsApp',
        }, WhatsAppSection))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'whatsapp',
        }, WhatsAppIcon))
      },
    }
  },
})
