import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
for (const d of [DATA_DIR, FILES_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'workspace.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- A tenant: one company with its own users, admins, domains and chat.
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  allow_external INTEGER NOT NULL DEFAULT 1,  -- may share/DM with other companies
  quota_mb INTEGER NOT NULL DEFAULT 0,        -- 0 = unlimited
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS domains (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
-- username is the sign-in address: local@domain (domain belongs to the user's org).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,        -- admin of their org
  is_super INTEGER NOT NULL DEFAULT 0,        -- platform owner: manages all orgs
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folder','file','doc','sheet')),
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  storage TEXT,
  content TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  trashed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS files_parent ON files(parent_id);
CREATE INDEX IF NOT EXISTS files_owner ON files(owner_id);
CREATE TABLE IF NOT EXISTS shares (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  PRIMARY KEY (file_id, user_id)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  color TEXT
);
CREATE INDEX IF NOT EXISTS events_owner_start ON events(owner_id, start);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT, phone TEXT, company TEXT, notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,  -- NULL for direct messages
  name TEXT NOT NULL,
  dm_key TEXT UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, created_at);
`);

const cache = new Map();
/** Cached prepared statement. */
export function q(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- migrations from v0.1 (single-company) ----------
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('users', 'org_id')) db.exec('ALTER TABLE users ADD COLUMN org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE');
if (!hasColumn('users', 'is_super')) db.exec('ALTER TABLE users ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('channels', 'org_id')) db.exec('ALTER TABLE channels ADD COLUMN org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE');
db.exec('CREATE INDEX IF NOT EXISTS users_org ON users(org_id)');

// ---------- email (v0.3) ----------
if (!hasColumn('users', 'mail_hash')) db.exec('ALTER TABLE users ADD COLUMN mail_hash TEXT');            // Dovecot SHA512-CRYPT
if (!hasColumn('users', 'mail_quota_mb')) db.exec('ALTER TABLE users ADD COLUMN mail_quota_mb INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('domains', 'dkim_private')) db.exec('ALTER TABLE domains ADD COLUMN dkim_private TEXT');
if (!hasColumn('domains', 'catchall')) db.exec('ALTER TABLE domains ADD COLUMN catchall TEXT');   // mailbox for unknown addresses
if (!hasColumn('domains', 'dkim_public')) db.exec('ALTER TABLE domains ADD COLUMN dkim_public TEXT');   // base64 SPKI for the DNS record
// Mail-app password: when set, mail apps (IMAP/SMTP) must use it instead of the account password.
if (!hasColumn('users', 'mail_app_hash')) db.exec('ALTER TABLE users ADD COLUMN mail_app_hash TEXT');
if (!hasColumn('users', 'mail_app_created')) db.exec('ALTER TABLE users ADD COLUMN mail_app_created INTEGER');
// Repeating events: the rule (JSON), skipped occurrences, and when the series ends (for queries).
if (!hasColumn('events', 'rrule')) db.exec('ALTER TABLE events ADD COLUMN rrule TEXT');
if (!hasColumn('events', 'exdates')) db.exec("ALTER TABLE events ADD COLUMN exdates TEXT NOT NULL DEFAULT '[]'");
if (!hasColumn('events', 'repeat_until')) db.exec('ALTER TABLE events ADD COLUMN repeat_until INTEGER');
// Company setting: everyone must use two-step verification for web sign-in.
if (!hasColumn('orgs', 'require_2fa')) db.exec('ALTER TABLE orgs ADD COLUMN require_2fa INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS two_factor (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,                  -- base32 key shared with the authenticator app
  enabled INTEGER NOT NULL DEFAULT 0,    -- 0 while being set up (not yet confirmed with a code)
  last_step INTEGER NOT NULL DEFAULT -1, -- last 30-second step used, so a code works once
  recovery TEXT NOT NULL DEFAULT '[]',   -- JSON list of sha256 hashes of unused recovery codes
  enabled_at INTEGER
)`);
// Public share links: anyone with the link can open a file or folder, without an account.
if (!hasColumn('orgs', 'allow_links')) db.exec('ALTER TABLE orgs ADD COLUMN allow_links INTEGER NOT NULL DEFAULT 1');
db.exec(`CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,            -- the secret part of the link
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                    -- null: never
  password_hash TEXT,                    -- null: no password
  opens INTEGER NOT NULL DEFAULT 0,
  last_opened INTEGER
)`);
db.exec('CREATE INDEX IF NOT EXISTS share_links_file ON share_links(file_id)');
// Where each mailbox lives on the mail server. Null: the usual /var/vmail/<domain>/<name>. A renamed
// person keeps their mailbox where it was; a mailbox left by someone deleted or renamed is never
// handed to a new person who later gets that address.
if (!hasColumn('users', 'mail_home')) db.exec('ALTER TABLE users ADD COLUMN mail_home TEXT');
db.exec('CREATE TABLE IF NOT EXISTS retired_mail_homes (path TEXT PRIMARY KEY, retired_at INTEGER NOT NULL)');
// Earlier versions of files: replaced uploads, and Docs/Sheets as they were before each editing session.
db.exec(`CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,     -- the file's version number then
  name TEXT NOT NULL,           -- its name then
  saved_at INTEGER NOT NULL,    -- when that version was made
  saved_by TEXT,                -- who made it
  size INTEGER NOT NULL,
  mime TEXT,
  storage TEXT,                 -- uploaded files: the stored bytes
  content TEXT                  -- Docs and Sheets: the JSON content
)`);
db.exec('CREATE INDEX IF NOT EXISTS file_versions_file ON file_versions(file_id, saved_at)');
// Signed-in devices: when, from what browser/address, and last activity of each session.
if (!hasColumn('sessions', 'created_at')) db.exec('ALTER TABLE sessions ADD COLUMN created_at INTEGER');
if (!hasColumn('sessions', 'last_seen')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen INTEGER');
if (!hasColumn('sessions', 'user_agent')) db.exec('ALTER TABLE sessions ADD COLUMN user_agent TEXT');
if (!hasColumn('sessions', 'ip')) db.exec('ALTER TABLE sessions ADD COLUMN ip TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS aliases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  targets TEXT NOT NULL,              -- comma-separated addresses (internal or external)
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vacations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  start_date TEXT,                    -- YYYY-MM-DD, inclusive (mail server time zone)
  end_date TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_rules (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rules TEXT NOT NULL,                -- JSON: ordered list, see mail/sieve.js
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_signatures (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  html TEXT NOT NULL DEFAULT '',
  on_new INTEGER NOT NULL DEFAULT 1,
  on_reply INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
-- One signature per sending address (own address and each alias the user belongs to).
CREATE TABLE IF NOT EXISTS identity_signatures (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  html TEXT NOT NULL DEFAULT '',
  on_new INTEGER NOT NULL DEFAULT 1,
  on_reply INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, address)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Move users who predate companies into a default company with a placeholder domain.
if (db.prepare('SELECT 1 FROM users WHERE org_id IS NULL').get()) {
  tx(() => {
    const orgId = crypto.randomUUID();
    const domain = 'workspace.local';
    db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(orgId, 'My company', Date.now());
    db.prepare('INSERT OR IGNORE INTO domains (name, org_id, created_at) VALUES (?, ?, ?)').run(domain, orgId, Date.now());
    for (const u of db.prepare('SELECT id, username FROM users WHERE org_id IS NULL').all()) {
      const address = u.username.includes('@') ? u.username : `${u.username}@${domain}`;
      db.prepare('UPDATE users SET org_id = ?, username = ? WHERE id = ?').run(orgId, address, u.id);
    }
    // The first admin becomes the platform owner.
    const first = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1').get();
    if (first && !db.prepare('SELECT 1 FROM users WHERE is_super = 1').get()) db.prepare('UPDATE users SET is_super = 1 WHERE id = ?').run(first.id);
    db.prepare("UPDATE channels SET org_id = ? WHERE org_id IS NULL AND dm_key IS NULL").run(orgId);
  });
}

// v0.7 signatures (one per user) become the signature of the user's own address.
db.exec(`INSERT OR IGNORE INTO identity_signatures (user_id, address, html, on_new, on_reply, updated_at)
         SELECT s.user_id, u.username, s.html, s.on_new, s.on_reply, s.updated_at
         FROM mail_signatures s JOIN users u ON u.id = s.user_id`);
db.exec('DELETE FROM mail_signatures');
