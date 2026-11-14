-- perchlight-ask v0.1 schema (docs/SDD.md, "Data model (D1)").
-- Times are milliseconds since the epoch (INTEGER) unless named *_day.

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                  -- github | sitemap | upload
  config TEXT NOT NULL,                -- JSON, from ask.json (no secrets)
  location TEXT NOT NULL DEFAULT '',   -- shown in the app
  verified_at INTEGER,                 -- sitemap ownership proof last seen
  every_ms INTEGER NOT NULL DEFAULT 86400000,
  next_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',  -- new | running | ok | failed | paused | paused_budget | unverified | config_error
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT,
  last_error TEXT,
  docs INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  requested_action TEXT                -- reingest | pause | resume (set by the app, done by the Keeper)
);

CREATE TABLE docs (
  id TEXT PRIMARY KEY,                 -- sha256(source, path)
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  etag TEXT,                           -- GitHub blob sha or HTTP ETag
  content_hash TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',   -- ok | over_cap | too_large | failed
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (source_id, path)
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,                 -- sha256(source, doc path, heading path, ordinal)
  doc_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedded_at INTEGER
);
CREATE INDEX chunks_doc ON chunks (doc_id);
CREATE INDEX chunks_unembedded ON chunks (embedded_at) WHERE embedded_at IS NULL;

-- Keyword index: FTS5 with external content on chunks (verified in miniflare
-- on 2026-11-12; see README "Keyword search").
CREATE VIRTUAL TABLE chunks_fts USING fts5 (text, heading_path, content = 'chunks', content_rowid = 'rowid', tokenize = 'porter unicode61');
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text, heading_path) VALUES (new.rowid, new.text, new.heading_path);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text, heading_path) VALUES ('delete', old.rowid, old.text, old.heading_path);
END;
CREATE TRIGGER chunks_au AFTER UPDATE OF text, heading_path ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text, heading_path) VALUES ('delete', old.rowid, old.text, old.heading_path);
  INSERT INTO chunks_fts (rowid, text, heading_path) VALUES (new.rowid, new.text, new.heading_path);
END;

-- Markdown uploaded through PUT /api/docs/:slug (ingested by the Keeper).
CREATE TABLE uploads (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ingest_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  docs_seen INTEGER NOT NULL DEFAULT 0,
  docs_changed INTEGER NOT NULL DEFAULT 0,
  chunks_embedded INTEGER NOT NULL DEFAULT 0,
  neurons REAL NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0, -- percent
  status TEXT NOT NULL,                -- running | ok | failed | paused_budget
  error TEXT
);
CREATE INDEX ingest_runs_started ON ingest_runs (started_at);

CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,              -- redacted
  answer TEXT NOT NULL,
  chunk_ids TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL,            -- high | low | none
  mode TEXT NOT NULL,                  -- full | lean | search | cache
  neurons REAL NOT NULL DEFAULT 0,
  helpful INTEGER,
  cached INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX asks_at ON asks (at);

CREATE TABLE answer_cache (
  key TEXT PRIMARY KEY,
  docs_version INTEGER NOT NULL,
  response TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL,                -- queued | drafted | skipped | unparsed | failed
  skip_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT ''       -- e.g. "possible prompt injection"
);
CREATE INDEX emails_status ON emails (status, next_at);
CREATE INDEX emails_received ON emails (received_at);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  from_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  chunk_ids TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL,
  needs_you INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '',
  mailto TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',  -- new | approved | sending | sent | discarded
  requested_action TEXT,               -- approve | discard (set by the app, done by the Keeper)
  decided_at INTEGER,
  send_result TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX drafts_status ON drafts (status);
CREATE INDEX drafts_created ON drafts (created_at);

-- Owner digests and approved replies (claim-then-send, as perchlight-forms).
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                  -- digest | reply
  draft_id TEXT,
  channel TEXT NOT NULL,               -- send_email | resend
  status TEXT NOT NULL,                -- pending | sending | retry | sent | failed | unknown
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT,                           -- digests only (subjects, no customer text)
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX deliveries_due ON deliveries (status, next_at);

-- Rate counters: key = "ip:<hash>", "s:<session>", "k:<api key name>", "inbox", by UTC day.
CREATE TABLE rate (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
) WITHOUT ROWID;

-- One row per UTC day: the footprint and anonymous counters.
CREATE TABLE daily (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  asks INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  search INTEGER NOT NULL DEFAULT 0,
  idk INTEGER NOT NULL DEFAULT 0,
  not_logged INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0,
  emails INTEGER NOT NULL DEFAULT 0,
  d1_rows_written INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT INTO state (k, v) VALUES ('docs_version', '1'), ('schema_version', '1');

-- The budget, mirrored by the Keeper after each change, for the app's Budget screen.
CREATE TABLE budget_days (
  day TEXT PRIMARY KEY,
  used REAL NOT NULL DEFAULT 0,
  questions REAL NOT NULL DEFAULT 0,
  inbox REAL NOT NULL DEFAULT 0,
  ingest REAL NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'full',
  exhausted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
