/**
 * Document state: annotations, selection, active tool, undo/redo.
 *
 * A ~90-line observable store rather than a framework. The whole app has one
 * writer (the viewer) and a handful of readers (toolbar, annotation layer,
 * exporter), so a pub/sub with immutable snapshots is enough — and it keeps the
 * shipped bundle small, which matters for extension review and startup latency.
 */
import type { Annotation, ToolId, Preferences } from './types';
import { DEFAULT_PREFS } from './types';

export interface State {
  tool: ToolId;
  annotations: Annotation[];
  selectedId: string | null;
  /** Id of the annotation whose text is currently being edited in-place. */
  editingId: string | null;
  prefs: Preferences;
  /** Signature chosen in the modal, waiting to be stamped on the next click. */
  pendingSignature: { dataUrl: string; aspect: number } | null;
  dirty: boolean;
}

type Listener = (s: State) => void;

const HISTORY_LIMIT = 100;

export class Store {
  private state: State = {
    tool: 'select',
    annotations: [],
    selectedId: null,
    editingId: null,
    prefs: { ...DEFAULT_PREFS },
    pendingSignature: null,
    dirty: false,
  };

  private listeners = new Set<Listener>();
  private undoStack: Annotation[][] = [];
  private redoStack: Annotation[][] = [];

  get(): Readonly<State> {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** Patch non-document state (tool, selection, prefs) — not undoable. */
  set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /**
   * Mutate the annotation list through a transaction so undo/redo and the
   * dirty flag stay correct no matter which call site made the change.
   */
  private commit(next: Annotation[]): void {
    this.undoStack.push(this.state.annotations);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.state = { ...this.state, annotations: next, dirty: true };
    this.emit();
  }

  add(a: Annotation): void {
    this.commit([...this.state.annotations, a]);
  }

  update(id: string, patch: Partial<Annotation>): void {
    this.commit(
      this.state.annotations.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)),
    );
  }

  /**
   * Live drag/resize: rewrites the last history entry instead of pushing a new
   * one, so a 200-frame drag collapses into a single undo step.
   */
  updateTransient(id: string, patch: Partial<Annotation>, first: boolean): void {
    if (first) {
      this.undoStack.push(this.state.annotations);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this.state = {
      ...this.state,
      annotations: this.state.annotations.map((a) =>
        a.id === id ? ({ ...a, ...patch } as Annotation) : a,
      ),
      dirty: true,
    };
    this.emit();
  }

  remove(id: string): void {
    const next = this.state.annotations.filter((a) => a.id !== id);
    if (next.length === this.state.annotations.length) return;
    this.commit(next);
    if (this.state.selectedId === id) this.set({ selectedId: null, editingId: null });
  }

  byId(id: string | null): Annotation | undefined {
    return id ? this.state.annotations.find((a) => a.id === id) : undefined;
  }

  onPage(page: number): Annotation[] {
    return this.state.annotations.filter((a) => a.page === page);
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.state.annotations);
    this.state = { ...this.state, annotations: prev, selectedId: null, editingId: null, dirty: true };
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.state.annotations);
    this.state = { ...this.state, annotations: next, selectedId: null, editingId: null, dirty: true };
    this.emit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  markClean(): void {
    this.set({ dirty: false });
  }
}

export const uid = (): string =>
  `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
