import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("BigModel provider (glm-coding-plan)", () => {
  it("should not include glm-coding-plan when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    // BigModel requires explicit configuration via GLM_CODING_PLAN_API_KEY env var or profile
    expect(providers?.["glm-coding-plan"]).toBeUndefined();
  });

  it("should include glm-coding-plan when GLM_CODING_PLAN_API_KEY is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const originalEnv = process.env.GLM_CODING_PLAN_API_KEY;
    
    try {
      process.env.GLM_CODING_PLAN_API_KEY = "test-key";
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.["glm-coding-plan"]).toBeDefined();
      expect(providers?.["glm-coding-plan"]?.baseUrl).toBe(
        "https://open.bigmodel.cn/api/coding/paas/v4"
      );
      expect(providers?.["glm-coding-plan"]?.models).toHaveLength(3);
      expect(providers?.["glm-coding-plan"]?.models?.[0]?.id).toBe("glm-4.7");
      expect(providers?.["glm-coding-plan"]?.models?.[1]?.id).toBe("glm-4.7-flash");
      expect(providers?.["glm-coding-plan"]?.models?.[2]?.id).toBe("glm-4.6v");
    } finally {
      if (originalEnv !== undefined) {
        process.env.GLM_CODING_PLAN_API_KEY = originalEnv;
      } else {
        delete process.env.GLM_CODING_PLAN_API_KEY;
      }
    }
  });
});
