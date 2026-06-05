import { describe, expect, it, vi } from "vitest";
import { BULK_CHUNK_ROWS, bulkInsertChunks } from "./bulk.js";

describe("bulkInsertChunks", () => {
  it("returns [] for an empty row array without calling the inserter", async () => {
    const insert = vi.fn(async (_chunk: never[]): Promise<never[]> => []);
    const out = await bulkInsertChunks([], insert);
    expect(out).toEqual([]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("sends a single chunk when rows fit under the cap", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ i }));
    const insert = vi.fn(async (chunk: { i: number }[]) =>
      chunk.map((r) => ({ id: `id-${r.i}` })),
    );
    const out = await bulkInsertChunks(rows, insert);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(rows);
    expect(out.map((r) => r.id)).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4"]);
  });

  it("splits into multiple chunks when rows exceed BULK_CHUNK_ROWS", async () => {
    const total = BULK_CHUNK_ROWS * 2 + 3; // 2003
    const rows = Array.from({ length: total }, (_, i) => ({ i }));
    const insert = vi.fn(async (chunk: { i: number }[]) =>
      chunk.map((r) => ({ id: r.i })),
    );
    const out = await bulkInsertChunks(rows, insert);
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert.mock.calls[0]![0]!).toHaveLength(BULK_CHUNK_ROWS);
    expect(insert.mock.calls[1]![0]!).toHaveLength(BULK_CHUNK_ROWS);
    expect(insert.mock.calls[2]![0]!).toHaveLength(3);
    expect(out).toHaveLength(total);
    // Preserves row order across chunks.
    expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.i));
  });

  it("propagates inserter errors and stops (so transaction can roll back)", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
    const insert = vi
      .fn(async (chunk: { i: number }[]) => chunk.map((r) => ({ id: r.i })))
      .mockImplementationOnce(async (chunk: { i: number }[]) => chunk.map((r) => ({ id: r.i })))
      .mockImplementationOnce(async () => {
        throw new Error("unique constraint violated");
      });
    await expect(bulkInsertChunks(rows, insert)).rejects.toThrow("unique constraint violated");
    // First chunk succeeded, second threw — third never ran.
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
