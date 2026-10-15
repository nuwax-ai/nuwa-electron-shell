import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPiMcpJson,
  buildPiModelsJson,
  buildPiSettingsJson,
  resolvePiApiType,
  writePiAgentConfig,
  PI_API_KEY_ENV,
} from "@main/services/engines/acp/piAgentConfig";

describe("piAgentConfig", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  describe("resolvePiApiType", () => {
    it("maps apiProtocol to pi wire api", () => {
      expect(resolvePiApiType("anthropic")).toBe("anthropic-messages");
      expect(resolvePiApiType("openai")).toBe("openai-completions");
      expect(resolvePiApiType("openai-compatible")).toBe("openai-completions");
      expect(resolvePiApiType(undefined, "gpt-5")).toBe("anthropic-messages");
      expect(resolvePiApiType(undefined, "openai-compatible/gpt-5")).toBe(
        "openai-completions",
      );
    });
  });

  describe("buildPiModelsJson", () => {
    it("writes nuwax provider with env-interpolated apiKey", () => {
      const json = JSON.parse(
        buildPiModelsJson({
          baseUrl: "https://gw.example.com/v1",
          model: "glm-5",
          apiProtocol: "openai",
        }),
      );
      expect(Object.keys(json.providers)).toEqual(["nuwax"]);
      const p = json.providers.nuwax;
      expect(p.baseUrl).toBe("https://gw.example.com/v1");
      expect(p.api).toBe("openai-completions");
      expect(p.apiKey).toBe(`$${PI_API_KEY_ENV}`);
      expect(p.models).toEqual([{ id: "glm-5" }]);
    });

    it("keeps a placeholder baseUrl and model when unset (never writes secrets)", () => {
      const raw = buildPiModelsJson({});
      expect(raw).not.toMatch(/sk-|token|secret/i);
      const json = JSON.parse(raw);
      expect(json.providers.nuwax.models[0].id).toBe("nuwax-default");
    });
  });

  describe("buildPiSettingsJson", () => {
    it("pins default provider/model and distrusts project context files", () => {
      const json = JSON.parse(buildPiSettingsJson({ model: "glm-5" }));
      expect(json.defaultProvider).toBe("nuwax");
      expect(json.defaultModel).toBe("glm-5");
      expect(json.quietStartup).toBe(true);
      expect(json.defaultProjectTrust).toBe("never");
    });
  });

  describe("buildPiMcpJson", () => {
    it("returns null for empty input", () => {
      expect(buildPiMcpJson(undefined)).toBeNull();
      expect(buildPiMcpJson({})).toBeNull();
    });

    it("maps stdio and http servers with direct exposure", () => {
      const json = JSON.parse(
        buildPiMcpJson({
          filesystem: {
            command: "npx",
            args: ["-y", "server-fs", "."],
            env: { KEY: "v" },
          },
          docs: { url: "https://example.com/mcp", type: "http" },
        }),
      );
      expect(json.mcpServers.filesystem).toEqual({
        command: "npx",
        args: ["-y", "server-fs", "."],
        env: { KEY: "v" },
        exposure: "direct",
      });
      expect(json.mcpServers.docs).toEqual({
        url: "https://example.com/mcp",
        type: "http",
        exposure: "direct",
      });
    });
  });

  describe("writePiAgentConfig", () => {
    it("writes models/settings and mcp.json when servers provided", () => {
      const agentDir = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "pi-cfg-")),
        ".pi",
        "agent",
      );
      tempDirs.push(path.dirname(path.dirname(agentDir)));

      const result = writePiAgentConfig({
        agentDir,
        model: { baseUrl: "https://gw/v1", model: "glm-5", apiProtocol: "openai" },
        mcpServers: { tools: { command: "node", args: ["x.js"] } },
      });
      expect(result.wrote).toEqual(["models.json", "settings.json", "mcp.json"]);
      for (const f of result.wrote) {
        expect(fs.existsSync(path.join(agentDir, f))).toBe(true);
      }
    });

    it("omits mcp.json when no servers", () => {
      const agentDir = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "pi-cfg-")),
        "agent",
      );
      tempDirs.push(path.dirname(agentDir));
      const result = writePiAgentConfig({ agentDir });
      expect(result.wrote).toEqual(["models.json", "settings.json"]);
    });
  });
});
