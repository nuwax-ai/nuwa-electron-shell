import { describe, expect, it } from "vitest";
import {
  FrameDecoder,
  MAX_FRAME_BODY_BYTES,
  MessageType,
  ProtocolError,
  encodeMessage,
} from "./protocol";

// 以下字节取自 lanproxy-go-client（随包 nuwax-lanproxy）对假服务端的实测抓包。
const GOLDEN = {
  auth: "0000001101000000000000000007746573746b6579",
  connect: "000000170300000000000000000d757365723140746573746b6579",
  transfer: "0000000f0500000000000000000068656c6c6f",
  disconnect: "0000000f040000000000000000057573657233",
  heartbeat: "0000000a07000000000000000000",
};

describe("encodeMessage (golden vectors from the Go client)", () => {
  it("AUTH carries the client key in uri", () => {
    const frame = encodeMessage({ type: MessageType.AUTH, uri: "testkey" });
    expect(frame.toString("hex")).toBe(GOLDEN.auth);
  });

  it("CONNECT binds a data connection with userId@clientKey", () => {
    const frame = encodeMessage({
      type: MessageType.CONNECT,
      uri: "user1@testkey",
    });
    expect(frame.toString("hex")).toBe(GOLDEN.connect);
  });

  it("TRANSFER carries payload in data", () => {
    const frame = encodeMessage({
      type: MessageType.TRANSFER,
      data: Buffer.from("hello"),
    });
    expect(frame.toString("hex")).toBe(GOLDEN.transfer);
  });

  it("DISCONNECT carries the user id in uri", () => {
    const frame = encodeMessage({ type: MessageType.DISCONNECT, uri: "user3" });
    expect(frame.toString("hex")).toBe(GOLDEN.disconnect);
  });

  it("HEARTBEAT is header-only", () => {
    const frame = encodeMessage({ type: MessageType.HEARTBEAT });
    expect(frame.toString("hex")).toBe(GOLDEN.heartbeat);
  });

  it("rejects uri longer than 255 bytes", () => {
    expect(() =>
      encodeMessage({ type: MessageType.CONNECT, uri: "x".repeat(256) }),
    ).toThrow(ProtocolError);
  });

  it("rejects frames above the size limit", () => {
    expect(() =>
      encodeMessage({
        type: MessageType.TRANSFER,
        data: Buffer.alloc(MAX_FRAME_BODY_BYTES),
      }),
    ).toThrow(ProtocolError);
  });
});

describe("FrameDecoder", () => {
  it("decodes golden frames back to messages", () => {
    const decoder = new FrameDecoder();
    const [msg] = decoder.push(Buffer.from(GOLDEN.connect, "hex"));
    expect(msg.type).toBe(MessageType.CONNECT);
    expect(msg.uri).toBe("user1@testkey");
    expect(msg.serial).toBe(0n);
    expect(msg.data.length).toBe(0);
  });

  it("round-trips serial, uri and binary data", () => {
    const data = Buffer.from([0, 1, 2, 255, 254]);
    const frame = encodeMessage({
      type: MessageType.TRANSFER,
      serial: 0x0102030405060708n,
      uri: "用户",
      data,
    });
    const [msg] = new FrameDecoder().push(frame);
    expect(msg.serial).toBe(0x0102030405060708n);
    expect(msg.uri).toBe("用户");
    expect(msg.data.equals(data)).toBe(true);
  });

  it("handles frames split at every byte boundary", () => {
    const frame = Buffer.concat([
      encodeMessage({ type: MessageType.AUTH, uri: "k" }),
      encodeMessage({ type: MessageType.TRANSFER, data: Buffer.from("abc") }),
    ]);
    const decoder = new FrameDecoder();
    const out = [];
    for (let i = 0; i < frame.length; i++) {
      out.push(...decoder.push(frame.subarray(i, i + 1)));
    }
    expect(out.map((m) => m.type)).toEqual([
      MessageType.AUTH,
      MessageType.TRANSFER,
    ]);
    expect(out[1].data.toString()).toBe("abc");
  });

  it("handles several frames in one chunk", () => {
    const chunk = Buffer.concat(
      [GOLDEN.auth, GOLDEN.heartbeat, GOLDEN.disconnect].map((h) =>
        Buffer.from(h, "hex"),
      ),
    );
    const out = new FrameDecoder().push(chunk);
    expect(out.map((m) => m.type)).toEqual([
      MessageType.AUTH,
      MessageType.HEARTBEAT,
      MessageType.DISCONNECT,
    ]);
  });

  it("rejects an oversized length prefix before buffering the body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BODY_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(header)).toThrow(ProtocolError);
  });

  it("rejects a length smaller than the fixed header", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(3, 0);
    expect(() => new FrameDecoder().push(header)).toThrow(ProtocolError);
  });

  it("rejects a uri length that overruns the frame body", () => {
    const frame = Buffer.from(GOLDEN.heartbeat, "hex");
    frame[13] = 5; // uriLen claims 5 bytes but body has none
    expect(() => new FrameDecoder().push(frame)).toThrow(ProtocolError);
  });
});
