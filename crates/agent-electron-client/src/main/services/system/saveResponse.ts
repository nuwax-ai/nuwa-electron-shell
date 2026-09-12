import { randomUUID } from "crypto";
import { createWriteStream, promises as fs } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
/** 同目录临时文件，完整成功才替换目标；取消/断流/磁盘错误保留原文件。 */
export async function saveResponse(
  response: Response,
  target: string,
  signal?: AbortSignal,
  expectedContent?: "binary",
): Promise<void> {
  if (!response.ok || !response.body)
    throw new Error(`Download failed: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (
    expectedContent === "binary" &&
    /application\/(?:[^;]+\+)?json|text\/(?:json|html)/.test(contentType)
  ) {
    await response.body.cancel();
    throw new Error("Download returned an error page instead of a file");
  }
  const temporary = `${target}.${randomUUID()}.part`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(temporary, { flags: "wx" }),
      { signal },
    );
    signal?.throwIfAborted();
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
