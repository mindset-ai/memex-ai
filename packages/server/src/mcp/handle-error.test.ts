import { describe, it, expect, vi } from "vitest";
import { handleError } from "./tools.js";
import { McpAuthError } from "./auth.js";
import { NotFoundError, ValidationError } from "../types/errors.js";

// b-31 W4 (t-9). Unknown errors must surface a structured payload with a
// request ID, NOT bubble up as a raw exception that the MCP transport turns
// into a generic JSON-RPC Internal Server Error. Domain errors (auth,
// not-found, validation) must keep their human-readable shape.
describe("mcp/tools handleError", () => {
  it("McpAuthError surfaces the auth message verbatim", () => {
    const result = handleError(new McpAuthError("Token expired"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Token expired");
  });

  it("NotFoundError surfaces with a `Not found:` prefix", () => {
    const result = handleError(new NotFoundError("doc with handle doc-99 in mindset/main"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "Not found: doc with handle doc-99 in mindset/main",
    );
  });

  it("ValidationError surfaces with a `Validation error:` prefix", () => {
    const result = handleError(new ValidationError("Title must be 500 characters or fewer"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "Validation error: Title must be 500 characters or fewer",
    );
  });

  it("unknown errors surface a request ID and do NOT leak the stack", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sql = new Error("relation 'documents' does not exist\n  at db.query.documents.findFirst (...)");
      const result = handleError(sql);
      const text = result.content[0]?.text ?? "";
      expect(result.isError).toBe(true);
      expect(text).toMatch(/^Unexpected server error; please report — request ID [0-9a-f-]{36}$/);
      expect(text).not.toContain("relation 'documents'");
      expect(text).not.toContain("findFirst");
      // The real error must still reach the server log so support can look it up.
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[MCP unexpected error] request="),
        sql,
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("non-Error throwables (strings, objects) also surface a clean request ID", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = handleError("ECONNREFUSED 127.0.0.1:5432");
      const text = result.content[0]?.text ?? "";
      expect(text).toMatch(/^Unexpected server error; please report — request ID [0-9a-f-]{36}$/);
      expect(text).not.toContain("ECONNREFUSED");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("each unknown error gets a fresh request ID", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r1 = handleError(new Error("a"));
    const r2 = handleError(new Error("b"));
    const id1 = (r1.content[0]?.text ?? "").match(/request ID ([0-9a-f-]{36})$/)?.[1];
    const id2 = (r2.content[0]?.text ?? "").match(/request ID ([0-9a-f-]{36})$/)?.[1];
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });
});
