import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists } from "../config/paths.js";
import { writeJsonAtomic } from "../config/json-store.js";

/**
 * Session URL persistence (user decision 2026-09-04, reversing the V2
 * "Temporary Chats only" stance): each workspace keeps ONE persistent
 * ChatGPT conversation. Its URL is stored locally so a later Codex session
 * reopens the SAME chat — conversation context survives restarts. Task
 * continuity still lives in the execution records; this only restores the
 * conversation itself.
 *
 * Convenience state, not security state: a corrupt/missing file simply means
 * "no saved session" (the skill falls back to a new chat), so reads are
 * lenient while writes stay atomic.
 */

export interface SavedSession {
  /** The workspace's persistent ChatGPT conversation (https://chatgpt.com/c/...). */
  url?: string;
  title?: string;
  /** Last task worked on in this conversation (cross-link to execution records). */
  taskId?: string;
  iteration?: number;
  /** Last protocol state sent/observed (INIT/PLAN/EXECUTED/DONE/BLOCKED...). */
  lastState?: string;
  /** ChatGPT connector title bound to this workspace (diagnostic). */
  connectorName?: string;
  savedAt: string;
}

export interface SessionPatch {
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  connectorName?: string;
  /** Drop everything except the timestamp (conversation deleted / starting over). */
  clear?: boolean;
}

export function sessionFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "sessions")), `${workspaceId}.json`);
}

export function readSession(workspaceId: string): SavedSession | null {
  return readJsonIfExists<SavedSession>(sessionFile(workspaceId));
}

const CHAT_URL_RE = /^\/c\/([A-Za-z0-9-]+)\/?$/;

/**
 * Accept only a real ChatGPT conversation URL — never a bare chatgpt.com
 * start page, settings page, or a foreign host (those would silently send
 * the next session's C2C messages to the wrong place).
 */
export function normalizeChatUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:") return null;
    if (
      parsed.hostname !== "chatgpt.com" &&
      parsed.hostname !== "www.chatgpt.com" &&
      parsed.hostname !== "chat.openai.com"
    ) {
      return null;
    }
    const match = parsed.pathname.match(CHAT_URL_RE);
    if (!match) return null;
    return `https://chatgpt.com/c/${match[1]}`;
  } catch {
    return null;
  }
}

function pick<T>(patchValue: T | undefined, previousValue: T | undefined): T | undefined {
  return patchValue !== undefined ? patchValue : previousValue;
}

/** Merge a patch into the saved session; URL is normalized before storing. */
export function saveSession(workspaceId: string, patch: SessionPatch): SavedSession {
  if (patch.clear) {
    return writeSession(workspaceId, { savedAt: new Date().toISOString() });
  }
  const previous = readSession(workspaceId);
  let url = pick(patch.url, previous?.url);
  if (patch.url !== undefined) {
    const normalized = normalizeChatUrl(patch.url);
    if (!normalized) {
      throw new Error("session URL must look like https://chatgpt.com/c/<conversation-id>");
    }
    url = normalized;
  }
  const title = pick(patch.title, previous?.title);
  const taskId = pick(patch.taskId, previous?.taskId);
  const iteration = pick(patch.iteration, previous?.iteration);
  const lastState = pick(patch.lastState, previous?.lastState);
  const connectorName = pick(patch.connectorName, previous?.connectorName);
  return writeSession(workspaceId, {
    ...(url ? { url } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
    ...(lastState !== undefined ? { lastState } : {}),
    ...(connectorName !== undefined ? { connectorName } : {}),
    savedAt: new Date().toISOString(),
  });
}

export function writeSession(workspaceId: string, session: SavedSession): SavedSession {
  writeJsonAtomic(sessionFile(workspaceId), session);
  return session;
}
