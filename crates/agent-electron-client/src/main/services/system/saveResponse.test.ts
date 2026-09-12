import { it, expect } from "vitest";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveResponse } from "./saveResponse";
it("replaces destination only when entire response succeeds", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "nuwax-save-"));
  const target = join(dir, "图.png");
  try {
    await fs.writeFile(target, "old");
    await saveResponse(new Response("new"), target);
    expect(await fs.readFile(target, "utf8")).toBe("new");
    expect(await fs.readdir(dir)).toEqual(["图.png"]);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
it("stream failure preserves destination and removes partial data", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "nuwax-save-"));
  const target = join(dir, "图.png");
  try {
    await fs.writeFile(target, "old");
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.error(new Error("disconnected"));
      },
    });
    await expect(saveResponse(new Response(stream), target)).rejects.toThrow(
      "disconnected",
    );
    expect(await fs.readFile(target, "utf8")).toBe("old");
    expect(await fs.readdir(dir)).toEqual(["图.png"]);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

it("rejects a HTTP 200 API error before overwriting a binary destination", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "nuwax-save-"));
  const target = join(dir, "project.zip");
  try {
    await fs.writeFile(target, "original archive");
    const response = Response.json({ code: "4010", message: "expired" });
    await expect(
      saveResponse(response, target, undefined, "binary"),
    ).rejects.toThrow("error page");
    expect(await fs.readFile(target, "utf8")).toBe("original archive");
    expect(await fs.readdir(dir)).toEqual(["project.zip"]);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
