/**
 * 单元测试: compareVersions —— semver 语义（v 前缀 / pre-release / build metadata）
 *
 * 重点回归：旧实现 `|| 0` 把 pre-release 段的 NaN 洗成 0，导致
 * compareVersions("1.0.25", "1.0.26-2427fix.1") === 1（QA 包被提示"更新"到更低版本）。
 */

import { describe, it, expect } from "vitest";
import { compareVersions } from "./dependencyUtils";

describe("compareVersions - 纯数字（旧调用方兼容）", () => {
  it("基础比较", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("v 前缀与裸版本等价", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.4", "1.2.3")).toBe(1);
  });

  it("缺段当 0（1.0 == 1.0.0）", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
  });

  it("多段（四段）兼容", () => {
    expect(compareVersions("1.0.0.1", "1.0.0")).toBe(1);
  });
});

describe("compareVersions - pre-release（本次修复回归）", () => {
  it("QA 包场景：1.0.25 不高于 1.0.26-2427fix.1", () => {
    // 旧实现 NaN 被洗 0 → 误判 1（有更新）；修复后主版本 1.0.26 > 1.0.25
    expect(compareVersions("1.0.25", "1.0.26-2427fix.1")).toBe(-1);
    expect(compareVersions("1.0.26-2427fix.1", "1.0.25")).toBe(1);
  });

  it("同主版本：正式版 > pre-release", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });

  it("pre-release 段间数字比较：1.0.26-1 < 1.0.26-2", () => {
    expect(compareVersions("1.0.26-1", "1.0.26-2")).toBe(-1);
  });

  it("semver 链：alpha < alpha.1 < beta < 正式", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
  });

  it("纯数字标识符 < 字母数字标识符", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("相同则相等（含同 prerelease）", () => {
    expect(compareVersions("1.0.26-2427fix.1", "1.0.26-2427fix.1")).toBe(0);
  });
});

describe("compareVersions - build metadata", () => {
  it("忽略 +build 后缀", () => {
    expect(compareVersions("1.0.0+build.1", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1+a", "1.0.0+b")).toBe(1);
  });
});
