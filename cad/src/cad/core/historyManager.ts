import type { CadDocument } from "./types";
import { cloneDocument } from "./factories";

export interface HistoryEntry {
  label: string;
  doc: CadDocument;
  selection: string[];
  at: number;
}

/**
 * CADHistoryManager — snapshot undo/redo.
 *
 * Snapshots are whole-document clones. That is deliberately boring: it makes
 * every operation undoable with zero per-operation bookkeeping, including
 * boolean/hole/fillet features, grouping and deletions. Mesh assets are shared
 * by reference, so a snapshot costs kilobytes, not megabytes.
 */
export class CADHistoryManager {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  private limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
  }

  /** Record the state BEFORE a change. Call this from the store's commit(). */
  push(label: string, doc: CadDocument, selection: string[]) {
    this.past.push({ label, doc: cloneDocument(doc), selection: [...selection], at: Date.now() });
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  undo(current: CadDocument, selection: string[]): HistoryEntry | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, doc: cloneDocument(current), selection: [...selection], at: Date.now() });
    return entry;
  }

  redo(current: CadDocument, selection: string[]): HistoryEntry | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, doc: cloneDocument(current), selection: [...selection], at: Date.now() });
    return entry;
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
  }

  /** Labels, newest first, for the history panel. */
  timeline(): { label: string; at: number; direction: "undo" | "redo" }[] {
    return [
      ...this.future.map((e) => ({ label: e.label, at: e.at, direction: "redo" as const })).reverse(),
      ...this.past.map((e) => ({ label: e.label, at: e.at, direction: "undo" as const })).reverse(),
    ];
  }
}
