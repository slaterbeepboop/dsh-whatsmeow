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

    const label = {
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
      root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0', maxWidth: 520 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      dot: (color) => ({ width: 8, height: 8, borderRadius: 4, background: color, flex: 'none' }),
      muted: { opacity: 0.7, fontSize: 13, lineHeight: 1.5, margin: 0 },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 },
      qrBox: { background: '#fff', padding: 12, borderRadius: 8, width: 'fit-content' },
      qr: { display: 'block', width: 260, height: 260 },
      button: {
        font: 'inherit', fontSize: 13, padding: '6px 14px', borderRadius: 6,
        border: '1px solid currentColor', background: 'transparent',
        color: 'inherit', cursor: 'pointer',
      },
      error: { color: '#d9534f', fontSize: 13, margin: 0, wordBreak: 'break-word' },
    }

    const dotColor = (state) => {
      if (state === 'connected') return '#3ba55d'
      if (state === 'qr' || state === 'connecting') return '#d9a441'
      if (state === 'failed') return '#d9534f'
      return '#8a8a8a'
    }

    function Panel() {
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

      const act = useCallback(async (action) => {
        setBusy(true)
        setActionError(null)
        try {
          const response = await fetch(ACTION_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
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
        return h('div', { style: styles.root },
          h('p', { style: styles.muted }, 'Loading bridge state…'))
      }

      const state = snapshot.state
      const linked = state === 'connected'
      return h('div', { style: styles.root },
        h('div', { style: styles.row },
          h('span', { style: styles.dot(dotColor(state)) }),
          h('strong', null, label[state] ?? state),
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
            }, busy ? 'Working…' : 'Unlink')),
        snapshot.error ? h('p', { style: styles.error }, snapshot.error) : null,
        actionError ? h('p', { style: styles.error }, actionError) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab',
          id: 'dsh-whatsmeow',
          order: 50,
          label: () => 'WhatsApp',
        }, Panel))
      },
    }
  },
})
