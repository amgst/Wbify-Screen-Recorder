# Shopify Theme Agents API runner

This project includes a runnable PowerShell app that calls the OpenAI Agents HTTP API directly with `curl.exe`.

It starts a session from the saved agent:

- Project: `proj_8p71wI3Cn8agMGX8Q1rPRfL8`
- Saved agent: `agent_1f2ddba150e84ab09a8bd51895dfc7572f4432542af54d0080`
- Display name: `Shopify Theme`

The session applies these overrides at creation time:

```json
{
  "model": "gpt-6-astra",
  "instructions": "Develop shopify professional themes.",
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "text": {
    "format": {
      "type": "text"
    },
    "verbosity": "medium"
  }
}
```

The runner intentionally does not send `tools: []`. Agents API session overrides replace supplied arrays instead of merging them, so omitting `tools` preserves the saved agent's tools and other saved settings.

## Setup

Use a project API key for `proj_8p71wI3Cn8agMGX8Q1rPRfL8`.

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:OPENAI_PROJECT_ID = "proj_8p71wI3Cn8agMGX8Q1rPRfL8"
```

For a persistent user environment variable on Windows:

```powershell
setx OPENAI_API_KEY "sk-..."
setx OPENAI_PROJECT_ID "proj_8p71wI3Cn8agMGX8Q1rPRfL8"
```

Open a new terminal after `setx`.

## Run

```powershell
.\scripts\run-shopify-theme-agent.ps1
```

Send a custom initial user message:

```powershell
.\scripts\run-shopify-theme-agent.ps1 -InitialMessage "Design a conversion-focused Shopify theme for a luxury skincare brand. Include sections, Liquid files, and UX rationale."
```

Show every raw stream event:

```powershell
.\scripts\run-shopify-theme-agent.ps1 -VerboseEvents
```

## Continue a session

Use the session id printed by the first run:

```powershell
.\scripts\run-shopify-theme-agent.ps1 -SessionId "sess_..." -InitialMessage "Now write the hero section Liquid and schema."
```

## Tool calls

If the saved agent asks for a function result, the stream emits `agent.session.requires_action`. The runner reads `session.required_actions` and submits `agent.session.input.tool_result` events.

By default, unknown function calls receive a structured error result so the model can recover. To provide real results, create a JSON file keyed by function name or `call_id`:

```json
{
  "get_theme_constraints": {
    "style": "premium editorial",
    "currency": "USD",
    "required_sections": ["hero", "featured_collection", "testimonials"]
  }
}
```

Then run:

```powershell
.\scripts\run-shopify-theme-agent.ps1 -ToolResultsPath .\tool-results.example.json
```

Use `-NoAutoToolError` if another process will submit tool results.

## Environment

The runner uses `environment.type: "openai_hosted"` with a Linux workspace. It creates `/workspace/outputs/theme` and checks `node` and `python3` during setup. Network access defaults to `disabled`; pass `-NetworkAccess enabled` only when the task genuinely needs outbound network access.

## Recovery

The runner prints a curl command for listing saved session items:

```powershell
curl.exe "https://api.openai.com/v1/agents/sessions/$session_id/items?order=asc&limit=100" `
  -H "OpenAI-Beta: agents=v1" `
  -H "Authorization: Bearer $env:OPENAI_API_KEY" `
  -H "OpenAI-Project: proj_8p71wI3Cn8agMGX8Q1rPRfL8"
```
