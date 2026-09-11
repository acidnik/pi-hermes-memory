/**
 * Tracks the currently active session id in this extension process.
 *
 * Served from session_start (the interactive/RPC session the user is in) and
 * used by the memory write path: just-written facts are marked as already
 * injected for this session so auto-retrieval does not immediately show them
 * again. Background subprocess children set their own id on their
 * session_start; their writes are attributed to their own (irrelevant)
 * session, which is harmless.
 */

let currentSessionId: string | undefined;

export function setCurrentSessionId(id: string | undefined): void {
  currentSessionId = id || undefined;
}

export function getCurrentSessionId(): string | undefined {
  return currentSessionId;
}