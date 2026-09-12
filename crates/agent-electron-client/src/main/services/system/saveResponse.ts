import { randomUUID } from "crypto";
import { createWriteStream, promises as fs } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
/** 同目录临时文件，完整成功才替换目标；取消/断流/磁盘错误保留原文件。 */
export async function saveResponse(
  response: Response,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok || !response.body)
    throw new Error(`Download failed: HTTP ${response.status}`);
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
