import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

function normalizeRoutePath(value, fallback = "/admin") {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }

  const normalized = `/${raw}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "/" ? fallback : normalized;
}

export const ROOT_DIR = path.resolve(process.cwd());
export const FRONTEND_DIST_DIR =
  process.env.FRONTEND_DIST_DIR || path.join(ROOT_DIR, "ui", "dist");
export const DB_PATH =
  process.env.DB_PATH || path.join(ROOT_DIR, "outlook_manager.db");

export const PORT = Number(process.env.NODE_BACKEND_PORT || 5002);
export const HOST = process.env.NODE_BACKEND_HOST || "0.0.0.0";
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin123";
export const ADMIN_PATH = normalizeRoutePath(process.env.ADMIN_PATH || "/admin");
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

export const CLIENT_ID =
  process.env.CLIENT_ID || "dbc8e03a-b00c-46bd-ae65-b683e7707cb0";
export const TOKEN_URL =
  process.env.TOKEN_URL ||
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
export const ACCESS_TOKEN_CACHE_SKEW_MS = Number(
  process.env.ACCESS_TOKEN_CACHE_SKEW_MS || 60000
);

export const IMAP_SERVER = process.env.IMAP_SERVER || "outlook.live.com";
export const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
export const INBOX_FOLDER_NAME = process.env.INBOX_FOLDER_NAME || "INBOX";
export const JUNK_FOLDER_NAME = process.env.JUNK_FOLDER_NAME || "Junk";
export const DEFAULT_EMAIL_LIMIT = Number(process.env.DEFAULT_EMAIL_LIMIT || 1);
export const IMAP_CONNECTION_TIMEOUT = Number(
  process.env.IMAP_CONNECTION_TIMEOUT || 15000
);
export const IMAP_GREETING_TIMEOUT = Number(
  process.env.IMAP_GREETING_TIMEOUT || 10000
);
export const IMAP_SOCKET_TIMEOUT = Number(
  process.env.IMAP_SOCKET_TIMEOUT || 60000
);
export const IMAP_PARSE_CONCURRENCY = Number(
  process.env.IMAP_PARSE_CONCURRENCY || 2
);
export const IMAP_RESOLVE_INLINE_IMAGES =
  String(process.env.IMAP_RESOLVE_INLINE_IMAGES || "false").toLowerCase() ===
  "true";
export const MAILPARSER_MAX_HTML_LENGTH = Number(
  process.env.MAILPARSER_MAX_HTML_LENGTH || 262144
);
