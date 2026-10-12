import type { CadDocument } from "./types";
import { deserializeProject, serializeProject, type SerializedProject } from "./serialization";

/**
 * Autosave to IndexedDB.
 *
 * IndexedDB rather than localStorage: an imported AI mesh blows past the ~5 MB
 * localStorage quota immediately, and IndexedDB stores the serialized record
 * without a second string copy.
 */

const DB_NAME = "webcad";
const DB_VERSION = 1;
const STORE = "projects";
const AUTOSAVE_KEY = "autosave";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is unavailable in this browser"));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open the local database"));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Autosave write failed"));
  });
}

async function get<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error ?? new Error("Autosave read failed"));
  });
}

export async function saveAutosave(doc: CadDocument): Promise<void> {
  await put(AUTOSAVE_KEY, serializeProject(doc));
}

export async function loadAutosave(): Promise<CadDocument | null> {
  const record = await get<SerializedProject>(AUTOSAVE_KEY);
  if (!record) return null;
  return deserializeProject(record);
}

export async function clearAutosave(): Promise<void> {
  await put(AUTOSAVE_KEY, undefined);
}

/** Trailing-edge debounce; the last document wins. */
export function createAutosaver(delayMs = 800) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingDoc: CadDocument | null = null;
  let onError: ((err: Error) => void) | null = null;

  return {
    onError(handler: (err: Error) => void) {
      onError = handler;
    },
    schedule(doc: CadDocument) {
      pendingDoc = doc;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const target = pendingDoc;
        pendingDoc = null;
        if (!target) return;
        saveAutosave(target).catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))));
      }, delayMs);
    },
    flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const target = pendingDoc;
      pendingDoc = null;
      return target ? saveAutosave(target) : Promise.resolve();
    },
  };
}
