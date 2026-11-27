// Command whatsmeow-sidecar is the WhatsApp bridge process for the DSH
// dsh-whatsmeow plugin. It speaks newline-delimited JSON on stdin/stdout:
// one request object per line in, one response object per line out, plus
// unsolicited event objects. All logging goes to stderr so stdout stays a
// clean protocol channel.
package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	qrcode "github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"

	_ "modernc.org/sqlite"
)

// request is one command read from stdin.
type request struct {
	ID   int64  `json:"id"`
	Cmd  string `json:"cmd"`
	To   string `json:"to,omitempty"`
	Text string `json:"text,omitempty"`
}

// response answers one request, matched by id.
type response struct {
	ID    int64  `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Data  any    `json:"data,omitempty"`
}

// event is an unsolicited message pushed to the host plugin.
type event struct {
	Event string `json:"event"`

	// qr
	Code    string `json:"code,omitempty"`
	PNG     string `json:"png,omitempty"`
	Timeout int    `json:"timeout,omitempty"`

	// status
	State    string `json:"state,omitempty"`
	JID      string `json:"jid,omitempty"`
	PushName string `json:"pushName,omitempty"`
	Reason   string `json:"reason,omitempty"`

	// message
	ID       string `json:"id,omitempty"`
	Chat     string `json:"chat,omitempty"`
	ChatName string `json:"chatName,omitempty"`
	Sender   string `json:"sender,omitempty"`
	// SenderPN is the sender's phone-number JID when WhatsApp addressed the
	// message by LID; an allowlist of numbers needs this, not the opaque LID.
	SenderPN  string `json:"senderPN,omitempty"`
	ChatPN    string `json:"chatPN,omitempty"`
	Text      string `json:"text,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
	FromMe    bool   `json:"fromMe,omitempty"`
	IsGroup   bool   `json:"isGroup,omitempty"`

	// error
	Message string `json:"message,omitempty"`
}

// writer serialises protocol lines onto stdout.
type writer struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func (w *writer) send(v any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	// Encoding cannot fail for these types; a broken pipe means the parent
	// went away, which the signal handler already covers.
	_ = w.enc.Encode(v)
}

type sidecar struct {
	out *writer
	log waLog.Logger

	mu        sync.Mutex
	client    *whatsmeow.Client
	device    *store.Device
	container *sqlstore.Container
	state     string
	qrStop    context.CancelFunc
}

// cli reads the current client under the lock: a logout rebuilds it, and a
// caller holding the old pointer would drive a device already deleted.
func (s *sidecar) cli() *whatsmeow.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client
}

func (s *sidecar) deviceOf() *store.Device {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.device
}

func main() {
	// The database holds the paired device's private keys, and SQLite creates
	// the -wal and -shm files itself. Close the process umask so every one of
	// them lands owner-only instead of the default 0644.
	syscall.Umask(0o077)

	level := zerolog.WarnLevel
	switch os.Getenv("DSH_WHATSBMEOW_LOG") {
	case "debug":
		level = zerolog.DebugLevel
	case "info":
		level = zerolog.InfoLevel
	}
	zl := zerolog.New(os.Stderr).Level(level).With().Timestamp().Logger()
	logger := waLog.Zerolog(zl)

	out := &writer{enc: json.NewEncoder(os.Stdout)}

	dir := os.Getenv("DSH_WHATSBMEOW_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fatal(out, fmt.Errorf("resolve home directory: %w", err))
		}
		dir = filepath.Join(home, ".dsh-whatsmeow")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fatal(out, fmt.Errorf("create state directory %s: %w", dir, err))
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	s := &sidecar{out: out, log: logger, state: "starting"}
	if err := s.open(ctx, filepath.Join(dir, "store.db")); err != nil {
		fatal(out, err)
	}
	defer s.close()

	// A stored device means a previous pairing survived, so reconnect without
	// asking for a QR code again.
	if s.deviceOf().ID != nil {
		s.connectExisting(ctx)
	} else {
		s.setState("logged_out", "", "")
	}

	go s.readLoop(ctx)
	<-ctx.Done()
	s.stopQR()
	if client := s.cli(); client != nil {
		client.Disconnect()
	}
}

// fatal reports an unrecoverable startup failure and exits non-zero so the
// host plugin can surface it instead of waiting on a silent child.
func fatal(out *writer, err error) {
	out.send(event{Event: "error", Message: err.Error()})
	os.Exit(1)
}

func (s *sidecar) open(ctx context.Context, path string) error {
	// modernc.org/sqlite needs the pragma spelled as a driver parameter;
	// whatsmeow refuses to start unless foreign keys are already on.
	dsn := "file:" + path + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)

	container := sqlstore.NewWithDB(db, "sqlite3", s.log)
	if err := container.Upgrade(ctx); err != nil {
		return fmt.Errorf("upgrade database: %w", err)
	}
	s.mu.Lock()
	s.container = container
	s.mu.Unlock()
	return s.resetClient(ctx)
}

// resetClient builds a client around whatever device the database now holds.
// After a logout the stored device is gone, so this is what makes a fresh QR
// pairing possible again instead of retrying a device the server ended.
func (s *sidecar) resetClient(ctx context.Context) error {
	s.mu.Lock()
	container := s.container
	s.mu.Unlock()
	if container == nil {
		return errors.New("database is not open")
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return fmt.Errorf("load device: %w", err)
	}
	client := whatsmeow.NewClient(device, s.log)
	client.AddEventHandler(s.handleEvent)
	s.mu.Lock()
	s.device = device
	s.client = client
	s.mu.Unlock()
	return nil
}

// dropDevice clears credentials the server has rejected and rebuilds the
// client, so the next login offers a QR code rather than failing on a deleted
// device.
func (s *sidecar) dropDevice() {
	ctx := context.Background()
	if device := s.deviceOf(); device != nil {
		if err := device.Delete(ctx); err != nil {
			s.emitError(fmt.Errorf("clear logged-out device: %w", err))
		}
	}
	if err := s.resetClient(ctx); err != nil {
		s.emitError(err)
	}
}

func (s *sidecar) close() {
	if client := s.cli(); client != nil {
		client.Disconnect()
	}
}

func (s *sidecar) setState(state, jid, reason string) {
	s.mu.Lock()
	s.state = state
	s.mu.Unlock()
	s.out.send(event{
		Event:    "status",
		State:    state,
		JID:      jid,
		PushName: s.pushName(),
		Reason:   reason,
	})
}

func (s *sidecar) pushName() string {
	if device := s.deviceOf(); device != nil {
		return device.PushName
	}
	return ""
}

func (s *sidecar) currentState() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *sidecar) emitError(err error) {
	s.out.send(event{Event: "error", Message: err.Error()})
}

// connectExisting reconnects an already-paired device. whatsmeow retries a
// retryable failure in the background only while InitialAutoReconnect is set,
// so a restart during a network blip heals itself instead of stranding the
// account on "disconnected" until the next restart.
func (s *sidecar) connectExisting(ctx context.Context) {
	client := s.cli()
	if client == nil {
		return
	}
	// Startup already connected, and a repeated login must not dial a second
	// socket: whatsmeow rejects that with ErrAlreadyConnected.
	if client.IsConnected() {
		return
	}
	client.InitialAutoReconnect = true
	s.setState("connecting", "", "")
	if err := client.ConnectContext(ctx); err != nil {
		s.emitError(fmt.Errorf("reconnect: %w", err))
		s.setState("disconnected", s.ownJID(), err.Error())
	}
}

func (s *sidecar) stopQR() {
	s.mu.Lock()
	stop := s.qrStop
	s.qrStop = nil
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func (s *sidecar) readLoop(ctx context.Context) {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			s.out.send(response{OK: false, Error: "malformed request: " + err.Error()})
			continue
		}
		s.handle(ctx, req)
	}
	// stdin closed: the host plugin exited.
	s.stopQR()
	if client := s.cli(); client != nil {
		client.Disconnect()
	}
}

func (s *sidecar) handle(ctx context.Context, req request) {
	switch req.Cmd {
	case "status":
		loggedIn, connected := false, false
		if client := s.cli(); client != nil {
			loggedIn, connected = client.IsLoggedIn(), client.IsConnected()
		}
		s.out.send(response{ID: req.ID, OK: true, Data: map[string]any{
			"state":     s.currentState(),
			"jid":       s.ownJID(),
			"pushName":  s.pushName(),
			"loggedIn":  loggedIn,
			"connected": connected,
		}})

	case "login":
		if client := s.cli(); client != nil && client.IsLoggedIn() {
			s.out.send(response{ID: req.ID, OK: true, Data: map[string]any{"state": "connected"}})
			return
		}
		// A paired device already holds the credentials, so asking for a QR code
		// again would be wrong: reconnect and let the status events report it.
		if s.deviceOf().ID != nil {
			go s.connectExisting(ctx)
			s.out.send(response{ID: req.ID, OK: true, Data: map[string]any{"state": "connecting"}})
			return
		}
		if err := s.startQR(ctx); err != nil {
			s.out.send(response{ID: req.ID, OK: false, Error: err.Error()})
			return
		}
		s.out.send(response{ID: req.ID, OK: true, Data: map[string]any{"state": "qr"}})

	case "logout":
		s.stopQR()
		if client := s.cli(); client != nil {
			if err := client.Logout(ctx); err != nil && !errors.Is(err, whatsmeow.ErrNotLoggedIn) {
				// A failed network logout still leaves the local session
				// unusable, so clear it anyway and report the reason.
				s.emitError(fmt.Errorf("logout: %w", err))
			}
			client.Disconnect()
		}
		s.dropDevice()
		s.setState("logged_out", "", "")
		s.out.send(response{ID: req.ID, OK: true})

	case "send":
		client := s.cli()
		if client == nil || !client.IsLoggedIn() {
			s.out.send(response{ID: req.ID, OK: false, Error: "not logged in"})
			return
		}
		jid, err := types.ParseJID(req.To)
		if err != nil {
			s.out.send(response{ID: req.ID, OK: false, Error: "invalid jid: " + err.Error()})
			return
		}
		resp, err := client.SendMessage(ctx, jid, &waE2E.Message{
			Conversation: proto.String(req.Text),
		})
		if err != nil {
			s.out.send(response{ID: req.ID, OK: false, Error: err.Error()})
			return
		}
		s.out.send(response{ID: req.ID, OK: true, Data: map[string]any{"id": string(resp.ID)}})

	case "shutdown":
		s.out.send(response{ID: req.ID, OK: true})
		s.stopQR()
		if client := s.cli(); client != nil {
			client.Disconnect()
		}
		os.Exit(0)

	default:
		s.out.send(response{ID: req.ID, OK: false, Error: "unknown command: " + req.Cmd})
	}
}

// startQR opens a pairing channel and streams a fresh code per rotation. The
// PNG is rendered here so the browser needs no QR library of its own.
//
// The connection itself must be built on the long-lived process context: the
// frame socket keeps the context it was dialled with, so cancelling the QR
// channel's own context would tear the socket down the instant pairing
// succeeds, and the phone would report that the login failed.
func (s *sidecar) startQR(ctx context.Context) error {
	client := s.cli()
	if client == nil {
		return errors.New("client is not available")
	}
	if client.IsConnected() {
		client.Disconnect()
		// The QR channel requires a socket that is not already connected.
		time.Sleep(100 * time.Millisecond)
	}
	qrCtx, cancel := context.WithCancel(ctx)
	ch, err := client.GetQRChannel(qrCtx)
	if err != nil {
		cancel()
		return fmt.Errorf("open QR channel: %w", err)
	}
	s.mu.Lock()
	s.qrStop = cancel
	s.mu.Unlock()

	if err := client.ConnectContext(ctx); err != nil {
		cancel()
		return fmt.Errorf("connect: %w", err)
	}
	go s.pumpQR(cancel, ch)
	return nil
}

func (s *sidecar) pumpQR(cancel context.CancelFunc, ch <-chan whatsmeow.QRChannelItem) {
	// Stops only the QR emitter; the connection keeps running on the process
	// context, so a successful pairing survives this cancellation.
	defer cancel()
	for item := range ch {
		switch item.Event {
		case whatsmeow.QRChannelEventCode:
			png, err := qrcode.Encode(item.Code, qrcode.Medium, 512)
			if err != nil {
				s.emitError(fmt.Errorf("render QR: %w", err))
				continue
			}
			s.setState("qr", "", "")
			s.out.send(event{
				Event:   "qr",
				Code:    item.Code,
				PNG:     "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
				Timeout: int(item.Timeout.Seconds()),
			})
		case whatsmeow.QRChannelEventError:
			s.emitError(item.Error)
			s.setState("logged_out", "", item.Error.Error())
		default:
			// success / timeout / err-* — the client event handler reports the
			// resulting connection state, so only log the terminal item here.
			if item.Event == "success" {
				continue
			}
			s.setState("logged_out", "", item.Event)
		}
	}
}

func (s *sidecar) ownJID() string {
	device := s.deviceOf()
	if device == nil || device.ID == nil {
		return ""
	}
	return device.ID.String()
}

func (s *sidecar) handleEvent(raw any) {
	switch evt := raw.(type) {
	case *events.Connected:
		s.setState("connected", s.ownJID(), "")

	case *events.Disconnected:
		s.setState("disconnected", s.ownJID(), "")

	case *events.LoggedOut:
		s.setState("logged_out", "", "logged out from phone")
		// The server ended this companion session, so the stored credentials can
		// never connect again. Clearing them and rebuilding the client lets the
		// next login offer a fresh QR code.
		s.dropDevice()

	case *events.TemporaryBan:
		s.setState("disconnected", s.ownJID(), "temporary ban: "+evt.String())

	case *events.StreamReplaced:
		s.setState("disconnected", s.ownJID(), "session opened elsewhere")

	case *events.Message:
		s.forwardMessage(evt)

	case *events.Receipt:
		// Read receipts are not bridged; the host plugin does not need them.
	case *events.PairSuccess:
		s.setState("connected", s.ownJID(), "")
	}
}

func (s *sidecar) forwardMessage(evt *events.Message) {
	info := evt.Info
	kind, text := describeMessage(evt.Message)
	if kind == "" {
		return
	}
	name := info.Chat.User
	if info.IsGroup {
		name = info.Chat.String()
	}
	s.out.send(event{
		Event:     "message",
		ID:        string(info.ID),
		Chat:      info.Chat.String(),
		ChatName:  name,
		Sender:    info.Sender.String(),
		SenderPN:  s.phoneJID(info.Sender),
		ChatPN:    s.phoneJID(info.Chat),
		Text:      text,
		Kind:      kind,
		Timestamp: info.Timestamp.Unix(),
		FromMe:    info.IsFromMe,
		IsGroup:   info.IsGroup,
	})
}

// phoneJID returns the phone-number form of a JID. A LID is mapped back
// through the stored LID/PN table; anything else already is a phone JID, and
// an unmapped LID falls back to itself so the caller always gets an identity.
func (s *sidecar) phoneJID(jid types.JID) string {
	if jid.Server != types.HiddenUserServer {
		return jid.String()
	}
	client := s.cli()
	if client == nil {
		return jid.String()
	}
	pn, err := client.Store.LIDs.GetPNForLID(context.Background(), jid)
	if err != nil || pn.IsEmpty() {
		return jid.String()
	}
	return pn.String()
}

// describeMessage returns the message kind and its user-visible text. An
// empty kind means the message carries nothing worth bridging.
func describeMessage(m *waE2E.Message) (kind, text string) {
	if m == nil {
		return "", ""
	}
	switch {
	case m.GetConversation() != "":
		return "text", m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		return "text", m.GetExtendedTextMessage().GetText()
	case m.GetImageMessage() != nil:
		return "image", m.GetImageMessage().GetCaption()
	case m.GetVideoMessage() != nil:
		return "video", m.GetVideoMessage().GetCaption()
	case m.GetDocumentMessage() != nil:
		return "document", m.GetDocumentMessage().GetCaption()
	case m.GetAudioMessage() != nil:
		return "audio", ""
	case m.GetStickerMessage() != nil:
		return "sticker", ""
	case m.GetLocationMessage() != nil:
		loc := m.GetLocationMessage()
		return "location", fmt.Sprintf("%f,%f", loc.GetDegreesLatitude(), loc.GetDegreesLongitude())
	case m.GetReactionMessage() != nil:
		return "reaction", m.GetReactionMessage().GetText()
	case m.GetProtocolMessage() != nil:
		return "", ""
	default:
		return "other", ""
	}
}
