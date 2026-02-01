---
summary: "GLM model family overview + how to use it in OpenClaw"
read_when:
  - You want GLM models in OpenClaw
  - You need the model naming convention and setup
---

# GLM models

GLM is a **model family** (not a company) available through the Z.AI platform and BigModel's Coding Plan API. In OpenClaw, GLM
models are accessed via the `zai` provider for standard models and the `glm-coding-plan` provider for BigModel's coding-specific models.

## Z.AI Provider (Standard GLM models)

Standard GLM models are available through Z.AI with model IDs like `zai/glm-4.7`.

### CLI setup

```bash
openclaw onboard --auth-choice zai-api-key
```

### Config snippet

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## BigModel Provider (Coding Plan)

BigModel's Coding Plan API provides specialized coding models with an extended context window (204K tokens).

### Available models

- `glm-coding-plan/glm-4.7` - GLM-4.7 coding model
- `glm-coding-plan/glm-4.7-flash` - GLM-4.7 Flash (faster variant)
- `glm-coding-plan/glm-4.6v` - GLM-4.6V (vision model with image support)

### CLI setup

```bash
# Set the API key as an environment variable
export GLM_CODING_PLAN_API_KEY="your-api-key"
openclaw onboard
```

### Config snippet

```json5
{
  env: { GLM_CODING_PLAN_API_KEY: "your-api-key" },
  agents: { defaults: { model: { primary: "glm-coding-plan/glm-4.7" } } },
}
```

## Notes

- GLM versions and availability can change; check Z.AI's docs or BigModel's Coding Plan docs for the latest.
- Example model IDs include `glm-4.7`, `glm-4.7-flash`, and `glm-4.6v`.
- For Z.AI provider details, see [/providers/zai](/providers/zai).
- BigModel Coding Plan API endpoint: `https://open.bigmodel.cn/api/coding/paas/v4`
- BigModel Coding Plan models support up to 204K context window and 131K max output tokens.
