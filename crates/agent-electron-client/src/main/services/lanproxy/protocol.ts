/**
 * lanproxy 线协议编解码。
 *
 * 帧格式（大端）：[len u32][type u8][serial u64][uriLen u8][uri][data]
 * 其中 len = 1 + 8 + 1 + uriLen + data.length（不含 len 字段自身）。
 */

export const MessageType = {
  /** 控制连接认证，uri = clientKey */
  AUTH: 0x01,
  /** 服务端要求建立到真实服务的连接 / 数据连接绑定会话 */
  CONNECT: 0x03,
  /** 会话断开 */
  DISCONNECT: 0x04,
  /** 代理数据 */
  TRANSFER: 0x05,
  /** 可写状态同步（协议保留，客户端不使用） */
  WRITE_CONTROL: 0x06,
  HEARTBEAT: 0x07,
} as const;

export interface LanproxyMessage {
  type: number;
  serial: bigint;
  uri: string;
  data: Buffer;
}

export interface OutgoingMessage {
  type: number;
  serial?: bigint;
  uri?: string;
  data?: Buffer;
}

const LEN_SIZE = 4;
const TYPE_SIZE = 1;
const SERIAL_SIZE = 8;
const URI_LEN_SIZE = 1;
/** type + serial + uriLen：帧体最小长度 */
const MIN_BODY = TYPE_SIZE + SERIAL_SIZE + URI_LEN_SIZE;

/** 单帧帧体上限（与 Go 客户端「数据包不超过 2M」一致） */
export const MAX_FRAME_BODY_BYTES = 2 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function encodeMessage(msg: OutgoingMessage): Buffer {
  const uri = Buffer.from(msg.uri ?? "", "utf8");
  if (uri.length > 0xff) {
    throw new ProtocolError(`uri too long: ${uri.length} bytes (max 255)`);
  }
  const data = msg.data ?? Buffer.alloc(0);
  const bodyLen = MIN_BODY + uri.length + data.length;
  if (bodyLen > MAX_FRAME_BODY_BYTES) {
    throw new ProtocolError(`frame too large: ${bodyLen} bytes`);
  }
  const frame = Buffer.allocUnsafe(LEN_SIZE + bodyLen);
  let off = frame.writeUInt32BE(bodyLen, 0);
  off = frame.writeUInt8(msg.type, off);
  off = frame.writeBigUInt64BE(msg.serial ?? 0n, off);
  off = frame.writeUInt8(uri.length, off);
  off += uri.copy(frame, off);
  data.copy(frame, off);
  return frame;
}

/** 流式解帧：处理粘包/半包；遇到非法帧抛 ProtocolError，调用方应断开连接。 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): LanproxyMessage[] {
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    const messages: LanproxyMessage[] = [];
    for (;;) {
      if (this.pending.length < LEN_SIZE) break;
      const bodyLen = this.pending.readUInt32BE(0);
      if (bodyLen < MIN_BODY) {
        throw new ProtocolError(`invalid frame length: ${bodyLen}`);
      }
      if (bodyLen > MAX_FRAME_BODY_BYTES) {
        throw new ProtocolError(`frame too large: ${bodyLen} bytes`);
      }
      const total = LEN_SIZE + bodyLen;
      if (this.pending.length < total) break;

      const body = this.pending.subarray(LEN_SIZE, total);
      const uriLen = body.readUInt8(TYPE_SIZE + SERIAL_SIZE);
      const uriStart = MIN_BODY;
      const dataStart = uriStart + uriLen;
      if (dataStart > body.length) {
        throw new ProtocolError(`uri length ${uriLen} exceeds frame body`);
      }
      messages.push({
        type: body.readUInt8(0),
        serial: body.readBigUInt64BE(TYPE_SIZE),
        uri: body.toString("utf8", uriStart, dataStart),
        data: body.subarray(dataStart),
      });
      this.pending = this.pending.subarray(total);
    }
    // 释放已消费字节的底层大 Buffer 引用
    if (this.pending.length === 0) this.pending = Buffer.alloc(0);
    return messages;
  }
}
