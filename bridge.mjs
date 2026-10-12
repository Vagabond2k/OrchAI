#!/usr/bin/env node
/**
 * Local bridge: ChatGPT/Tampermonkey -> Claude Code -> DeepSeek.
 * Node 18+; no npm dependencies.
 *
 * Environment:
 *   DEEPSEEK_API_KEY=...        required
 *   ORCH_PORT=17321             optional
 *   ORCH_TOKEN=...              strongly recommended
 *   ORCH_PROJECT=/abs/path      optional default project
 *   CLAUDE_BIN=claude           optional
 *   CLAUDE_MAX_TURNS=20         optional
 *   CLAUDE_PERMISSION_MODE=acceptEdits   optional
 *   CLAUDE_DANGEROUS=0|1        optional; 1 adds --dangerously-skip-permissions
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.ORCH_PORT || 17321);
const TOKEN = process.env.ORCH_TOKEN || randomBytes(24).toString("hex");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const DEFAULT_PROJECT = process.env.ORCH_PROJECT || "";
const MAX_TURNS = String(process.env.CLAUDE_MAX_TURNS || 20);
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "acceptEdits";
const DANGEROUS = process.env.CLAUDE_DANGEROUS === "1";

const sessions = new Map(); // browserSessionId -> { claudeSessionId, project, totals }

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "https://chatgpt.com",
    "Access-Control-Allow-Headers": "Content-Type, X-Orchestrator-Token",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  });
  res.end(data);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function authorized(req) {
  return req.headers["x-orchestrator-token"] === TOKEN;
}

function resolveProject(input) {
  const raw = input || DEFAULT_PROJECT;
  if (!raw) throw new Error("No project directory supplied");
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Project directory does not exist: ${resolved}`);
  }
  return resolved;
}

function deepFindUsage(value, out = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) deepFindUsage(v, out);
    return out;
  }

  // Claude Code / Anthropic-compatible usage field variants.
  if (Number.isFinite(value.input_tokens)) out.input += value.input_tokens;
  if (Number.isFinite(value.output_tokens)) out.output += value.output_tokens;
  if (Number.isFinite(value.cache_read_input_tokens)) out.cacheRead += value.cache_read_input_tokens;
  if (Number.isFinite(value.cache_creation_input_tokens)) out.cacheCreate += value.cache_creation_input_tokens;

  for (const [k, v] of Object.entries(value)) {
    if (k !== "usage") deepFindUsage(v, out);
  }
  return out;
}

function extractResult(parsed, stdout) {
  const resultText =
    typeof parsed?.result === "string" ? parsed.result :
    typeof parsed?.message === "string" ? parsed.message :
    stdout;

  const usage = deepFindUsage(parsed);
  const cost =
    Number.isFinite(parsed?.total_cost_usd) ? parsed.total_cost_usd :
    Number.isFinite(parsed?.cost_usd) ? parsed.cost_usd :
    null;

  return {
    text: resultText,
    sessionId: parsed?.session_id || null,
    usage,
    costUsd: cost,
    numTurns: Number.isFinite(parsed?.num_turns) ? parsed.num_turns : null,
    raw: parsed,
  };
}

function runClaude({ prompt, project, claudeSessionId }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json", "--max-turns", MAX_TURNS];

    if (claudeSessionId) args.push("--resume", claudeSessionId);

    if (DANGEROUS) {
      args.push("--dangerously-skip-permissions");
    } else if (PERMISSION_MODE) {
      args.push("--permission-mode", PERMISSION_MODE);
    }

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "",
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "deepseek-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL || "deepseek-flash",
      CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL || "max",
    };

    if (!env.ANTHROPIC_AUTH_TOKEN) {
      reject(new Error("Set DEEPSEEK_API_KEY before starting the bridge."));
      return;
    }

    const child = spawn(CLAUDE_BIN, args, {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);

    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`Claude Code exited ${code}\n${stderr || stdout}`));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = { result: stdout, stderr };
      }
      resolve(extractResult(parsed, stdout));
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "https://chatgpt.com",
        "Access-Control-Allow-Headers": "Content-Type, X-Orchestrator-Token",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      });
      res.end();
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, service: "chatgpt-deepseek-orchestrator" });
      return;
    }

    if (!authorized(req)) {
      json(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (req.url === "/session/reset" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      if (body.browserSessionId) sessions.delete(body.browserSessionId);
      json(res, 200, { ok: true });
      return;
    }

    if (req.url === "/task" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const browserSessionId = String(body.browserSessionId || "");
      const prompt = String(body.prompt || "").trim();
      if (!browserSessionId || !prompt) {
        json(res, 400, { ok: false, error: "browserSessionId and prompt are required" });
        return;
      }

      let state = sessions.get(browserSessionId);
      const project = resolveProject(body.project || state?.project);

      if (!state) {
        state = {
          claudeSessionId: null,
          project,
          totals: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, calls: 0 }
        };
        sessions.set(browserSessionId, state);
      } else if (state.project !== project) {
        throw new Error("Project cannot change inside an active session. Reset first.");
      }

      const result = await runClaude({
        prompt,
        project,
        claudeSessionId: state.claudeSessionId,
      });

      if (result.sessionId) state.claudeSessionId = result.sessionId;
      state.totals.input += result.usage.input;
      state.totals.output += result.usage.output;
      state.totals.cacheRead += result.usage.cacheRead;
      state.totals.cacheCreate += result.usage.cacheCreate;
      state.totals.costUsd += result.costUsd || 0;
      state.totals.calls += 1;

      json(res, 200, {
        ok: true,
        reply: result.text,
        usage: result.usage,
        costUsd: result.costUsd,
        numTurns: result.numTurns,
        claudeSessionId: state.claudeSessionId,
        totals: state.totals,
      });
      return;
    }

    json(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    json(res, 500, { ok: false, error: err?.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bridge listening on http://${HOST}:${PORT}`);
  console.log(`ORCH_TOKEN=${TOKEN}`);
  console.log("Keep this token private. Put the same value in the Tampermonkey panel.");
});
