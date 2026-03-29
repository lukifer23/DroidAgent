import fs from "node:fs";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { ensureAppDirs, paths } from "../env.js";
import * as schema from "./schema.js";

ensureAppDirs();
fs.mkdirSync(paths.appDir, { recursive: true });

const sqlite = new Database(paths.dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    device_type TEXT NOT NULL DEFAULT 'singleDevice',
    backed_up INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    challenge TEXT NOT NULL,
    user_id TEXT,
    rp_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    exit_code INTEGER,
    last_line TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS memory_drafts (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_label TEXT,
    source_ref TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    applied_at TEXT,
    dismissed_at TEXT,
    failed_at TEXT,
    last_error TEXT,
    applied_path TEXT
  );
  CREATE TABLE IF NOT EXISTS maintenance_operations (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    action TEXT NOT NULL,
    phase TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    requested_by_user_id TEXT,
    requested_from_localhost INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    last_error TEXT
  );
`);

export const db = drizzle(sqlite, { schema });
export { schema };
