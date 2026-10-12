# ChatGPT ↔ Claude Code / DeepSeek Orchestrator

This is a starter implementation for using ChatGPT in the browser as the orchestrator and Claude Code, backed by DeepSeek, as the coding agent.

## What it does

- Watches ChatGPT assistant messages for:
  `<<<CODER_TASK>>> ... <<<END_CODER_TASK>>>`
- Sends that task to a localhost bridge.
- The bridge runs Claude Code inside your chosen project directory.
- Claude Code is configured by the bridge to use DeepSeek's Anthropic-compatible API.
- The bridge reuses Claude Code's `session_id` on later turns.
- The coder result is inserted back into ChatGPT.
- The userscript repeats until ChatGPT emits:
  `<<<ORCHESTRATION_COMPLETE>>>`
- The floating panel logs both directions and shows token/cost metadata when available.

## Requirements

- Node.js 18+
- Tampermonkey
- Claude Code installed:
  `npm install -g @anthropic-ai/claude-code`
- A DeepSeek API key

Verify:
`claude --version`

## Start the bridge

macOS / Linux example:

```bash
cd /path/to/this/folder

export DEEPSEEK_API_KEY='your-key'
export ORCH_TOKEN='make-a-long-random-secret'
export ORCH_PROJECT='/absolute/path/to/your/project'

node bridge.mjs
```

The bridge prints its address and token.

The code binds only to `127.0.0.1`.

### Permissions

By default the bridge starts Claude Code with:

`--permission-mode acceptEdits`

If your installed Claude Code version rejects that permission mode, launch the bridge with an empty mode and configure permissions in your Claude Code settings:

```bash
export CLAUDE_PERMISSION_MODE=''
node bridge.mjs
```

There is also an intentionally explicit escape hatch:

```bash
export CLAUDE_DANGEROUS=1
node bridge.mjs
```

That passes `--dangerously-skip-permissions`. Use it only in a disposable/sandboxed project you trust.

## Install the userscript

1. Open Tampermonkey.
2. Create a new script.
3. Replace its contents with `chatgpt-deepseek-orchestrator.user.js`.
4. Save.
5. Open/reload `https://chatgpt.com/`.

In the floating panel:
- enter the absolute project directory;
- enter the same `ORCH_TOKEN`;
- click **Copy protocol prompt**, paste it into ChatGPT once;
- give ChatGPT your overall task;
- click **Start**.

## Protocol example

ChatGPT should produce:

```text
<<<CODER_TASK>>>
Inspect the repository and fix the failing authentication tests.
Run the relevant test suite and report all changed files.
<<<END_CODER_TASK>>>
```

The userscript forwards that block.

The result returned to ChatGPT is wrapped as:

```text
<<<CODER_RESULT>>>
...
<<<END_CODER_RESULT>>>
```

ChatGPT can then issue the next task or stop with:

```text
<<<ORCHESTRATION_COMPLETE>>>
```

## Token accounting

The panel has two different kinds of token counts:

1. DeepSeek/Claude Code: the bridge recursively looks for Anthropic-style usage fields such as `input_tokens` and `output_tokens` in Claude Code's JSON output. Whether these appear depends on your Claude Code/backend version.
2. ChatGPT browser: approximate only. The userscript estimates visible text at roughly 4 characters per token. It cannot know ChatGPT's hidden/system context or exact billing/accounting data.

Claude Code's structured JSON also commonly exposes fields such as `total_cost_usd`; the bridge shows it when present.

## Known fragility

ChatGPT's web DOM is not a stable public automation API. OpenAI may change composer/message selectors. The script uses semantic selectors where possible and has fallbacks, but future UI changes can require updates.

For reliability, keep the marker protocol. It prevents normal ChatGPT prose from being executed as coder work.


## Panel controls

The floating panel can be dragged by its header. Its position is saved in the browser and restored after reload.

Use the `−` button to minimize it and `+` to restore it.

Typing a normal message such as `test` does not trigger the coder. The script intentionally forwards only assistant messages containing:

```text
<<<CODER_TASK>>>
...
<<<END_CODER_TASK>>>
```

This prevents ordinary conversation from accidentally executing coding work.


## v0.3 diagnostics

The panel now has:

- **Scan now** — checks the current ChatGPT page for a `CODER_TASK` immediately.
- **Test bridge** — checks whether `http://127.0.0.1:17321/health` is reachable.
- More tolerant assistant-message selectors for current ChatGPT DOM variants.

If **Scan now** says it found the task but nothing runs, click **Test bridge** next.


## v0.4 scanner

The userscript no longer depends on ChatGPT's internal assistant-message DOM attributes.

It now scans the visible conversation text for the protocol markers themselves:

`<<<CODER_TASK>>> ... <<<END_CODER_TASK>>>`

This is intentionally more tolerant of ChatGPT UI/DOM changes.


## v0.5 composer compatibility

The userscript now checks several current ChatGPT composer variants, including:

- `#prompt-textarea`
- role=textbox contenteditable editors
- Lexical editors
- ProseMirror editors
- textarea fallbacks

A new **Test composer** button reports whether the current ChatGPT input editor can be found before starting a full orchestration turn.


## v0.6 result formatting

Coder replies are inserted with preserved line breaks and their Markdown body separated from token/cost metadata.


## v0.7 bridge-test fix

Restores the missing `httpGet()` helper used by the **Test bridge** button. The button now performs `GET /health` through Tampermonkey's `GM_xmlhttpRequest` and reports HTTP, timeout, and JSON errors correctly.


## v0.8 Start / retry behavior

- **Start** now immediately processes a CODER_TASK that is already visible in the conversation. It no longer relies on a future DOM mutation to wake the scanner.
- A task fingerprint is recorded only after the coder result is successfully returned to ChatGPT. A bridge/composer error therefore leaves the same task retryable.
- If the exact same task has already completed, the panel reports that explicitly instead of silently doing nothing.


## v0.9 localhost diagnostics

The userscript now tries both `http://127.0.0.1:17321` and `http://localhost:17321`.
Tampermonkey metadata permits both hosts with `@connect`.
Network errors now include the exact URL attempted and a clearer failure reason.
