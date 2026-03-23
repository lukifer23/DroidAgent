import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull()
});

export const passkeys = sqliteTable("passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports").notNull().default("[]"),
  deviceType: text("device_type").notNull().default("singleDevice"),
  backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at")
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull()
});

export const authChallenges = sqliteTable("auth_challenges", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  challenge: text("challenge").notNull(),
  userId: text("user_id"),
  rpId: text("rp_id").notNull(),
  origin: text("origin").notNull(),
  createdAt: text("created_at").notNull()
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  command: text("command").notNull(),
  cwd: text("cwd").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  exitCode: integer("exit_code"),
  lastLine: text("last_line").notNull().default("")
});

