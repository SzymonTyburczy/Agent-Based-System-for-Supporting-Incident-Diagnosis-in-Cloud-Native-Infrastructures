import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversionResult } from "./converter";
import type { IngestResult } from "./knowledgeBase";
import type { DocumentPayload } from "./types";
import {
  AUTHOR_SETTLE_MS,
  LEGACY_DRAFT_KEY,
  SEND_FAILURE_GRACE_MS,
  STORAGE_KEY,
  UploadQueue,
  isEditable,
  unfinishedCount,
  type UploadItem,
  type UploadQueueDeps,
} from "./uploadQueue";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-settled promise continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const pdf = (name: string) => new File([new Uint8Array([1])], name, { type: "application/pdf" });
const md = (name: string, text = "# Runbook\n\nBody") =>
  new File([text], name, { type: "text/markdown" });

function ingested(title: string): IngestResult {
  return { docId: `id-${title}`, title, chunkCount: 2, alreadyExists: false };
}

/**
 * A queue whose PDF conversions and sends finish only when the test says so;
 * Markdown passes through at once, as the real converter does.
 */
function harness(overrides: Partial<UploadQueueDeps> = {}) {
  const conversions = new Map<string, Deferred<ConversionResult>>();
  const convertSignals = new Map<string, AbortSignal>();
  const sends: { payload: DocumentPayload; signal: AbortSignal; d: Deferred<IngestResult> }[] = [];
  const onKnowledgeBaseChanged = vi.fn();

  const deps: UploadQueueDeps = {
    convert: vi.fn(async (file: File, signal: AbortSignal): Promise<ConversionResult> => {
      convertSignals.set(file.name, signal);
      if (!file.name.endsWith(".pdf")) {
        return { markdown: await file.text(), sourceFormat: "markdown", engine: "passthrough" };
      }
      const d = deferred<ConversionResult>();
      conversions.set(file.name, d);
      return d.promise;
    }),
    ingest: vi.fn((payload: DocumentPayload, signal: AbortSignal) => {
      const d = deferred<IngestResult>();
      sends.push({ payload, signal, d });
      return d.promise;
    }),
    defaultAuthor: () => "SRE Team",
    now: () => new Date(2026, 10, 15),
    onKnowledgeBaseChanged,
    storage: null,
    sendFailureGraceMs: 0,
    ...overrides,
  };
  const queue = new UploadQueue(deps);
  queue.start();

  const item = (fileName: string): UploadItem => {
    const found = queue.getSnapshot().items.find((candidate) => candidate.fileName === fileName);
    if (!found) throw new Error(`no item ${fileName}`);
    return found;
  };
  const converted = async (name: string, markdown = `# ${name}`) => {
    conversions.get(name)!.resolve({ markdown, sourceFormat: "pdf", engine: "docling" });
    await settle();
  };
  return {
    queue,
    deps,
    conversions,
    convertSignals,
    sends,
    onKnowledgeBaseChanged,
    item,
    converted,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("UploadQueue — Markdown and text", () => {
  it("sends a Markdown file without approval, with the page's metadata", async () => {
    const h = harness();
    h.queue.add([md("runbook.md", "# Runbook\n\nRestart the pod.")]);
    await settle();

    expect(h.item("runbook.md").stage).toBe("sending");
    expect(h.sends[0].payload).toEqual({
      data: "2026-11-15",
      autor: "SRE Team",
      tresc: "# Runbook\n\nRestart the pod.",
      nazwa_pliku: "runbook.md",
    });

    h.sends[0].d.resolve(ingested("Runbook"));
    await settle();
    expect(h.item("runbook.md").stage).toBe("done");
    expect(h.item("runbook.md").result?.title).toBe("Runbook");
    expect(h.onKnowledgeBaseChanged).toHaveBeenCalledTimes(1);
  });

  it("is not held up by a PDF that is still converting", async () => {
    const h = harness();
    h.queue.add([pdf("long.pdf"), md("quick.md")]);
    await settle();

    expect(h.item("long.pdf").stage).toBe("converting");
    expect(h.item("quick.md").stage).toBe("sending");
  });

  it("waits for an author before sending, then sends on its own", async () => {
    vi.useFakeTimers();
    const h = harness({ defaultAuthor: () => "" });
    h.queue.add([md("a.md")]);
    await settle();

    expect(h.item("a.md").stage).toBe("approved");
    expect(h.sends).toHaveLength(0);

    h.queue.setAuthor("Ops");
    vi.advanceTimersByTime(AUTHOR_SETTLE_MS);
    await settle();
    expect(h.item("a.md").stage).toBe("sending");
    expect(h.sends[0].payload.autor).toBe("Ops");
  });

  it("does not send while the author is still being typed", async () => {
    vi.useFakeTimers();
    const h = harness({ defaultAuthor: () => "" });
    h.queue.add([md("a.md"), pdf("b.pdf")]);
    await settle();

    for (const typed of ["S", "SR", "SRE"]) {
      h.queue.setAuthor(typed);
      vi.advanceTimersByTime(AUTHOR_SETTLE_MS / 2);
    }
    // Something else wakes the scheduler mid-typing: still no send.
    await h.converted("b.pdf");
    expect(h.sends).toHaveLength(0);

    vi.advanceTimersByTime(AUTHOR_SETTLE_MS);
    await settle();
    expect(h.sends[0].payload.autor).toBe("SRE");
  });
});

describe("UploadQueue — PDF", () => {
  it("stops a converted PDF at ready until it is approved", async () => {
    const h = harness();
    h.queue.add([pdf("guide.pdf")]);
    await settle();
    await h.converted("guide.pdf", "# Guide");

    expect(h.item("guide.pdf")).toMatchObject({
      stage: "ready",
      markdown: "# Guide",
      engine: "docling",
    });
    expect(h.sends).toHaveLength(0);

    h.queue.approve(h.item("guide.pdf").id);
    await settle();
    expect(h.item("guide.pdf").stage).toBe("sending");
    expect(h.sends[0].payload.tresc).toBe("# Guide");
  });

  it("converts PDFs one at a time, in the order they were added", async () => {
    const h = harness();
    h.queue.add([pdf("1.pdf"), pdf("2.pdf")]);
    h.queue.add([pdf("3.pdf")]);
    await settle();

    expect([h.item("1.pdf").stage, h.item("2.pdf").stage, h.item("3.pdf").stage]).toEqual([
      "converting",
      "queued",
      "queued",
    ]);

    await h.converted("1.pdf");
    expect(h.item("2.pdf").stage).toBe("converting");
    expect(h.item("3.pdf").stage).toBe("queued");
  });

  it("sends one document at a time", async () => {
    const h = harness();
    h.queue.add([md("a.md"), md("b.md")]);
    await settle();

    expect(h.item("a.md").stage).toBe("sending");
    expect(h.item("b.md").stage).toBe("approved");

    h.sends[0].d.resolve(ingested("A"));
    await settle();
    expect(h.item("b.md").stage).toBe("sending");
  });

  it("approves every ready document at once, and nothing that is not ready", async () => {
    const h = harness();
    h.queue.add([pdf("1.pdf"), pdf("2.pdf"), pdf("3.pdf")]);
    await settle();
    await h.converted("1.pdf");
    await h.converted("2.pdf");

    h.queue.approveAll();
    await settle();
    expect(h.item("1.pdf").stage).toBe("sending");
    expect(h.item("2.pdf").stage).toBe("approved");
    expect(h.item("3.pdf").stage).toBe("converting");
  });

  it("sends the edited text, not the converted one", async () => {
    const h = harness();
    h.queue.add([pdf("guide.pdf")]);
    await settle();
    await h.converted("guide.pdf", "flattened: yaml");

    const { id } = h.item("guide.pdf");
    h.queue.editMarkdown(id, "fixed:\n  yaml: true");
    h.queue.approve(id);
    await settle();
    expect(h.sends[0].payload.tresc).toBe("fixed:\n  yaml: true");
  });

  it("does not approve blank text, and blanking an approved document takes it back", async () => {
    const h = harness({ defaultAuthor: () => "" });
    h.queue.add([pdf("guide.pdf")]);
    await settle();
    await h.converted("guide.pdf");
    const { id } = h.item("guide.pdf");

    h.queue.approve(id);
    expect(h.item("guide.pdf").stage).toBe("approved");
    h.queue.editMarkdown(id, "   ");
    expect(h.item("guide.pdf").stage).toBe("ready");
    h.queue.approve(id);
    expect(h.item("guide.pdf").stage).toBe("ready");
  });
});

describe("UploadQueue — cancel and retry", () => {
  it("cancelling a conversion aborts it, frees the converter and ignores its late result", async () => {
    const h = harness();
    h.queue.add([pdf("1.pdf"), pdf("2.pdf")]);
    await settle();

    h.queue.remove(h.item("1.pdf").id);
    expect(h.convertSignals.get("1.pdf")!.aborted).toBe(true);
    await settle();
    expect(h.item("2.pdf").stage).toBe("converting");

    await h.converted("1.pdf");
    expect(h.queue.getSnapshot().items.map((item) => item.fileName)).toEqual(["2.pdf"]);
  });

  it("cancelling a send aborts it and refreshes the knowledge base, which may have it anyway", async () => {
    const h = harness();
    h.queue.add([md("a.md"), md("b.md")]);
    await settle();

    h.queue.remove(h.item("a.md").id);
    expect(h.sends[0].signal.aborted).toBe(true);
    expect(h.onKnowledgeBaseChanged).toHaveBeenCalledTimes(1);
    await settle();
    expect(h.item("b.md").stage).toBe("sending");

    h.sends[0].d.resolve(ingested("A"));
    await settle();
    expect(h.queue.getSnapshot().items).toHaveLength(1);
  });

  it("keeps the text of a failed send and sends it again on retry", async () => {
    const h = harness();
    h.queue.add([md("a.md", "# A")]);
    await settle();
    h.sends[0].d.reject(new Error("The knowledge base is down."));
    await settle();

    expect(h.item("a.md")).toMatchObject({
      stage: "error",
      failedAt: "send",
      error: "The knowledge base is down.",
      markdown: "# A",
    });
    expect(isEditable(h.item("a.md"))).toBe(true);

    h.queue.retry(h.item("a.md").id);
    await settle();
    expect(h.item("a.md").stage).toBe("sending");
    expect(h.sends[1].payload.tresc).toBe("# A");
  });

  it("records a failed send only after a grace period, so a reload saves it mid-send", async () => {
    vi.useFakeTimers();
    const storage = {
      data: new Map<string, string>(),
      getItem(key: string) {
        return this.data.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this.data.set(key, value);
      },
      removeItem(key: string) {
        this.data.delete(key);
      },
    };
    const h = harness({ storage, sendFailureGraceMs: undefined });
    h.queue.add([md("a.md")]);
    await settle();

    // The page unloading kills the request; pagehide flushes right after.
    h.sends[0].d.reject(new TypeError("Failed to fetch"));
    await settle();
    expect(h.item("a.md").stage).toBe("sending");
    h.queue.flush();
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!).items[0].stage).toBe("approved");

    // A page that stays shows the failure once the grace period is over.
    vi.advanceTimersByTime(SEND_FAILURE_GRACE_MS);
    await settle();
    expect(h.item("a.md").stage).toBe("error");
  });

  it("converts the file again when a conversion is retried", async () => {
    const h = harness();
    h.queue.add([pdf("1.pdf")]);
    await settle();
    h.conversions.get("1.pdf")!.reject(new Error("The converter failed."));
    await settle();

    expect(h.item("1.pdf")).toMatchObject({ stage: "error", failedAt: "convert" });
    expect(isEditable(h.item("1.pdf"))).toBe(false);

    h.queue.retry(h.item("1.pdf").id);
    await settle();
    expect(h.item("1.pdf").stage).toBe("converting");
    expect(h.deps.convert).toHaveBeenCalledTimes(2);
  });

  it("clears only the finished documents", async () => {
    const h = harness();
    h.queue.add([md("a.md"), pdf("b.pdf")]);
    await settle();
    h.sends[0].d.resolve(ingested("A"));
    await settle();

    h.queue.clearFinished();
    expect(h.queue.getSnapshot().items.map((item) => item.fileName)).toEqual(["b.pdf"]);
    expect(unfinishedCount(h.queue.getSnapshot().items)).toBe(1);
  });
});

describe("UploadQueue — start", () => {
  it("runs nothing before start, so building a queue never sends by itself", async () => {
    const deps: UploadQueueDeps = {
      convert: vi.fn(),
      ingest: vi.fn(),
      defaultAuthor: () => "A",
      now: () => new Date(),
      storage: null,
    };
    const queue = new UploadQueue(deps);
    queue.add([md("a.md")]);
    await settle();
    expect(deps.convert).not.toHaveBeenCalled();
    expect(queue.getSnapshot().items[0].stage).toBe("queued");
  });
});

describe("UploadQueue — persistence", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
  }

  it("saves what a reload can resume and drops what it cannot", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const h = harness({ storage });
    h.queue.add([pdf("ready.pdf"), pdf("queued.pdf"), md("sending.md"), md("waiting.md")]);
    await settle();
    await h.converted("ready.pdf", "# Ready");
    vi.advanceTimersByTime(500);

    const saved = JSON.parse(storage.data.get(STORAGE_KEY)!) as {
      author: string;
      items: UploadItem[];
    };
    expect(saved.author).toBe("SRE Team");
    // The PDF still converting cannot be saved: a File does not survive a reload.
    // The one mid-send is saved as approved: ingest is idempotent.
    expect(saved.items.map((item) => [item.fileName, item.stage])).toEqual([
      ["ready.pdf", "ready"],
      ["sending.md", "approved"],
      ["waiting.md", "approved"],
    ]);
  });

  it("saves at once on flush, without waiting for the debounce", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const h = harness({ storage });
    h.queue.add([pdf("a.pdf")]);
    await settle();
    await h.converted("a.pdf");
    vi.advanceTimersByTime(500);

    h.queue.remove(h.item("a.pdf").id);
    h.queue.flush();
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!).items).toEqual([]);
  });

  it("restores saved documents and resumes the approved ones on start", async () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({
        author: "Ops",
        items: [
          { id: "a", fileName: "a.pdf", stage: "ready", markdown: "# A", sourceFormat: "pdf" },
          { id: "b", fileName: "b.md", stage: "approved", markdown: "# B" },
          { id: "c", fileName: "c.md", stage: "done", result: ingested("C") },
          { id: "d", fileName: "d.pdf", stage: "converting" },
          { id: "e", fileName: "e.md", stage: "approved", markdown: "" },
          "garbage",
        ],
      }),
    });
    const ingest = vi.fn(() => new Promise<IngestResult>(() => {}));
    const queue = new UploadQueue({
      convert: vi.fn(),
      ingest,
      defaultAuthor: () => "Default",
      now: () => new Date(2026, 10, 15),
      storage,
    });

    expect(queue.getSnapshot().author).toBe("Ops");
    expect(queue.getSnapshot().items.map((item) => [item.id, item.stage])).toEqual([
      ["a", "ready"],
      ["b", "approved"],
      ["c", "done"],
    ]);
    expect(ingest).not.toHaveBeenCalled();

    queue.start();
    await settle();
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().items[1].stage).toBe("sending");
  });

  it("migrates the old single-document draft as one document to approve", () => {
    const storage = memoryStorage({
      [LEGACY_DRAFT_KEY]: JSON.stringify({
        status: "ready",
        fileName: "old.md",
        sourceFormat: "markdown",
        engine: "passthrough",
        markdown: "# Old",
        author: "Legacy",
        dateISO: "2026-10-01T00:00:00.000Z",
      }),
    });
    const queue = new UploadQueue({
      convert: vi.fn(),
      ingest: vi.fn(),
      defaultAuthor: () => "",
      now: () => new Date(),
      storage,
    });

    expect(queue.getSnapshot().author).toBe("Legacy");
    expect(queue.getSnapshot().items).toMatchObject([
      { fileName: "old.md", stage: "ready", markdown: "# Old" },
    ]);
    expect(storage.data.has(LEGACY_DRAFT_KEY)).toBe(false);
  });

  it("starts empty from unreadable storage", () => {
    const queue = new UploadQueue({
      convert: vi.fn(),
      ingest: vi.fn(),
      defaultAuthor: () => "Default",
      now: () => new Date(),
      storage: memoryStorage({ [STORAGE_KEY]: "{not json" }),
    });
    expect(queue.getSnapshot()).toMatchObject({ author: "Default", items: [] });
  });
});
