package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"

	_ "modernc.org/sqlite"
)

// TestDeviceSurvivesRestart pins the "remember me" contract: a paired device is
// written to the database, and reopening that database returns it with its JID
// set. The sidecar reconnects exactly when that JID is present, so a regression
// here would silently force a new QR scan after every restart.
func TestDeviceSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "store.db")
	dsn := "file:" + path + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"

	open := func() *sqlstore.Container {
		db, err := sql.Open("sqlite", dsn)
		if err != nil {
			t.Fatalf("open database: %v", err)
		}
		t.Cleanup(func() { _ = db.Close() })
		container := sqlstore.NewWithDB(db, "sqlite3", nil)
		if err := container.Upgrade(ctx); err != nil {
			t.Fatalf("upgrade database: %v", err)
		}
		return container
	}

	// A fresh database yields an unpaired device, which is what makes the
	// sidecar report logged_out and offer a QR code.
	first := open()
	device, err := first.GetFirstDevice(ctx)
	if err != nil {
		t.Fatalf("load device: %v", err)
	}
	if device.ID != nil {
		t.Fatalf("fresh database reported a paired device: %v", device.ID)
	}

	// Pairing sets the JID and saves; this is what whatsmeow does on success.
	jid := types.NewJID("628123456789", types.DefaultUserServer)
	device.ID = &jid
	device.PushName = "Tester"
	// Pairing fills the device identity before saving; PutDevice reads it.
	device.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte{1, 2, 3},
		AccountSignature:    make([]byte, 64),
		AccountSignatureKey: make([]byte, 32),
		DeviceSignature:     make([]byte, 64),
	}
	if err := device.Save(ctx); err != nil {
		t.Fatalf("save paired device: %v", err)
	}

	// Reopening is the restart: the same device must come back, JID included.
	second := open()
	restored, err := second.GetFirstDevice(ctx)
	if err != nil {
		t.Fatalf("reload device: %v", err)
	}
	if restored.ID == nil {
		t.Fatal("paired device did not survive: restart would demand a new QR scan")
	}
	if restored.ID.String() != jid.String() {
		t.Fatalf("restored JID = %q, want %q", restored.ID, jid)
	}
	if restored.PushName != "Tester" {
		t.Fatalf("restored push name = %q, want Tester", restored.PushName)
	}
}
