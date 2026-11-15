import {
  buildPayload,
  detectSourceFormat,
  type ConversionEngine,
  type ConversionResult,
} from "./converter";
import type { IngestResult } from "./knowledgeBase";
import type { DocumentPayload, SourceFormat } from "./types";

/**
 * The life of one uploaded file:
 *
 *   queued → converting → ready ──approve──→ approved → sending → done
 *                       ↘ (Markdown/text) ──────────↗
 *   any failure → error (retry resumes from the failed step)
 *
 * A PDF stops at `ready` because the converter can flatten YAML and code
 * blocks, and the user is the only one who can repair that before it is
 * indexed. Markdown and text arrive exactly as written, so they skip approval.
 */
export type UploadStage =
  "queued" | "converting" | "ready" | "approved" | "sending" | "done" | "error";

export interface UploadItem {
  readonly id: string;
  readonly fileName: string;
  /** Null for a file of a format the panel cannot read; it fails on conversion. */
  readonly sourceFormat: SourceFormat | null;
  readonly stage: UploadStage;
  readonly engine: ConversionEngine | null;
  /** The converted (and possibly hand-edited) text — exactly what gets sent. */
  readonly markdown: string;
  readonly error: string;
  /** The step an error happened in, which is where `retry` resumes. */
  readonly failedAt: "convert" | "send" | null;
  readonly result: IngestResult | null;
}

export interface UploadQueueState {
  readonly items: readonly UploadItem[];
  /** Document metadata, applied to each document at the moment it is sent. */
  readonly author: string;
  readonly date: Date;
}

export interface UploadQueueDeps {
  convert: (file: File, signal: AbortSignal) => Promise<ConversionResult>;
  ingest: (payload: DocumentPayload, signal: AbortSignal) => Promise<IngestResult>;
  /** The author from Settings, used while the page has none of its own. */
  defaultAuthor: () => string;
  now: () => Date;
  /** After every send that may have changed the knowledge base. */
  onKnowledgeBaseChanged?: () => void;
  /** Null disables persistence (and keeps tests hermetic). */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** See `SEND_FAILURE_GRACE_MS`; tests pass 0 to record failures at once. */
  sendFailureGraceMs?: number;
}

export const STORAGE_KEY = "idar.uploadQueue";
/** The single-document draft this queue replaced; migrated once, then removed. */
export const LEGACY_DRAFT_KEY = "idar.docDraft";
const SAVE_DEBOUNCE_MS = 400;
/**
 * How long a failed send stays "sending" before the failure is recorded. A
 * reload or a closed tab kills the request just before the page goes away, and
 * recording that as a failure would persist a bogus "could not reach the
 * knowledge base". Within the grace period the page is gone first, so the
 * document is saved mid-send — that is, as approved — and resent on the next
 * load (ingest is idempotent). A page that stays shows a real failure a moment
 * later.
 */
export const SEND_FAILURE_GRACE_MS = 1000;
/** How long the author must stay unchanged before sends resume after an edit. */
export const AUTHOR_SETTLE_MS = 800;

/** Stages whose text has not been sent yet, so an edit still counts. */
export function isEditable(item: UploadItem): boolean {
  return (
    item.stage === "ready" ||
    item.stage === "approved" ||
    (item.stage === "error" && item.failedAt === "send")
  );
}

/** Files still on their way — the number the sidebar badge shows. */
export function unfinishedCount(items: readonly UploadItem[]): number {
  return items.filter((item) => item.stage !== "done" && item.stage !== "error").length;
}

export type UploadTone = "muted" | "brand" | "warning" | "success" | "danger";

/** How the upload list words a file's state, and in which colour. */
export function describeUpload(
  item: UploadItem,
  authorMissing: boolean,
): { text: string; tone: UploadTone; busy: boolean } {
  switch (item.stage) {
    case "queued":
      return item.sourceFormat === "pdf"
        ? { text: "Waiting for the converter", tone: "muted", busy: false }
        : { text: "Reading the file…", tone: "muted", busy: true };
    case "converting":
      return item.sourceFormat === "pdf"
        ? { text: "Converting to Markdown (Docling)…", tone: "brand", busy: true }
        : { text: "Reading the file…", tone: "muted", busy: true };
    case "ready":
      return { text: "Converted — review and approve", tone: "warning", busy: false };
    case "approved":
      return authorMissing
        ? { text: "Waiting for an author", tone: "warning", busy: false }
        : { text: "Waiting to be sent", tone: "muted", busy: false };
    case "sending":
      return { text: "Sending to the knowledge base…", tone: "brand", busy: true };
    case "done": {
      const result = item.result;
      if (result?.alreadyExists) {
        return { text: "Already in the knowledge base", tone: "success", busy: false };
      }
      const count = result?.chunkCount ?? 0;
      return {
        text: `Added to the knowledge base (${count} fragment${count === 1 ? "" : "s"})`,
        tone: "success",
        busy: false,
      };
    }
    case "error":
      return {
        text: item.error || (item.failedAt === "send" ? "Sending failed." : "Processing failed."),
        tone: "danger",
        busy: false,
      };
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export class UploadQueue {
  private state: UploadQueueState;
  private readonly listeners = new Set<() => void>();
  /** Only files still waiting for conversion: a File cannot be persisted, and
   * once converted it is no longer needed. */
  private readonly files = new Map<string, File>();
  /** One per request in flight. A finished request whose controller is no
   * longer here was cancelled, and its outcome is dropped. */
  private readonly controllers = new Map<string, AbortController>();
  private started = false;
  private nextId = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while the author is being typed — see `setAuthor`. */
  private authorTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly deps: UploadQueueDeps;

  constructor(deps: UploadQueueDeps) {
    this.deps = deps;
    const restored = this.load();
    this.state = {
      items: restored.items,
      // `||` (not `??`): an empty author restored from storage must not shadow
      // the default author configured later in Settings.
      author: restored.author || deps.defaultAuthor(),
      date: deps.now(),
    };
  }

  // --- React binding (useSyncExternalStore) ---------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UploadQueueState => this.state;

  /**
   * Starts processing — including documents restored from storage that were
   * approved but not yet sent. Kept out of the constructor so that building a
   * queue (which StrictMode may do twice) never sends anything by itself.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.pump();
  }

  // --- Commands --------------------------------------------------------------

  add(files: readonly File[]): void {
    const added = files.map((file) => {
      const id = this.newId();
      this.files.set(id, file);
      const item: UploadItem = {
        id,
        fileName: file.name,
        sourceFormat: detectSourceFormat(file),
        stage: "queued",
        engine: null,
        markdown: "",
        error: "",
        failedAt: null,
        result: null,
      };
      return item;
    });
    if (added.length === 0) return;
    this.setState({ items: [...this.state.items, ...added] });
    this.pump();
  }

  /**
   * The field is typed one keystroke at a time, and Markdown is sent without
   * approval — so sending waits until the author stops changing, or the first
   * letter alone would go out as the author. Once it settles, it may be exactly
   * what approved documents were waiting for.
   */
  setAuthor(author: string): void {
    this.setState({ author });
    clearTimeout(this.authorTimer);
    this.authorTimer = setTimeout(() => {
      this.authorTimer = undefined;
      this.pump();
    }, AUTHOR_SETTLE_MS);
  }

  setDate(date: Date): void {
    this.setState({ date });
  }

  editMarkdown(id: string, markdown: string): void {
    this.updateItem(id, (item) => {
      if (!isEditable(item)) return item;
      // Blank text cannot be sent, so it cannot stay approved either.
      const stage = item.stage === "approved" && !markdown.trim() ? "ready" : item.stage;
      return { ...item, markdown, stage };
    });
  }

  approve(id: string): void {
    this.updateItem(id, (item) =>
      item.stage === "ready" && item.markdown.trim() ? { ...item, stage: "approved" } : item,
    );
    this.pump();
  }

  approveAll(): void {
    this.setState({
      items: this.state.items.map((item) =>
        item.stage === "ready" && item.markdown.trim() ? { ...item, stage: "approved" } : item,
      ),
    });
    this.pump();
  }

  retry(id: string): void {
    this.updateItem(id, (item) => {
      if (item.stage !== "error") return item;
      if (item.failedAt === "send") {
        return item.markdown.trim()
          ? { ...item, stage: "approved", error: "", failedAt: null }
          : { ...item, stage: "ready", error: "", failedAt: null };
      }
      // A conversion can only be retried while the file is still in memory.
      return this.files.has(id) ? { ...item, stage: "queued", error: "", failedAt: null } : item;
    });
    this.pump();
  }

  /**
   * Cancels and forgets a file. For a request in flight only the panel stops
   * waiting: a conversion already running in the converter finishes there, and
   * a document already being indexed may still end up in the knowledge base.
   * Removing a sent document from this list does not delete it from the
   * knowledge base.
   */
  remove(id: string): void {
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (!item) return;
    const controller = this.controllers.get(id);
    this.controllers.delete(id);
    this.files.delete(id);
    controller?.abort();
    this.setState({ items: this.state.items.filter((candidate) => candidate.id !== id) });
    if (item.stage === "sending") this.deps.onKnowledgeBaseChanged?.();
    this.pump();
  }

  clearFinished(): void {
    this.setState({ items: this.state.items.filter((item) => item.stage !== "done") });
  }

  // --- Scheduling ------------------------------------------------------------

  /**
   * Starts whatever may run now. PDFs are converted one at a time — the
   * converter runs a single worker, and a second request would only queue
   * there while its client-side timeout ran out. Markdown and text need no
   * converter and start at once. Documents are sent one at a time too, and
   * only once there is a settled author: the knowledge base rejects a document
   * without one.
   */
  private pump(): void {
    if (!this.started) return;

    const pdfBusy = this.state.items.some(
      (item) => item.stage === "converting" && item.sourceFormat === "pdf",
    );
    let pdfStarted = false;
    for (const item of this.state.items) {
      if (item.stage !== "queued") continue;
      if (item.sourceFormat !== "pdf") {
        void this.convert(item.id);
      } else if (!pdfBusy && !pdfStarted) {
        pdfStarted = true;
        void this.convert(item.id);
      }
    }

    const sending = this.state.items.some((item) => item.stage === "sending");
    if (!sending && this.state.author.trim() && this.authorTimer === undefined) {
      const next = this.state.items.find((item) => item.stage === "approved");
      if (next) void this.send(next.id);
    }
  }

  private async convert(id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.updateItem(id, (item) => ({ ...item, stage: "converting" }));

    let next: Partial<UploadItem>;
    try {
      const result = await this.deps.convert(file, controller.signal);
      // Converted text is the whole document, so the file can go — and the
      // user reviews a PDF; Markdown and text go straight to sending.
      this.files.delete(id);
      next = {
        stage: result.engine === "passthrough" ? "approved" : "ready",
        markdown: result.markdown,
        sourceFormat: result.sourceFormat,
        engine: result.engine,
      };
    } catch (err) {
      next = {
        stage: "error",
        failedAt: "convert",
        error: errorMessage(err, "Failed to process the file."),
      };
    }
    if (this.controllers.get(id) !== controller) return; // cancelled meanwhile
    this.controllers.delete(id);
    this.updateItem(id, (item) => ({ ...item, ...next }));
    this.pump();
  }

  private async send(id: string): Promise<void> {
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (!item) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    // The payload is fixed here: edits and metadata changes made after this
    // point no longer reach this document.
    const payload = buildPayload({
      markdown: item.markdown,
      author: this.state.author,
      date: this.state.date,
      fileName: item.fileName,
    });
    this.updateItem(id, (current) => ({ ...current, stage: "sending" }));

    let next: Partial<UploadItem>;
    try {
      const result = await this.deps.ingest(payload, controller.signal);
      next = { stage: "done", result };
    } catch (err) {
      // The text stays: converting and hand-editing it is the expensive part,
      // and it must survive a knowledge base that is down.
      next = {
        stage: "error",
        failedAt: "send",
        error: errorMessage(err, "Failed to send the document."),
      };
    }
    if (next.stage === "error") {
      const grace = this.deps.sendFailureGraceMs ?? SEND_FAILURE_GRACE_MS;
      if (grace > 0) await new Promise((resolve) => setTimeout(resolve, grace));
    }
    if (this.controllers.get(id) !== controller) return; // cancelled meanwhile
    this.controllers.delete(id);
    this.updateItem(id, (current) => ({ ...current, ...next }));
    if (next.stage === "done") this.deps.onKnowledgeBaseChanged?.();
    this.pump();
  }

  // --- State -----------------------------------------------------------------

  private newId(): string {
    // Not crypto.randomUUID: it only exists in a secure context, and the panel
    // may be served over plain http on a cluster address.
    let id: string;
    do {
      id = `upload-${Date.now().toString(36)}-${(this.nextId++).toString(36)}`;
    } while (this.state.items.some((item) => item.id === id));
    return id;
  }

  private updateItem(id: string, update: (item: UploadItem) => UploadItem): void {
    let changed = false;
    const items = this.state.items.map((item) => {
      if (item.id !== id) return item;
      const next = update(item);
      if (next !== item) changed = true;
      return next;
    });
    if (changed) this.setState({ items });
  }

  private setState(patch: Partial<UploadQueueState>): void {
    this.state = { ...this.state, ...patch };
    this.scheduleSave();
    for (const listener of this.listeners) listener();
  }

  // --- Persistence -----------------------------------------------------------

  private scheduleSave(): void {
    if (!this.deps.storage) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  /**
   * Saves now instead of after the debounce. Called when the page is being
   * hidden or unloaded: a debounced save still pending then — or postponed by
   * the timer throttling of a background tab — would otherwise be lost, and
   * the next load would bring back a removed file or un-approve a document.
   */
  flush(): void {
    if (this.saveTimer === undefined) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.save();
  }

  /**
   * Saves what a reload can resume. A file waiting for or in conversion cannot
   * be saved (a File does not survive a reload), so it is dropped. A document
   * caught mid-send is saved as approved: ingest is idempotent — the server
   * answers `already_exists` for identical content — so sending it again is safe.
   */
  private save(): void {
    const storage = this.deps.storage;
    if (!storage) return;
    const items = this.state.items.flatMap((item): UploadItem[] => {
      switch (item.stage) {
        case "ready":
        case "approved":
          return [item];
        case "sending":
          return [{ ...item, stage: "approved" }];
        case "error":
          return item.failedAt === "send" ? [item] : [];
        case "done":
          // The text is in the knowledge base now; keep only the outcome.
          return [{ ...item, markdown: "" }];
        default:
          return [];
      }
    });
    try {
      if (items.length === 0 && !this.state.author) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, JSON.stringify({ author: this.state.author, items }));
    } catch {
      // Quota exceeded (huge converted documents) or storage unavailable —
      // drop the stale copy rather than keep one that no longer matches.
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        // Storage fully unavailable — nothing to clean up.
      }
    }
  }

  private load(): { author: string; items: UploadItem[] } {
    const storage = this.deps.storage;
    if (!storage) return { author: "", items: [] };
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) return parseSaved(JSON.parse(raw));
      return this.migrateLegacyDraft(storage);
    } catch {
      return { author: "", items: [] };
    }
  }

  private migrateLegacyDraft(storage: Pick<Storage, "getItem" | "removeItem">): {
    author: string;
    items: UploadItem[];
  } {
    const raw = storage.getItem(LEGACY_DRAFT_KEY);
    if (!raw) return { author: "", items: [] };
    storage.removeItem(LEGACY_DRAFT_KEY);
    const draft = JSON.parse(raw) as Record<string, unknown>;
    const author = typeof draft.author === "string" ? draft.author : "";
    if (draft.status !== "ready" || typeof draft.markdown !== "string" || !draft.markdown.trim()) {
      return { author, items: [] };
    }
    const item: UploadItem = {
      id: "upload-restored-draft",
      fileName: typeof draft.fileName === "string" ? draft.fileName : "",
      sourceFormat: parseSourceFormat(draft.sourceFormat),
      engine: parseEngine(draft.engine),
      // It was never sent: the user still has to approve it, whatever its format.
      stage: "ready",
      markdown: draft.markdown,
      error: "",
      failedAt: null,
      result: null,
    };
    return { author, items: [item] };
  }
}

function parseSourceFormat(value: unknown): SourceFormat | null {
  return value === "pdf" || value === "markdown" || value === "text" ? value : null;
}

function parseEngine(value: unknown): ConversionEngine | null {
  return value === "docling" || value === "passthrough" ? value : null;
}

function parseResult(value: unknown): IngestResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.docId !== "string" || typeof record.chunkCount !== "number") return null;
  return {
    docId: record.docId,
    title: typeof record.title === "string" ? record.title : "",
    chunkCount: record.chunkCount,
    alreadyExists: record.alreadyExists === true,
  };
}

/** Restores saved items defensively: a malformed one is skipped, not fatal. */
function parseSaved(input: unknown): { author: string; items: UploadItem[] } {
  if (typeof input !== "object" || input === null) return { author: "", items: [] };
  const record = input as Record<string, unknown>;
  const author = typeof record.author === "string" ? record.author : "";
  const rows = Array.isArray(record.items) ? record.items : [];
  const items: UploadItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || seen.has(r.id) || typeof r.fileName !== "string") continue;
    const stage = r.stage;
    const markdown = typeof r.markdown === "string" ? r.markdown : "";
    const result = parseResult(r.result);
    const base = {
      id: r.id,
      fileName: r.fileName,
      sourceFormat: parseSourceFormat(r.sourceFormat),
      engine: parseEngine(r.engine),
      markdown,
      error: "",
      failedAt: null,
      result: null,
    } satisfies Omit<UploadItem, "stage">;
    let item: UploadItem | null = null;
    if ((stage === "ready" || stage === "approved") && markdown.trim()) {
      item = { ...base, stage };
    } else if (stage === "error" && markdown.trim()) {
      item = {
        ...base,
        stage: "error",
        failedAt: "send",
        error: typeof r.error === "string" ? r.error : "",
      };
    } else if (stage === "done" && result) {
      item = { ...base, stage: "done", result };
    }
    if (item) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return { author, items };
}
