import { describe, expect, it } from "vitest";
import { documentKeys, documentQueryDefaults } from "./documentsCache";
import { KnowledgeBaseError } from "./knowledgeBase";
import { createQueryClient } from "./reportsCache";

describe("documentKeys", () => {
  it("nests the list and every detail under `all`", () => {
    const client = createQueryClient();
    client.setQueryData(documentKeys.list, []);
    client.setQueryData(documentKeys.detail("abc"), { docId: "abc" });

    void client.invalidateQueries({ queryKey: documentKeys.all });

    expect(client.getQueryState(documentKeys.list)?.isInvalidated).toBe(true);
    expect(client.getQueryState(documentKeys.detail("abc"))?.isInvalidated).toBe(true);
  });
});

describe("documentQueryDefaults", () => {
  it("lets document data go stale, unlike the stream-fed reports", () => {
    expect(documentQueryDefaults.staleTime).toBe(30_000);
  });

  it("does not retry a missing document, and retries anything else once", () => {
    const { retry } = documentQueryDefaults;

    expect(retry(0, new KnowledgeBaseError("Document 'abc' not found.", 404))).toBe(false);
    expect(retry(0, new KnowledgeBaseError("Could not reach the knowledge base."))).toBe(true);
    expect(retry(1, new KnowledgeBaseError("Could not reach the knowledge base."))).toBe(false);
  });
});
