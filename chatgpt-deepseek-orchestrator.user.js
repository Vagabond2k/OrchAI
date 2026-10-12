// ==UserScript==
// @name         ChatGPT -> Claude Code / DeepSeek Orchestrator
// @namespace    local.orchestrator
// @version      0.9.0
// @description  Forwards marked ChatGPT tasks to a local Claude Code bridge and returns coder results to ChatGPT.
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
  "use strict";

  const BRIDGES = ["http://127.0.0.1:17321", "http://localhost:17321"];
  const TASK_OPEN = "<<<CODER_TASK>>>";
  const TASK_CLOSE = "<<<END_CODER_TASK>>>";
  const DONE_MARKER = "<<<ORCHESTRATION_COMPLETE>>>";

  function bridgeUrls(path) {
    return BRIDGES.map(base => base + path);
  }
  const RESULT_OPEN = "<<<CODER_RESULT>>>";
  const RESULT_CLOSE = "<<<END_CODER_RESULT>>>";

  const state = {
    running: false,
    paused: true,
    busy: false,
    lastTaskFingerprint: "",
    browserSessionId: crypto.randomUUID(),
    turn: 0,
    chatgptEstimatedTokens: 0,
    deepseekInput: 0,
    deepseekOutput: 0,
    deepseekCacheRead: 0,
    deepseekCacheCreate: 0,
    costUsd: 0,
    transcript: [],
  };

  const css = `
  #ds-orch {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    width: min(430px, calc(100vw - 32px)); max-height: 72vh;
    touch-action: none;
    background: #111827; color: #e5e7eb; border: 1px solid #374151;
    border-radius: 12px; box-shadow: 0 12px 36px rgba(0,0,0,.35);
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow: hidden;
  }
  #ds-orch * { box-sizing: border-box; }
  #ds-orch header {
    display:flex; gap:8px; align-items:center; padding:10px 12px; background:#0b1220;
    cursor: move; user-select:none;
  }
  #ds-orch header button { cursor:pointer; }
  #ds-orch.minimized .body { display:none; }
  #ds-orch.minimized { max-height:none; }
  #ds-orch header strong { flex:1; font-size:13px; }
  #ds-orch .body { padding:10px; overflow:auto; max-height: calc(72vh - 44px); }
  #ds-orch .row { display:flex; gap:6px; flex-wrap:wrap; margin:6px 0; }
  #ds-orch input { width:100%; background:#030712; color:#e5e7eb; border:1px solid #374151; border-radius:6px; padding:7px; }
  #ds-orch button { background:#1f2937; color:#fff; border:1px solid #4b5563; border-radius:6px; padding:6px 9px; cursor:pointer; }
  #ds-orch button.primary { background:#065f46; border-color:#10b981; }
  #ds-orch button.danger { background:#7f1d1d; border-color:#ef4444; }
  #ds-orch button:disabled { opacity:.45; cursor:not-allowed; }
  #ds-orch .status { padding:7px 8px; border-radius:6px; background:#030712; margin-bottom:8px; }
  #ds-orch .stats { display:grid; grid-template-columns:1fr auto; gap:3px 10px; margin:8px 0; }
  #ds-orch .log { display:flex; flex-direction:column; gap:7px; }
  #ds-orch .msg { border:1px solid #374151; border-radius:7px; padding:7px; white-space:pre-wrap; overflow-wrap:anywhere; }
  #ds-orch .msg .meta { color:#9ca3af; margin-bottom:4px; }
  #ds-orch .small { color:#9ca3af; font-size:11px; }
  `;

  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.appendChild(style);

  const panel = document.createElement("section");
  panel.id = "ds-orch";
  panel.innerHTML = `
    <header id="ds-drag-handle">
      <strong>ChatGPT ↔ DeepSeek Coder</strong>
      <span id="ds-dot">● PAUSED</span>
      <button id="ds-minimize" type="button" title="Minimize">−</button>
    </header>
    <div class="body">
      <div id="ds-status" class="status">Configure project + token, then Start.</div>

      <label>Project directory</label>
      <input id="ds-project" placeholder="/absolute/path/to/project">

      <label style="display:block;margin-top:6px">Bridge token</label>
      <input id="ds-token" type="password" placeholder="ORCH_TOKEN printed by bridge">

      <div class="row">
        <button id="ds-start" class="primary">Start</button>
        <button id="ds-pause">Pause</button>
        <button id="ds-reset" class="danger">Reset session</button>
      </div>

      <div class="row">
        <button id="ds-scan">Scan now</button>
        <button id="ds-test-bridge">Test bridge</button>
        <button id="ds-test-composer">Test composer</button>
      </div>

      <div class="stats">
        <span>Turns</span><strong id="st-turns">0</strong>
        <span>DeepSeek input</span><strong id="st-in">0</strong>
        <span>DeepSeek output</span><strong id="st-out">0</strong>
        <span>Cache read</span><strong id="st-cache">0</strong>
        <span>ChatGPT visible est.</span><strong id="st-gpt">0</strong>
        <span>Reported cost</span><strong id="st-cost">$0.0000</strong>
      </div>

      <div class="small">
        ChatGPT tokens are approximate from visible text. DeepSeek usage is shown when Claude Code exposes usage metadata.
      </div>

      <div class="row">
        <button id="ds-copy-prompt">Copy protocol prompt</button>
        <button id="ds-clear">Clear log</button>
      </div>

      <div id="ds-log" class="log"></div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);
  const projectEl = $("#ds-project");
  const tokenEl = $("#ds-token");
  const statusEl = $("#ds-status");
  const dotEl = $("#ds-dot");
  const logEl = $("#ds-log");

  // Persist non-secret project path only.
  projectEl.value = localStorage.getItem("ds-orch-project") || "";
  projectEl.addEventListener("change", () => localStorage.setItem("ds-orch-project", projectEl.value));

  function setStatus(text, kind = "info") {
    statusEl.textContent = text;
    dotEl.textContent = state.paused ? "● PAUSED" : state.busy ? "● WORKING" : "● ON";
  }

  function estimateTokens(text) {
    // Deliberately labelled estimate; languages/code vary substantially.
    return Math.max(1, Math.ceil(String(text || "").length / 4));
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString();
  }

  function renderStats() {
    $("#st-turns").textContent = fmt(state.turn);
    $("#st-in").textContent = fmt(state.deepseekInput);
    $("#st-out").textContent = fmt(state.deepseekOutput);
    $("#st-cache").textContent = fmt(state.deepseekCacheRead);
    $("#st-gpt").textContent = "~" + fmt(state.chatgptEstimatedTokens);
    $("#st-cost").textContent = "$" + Number(state.costUsd || 0).toFixed(4);
  }

  function addLog(role, text, meta = "") {
    state.transcript.push({ role, text, meta, at: new Date().toISOString() });
    const div = document.createElement("div");
    div.className = "msg";
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = `${role}${meta ? " · " + meta : ""}`;
    const body = document.createElement("div");
    body.textContent = text;
    div.append(m, body);
    logEl.prepend(div);
  }

  async function httpGet(path) {
    let lastError = null;

    for (const url of bridgeUrls(path)) {
      try {
        return await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: "GET",
            url,
            headers: {
              "X-Orchestrator-Token": tokenEl.value.trim(),
            },
            timeout: 5000,
            onload: r => {
              let parsed;
              try { parsed = JSON.parse(r.responseText); }
              catch { return reject(new Error(`${url}: invalid JSON response`)); }

              if (r.status < 200 || r.status >= 300 || !parsed.ok) {
                reject(new Error(`${url}: ${parsed.error || `HTTP ${r.status}`}`));
              } else {
                resolve(parsed);
              }
            },
            onerror: () => reject(new Error(`${url}: network error`)),
            onabort: () => reject(new Error(`${url}: request aborted`)),
            ontimeout: () => reject(new Error(`${url}: request timed out`)),
          });
        });
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(
      `Bridge test failed. Tried: ${BRIDGES.join(", ")}. ` +
      `Last error: ${lastError?.message || "unknown"}`
    );
  }

  async function httpPost(path, body) {
    let lastError = null;

    for (const url of bridgeUrls(path)) {
      try {
        return await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: "POST",
            url,
            headers: {
              "Content-Type": "application/json",
              "X-Orchestrator-Token": tokenEl.value.trim(),
            },
            data: JSON.stringify(body),
            timeout: 30 * 60 * 1000,
            onload: r => {
              let parsed;
              try { parsed = JSON.parse(r.responseText); }
              catch { return reject(new Error(`${url}: invalid JSON response`)); }

              if (r.status < 200 || r.status >= 300 || !parsed.ok) {
                reject(new Error(`${url}: ${parsed.error || `HTTP ${r.status}`}`));
              } else {
                resolve(parsed);
              }
            },
            onerror: () => reject(new Error(`${url}: network error`)),
            onabort: () => reject(new Error(`${url}: request aborted`)),
            ontimeout: () => reject(new Error(`${url}: request timed out`)),
          });
        });
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(
      `Cannot reach local bridge. Tried: ${BRIDGES.join(", ")}. ` +
      `Last error: ${lastError?.message || "unknown"}`
    );
  }

  function getPageConversationText() {
    // Search the page text directly instead of depending on ChatGPT's
    // internal message DOM structure, which changes frequently.
    const clone = document.body.cloneNode(true);

    // Remove our own panel so its labels/log cannot create false matches.
    const ownPanel = clone.querySelector("#ds-orch");
    if (ownPanel) ownPanel.remove();

    // Remove common non-conversation UI that can duplicate text.
    for (const el of clone.querySelectorAll("nav, aside, header, footer, script, style")) {
      el.remove();
    }

    return (clone.innerText || clone.textContent || "").trim();
  }

  function extractLatestTask() {
    const text = getPageConversationText();
    if (!text) return null;

    const doneAt = text.lastIndexOf(DONE_MARKER);
    const taskAt = text.lastIndexOf(TASK_OPEN);

    // If the most recent protocol marker is COMPLETE, stop.
    if (doneAt >= 0 && doneAt > taskAt) {
      return { done: true, text };
    }

    if (taskAt < 0) return null;

    const closeAt = text.indexOf(TASK_CLOSE, taskAt + TASK_OPEN.length);
    if (closeAt < 0) return null;

    const taskText = text.slice(taskAt + TASK_OPEN.length, closeAt).trim();

    return {
      done: false,
      text: taskText,
      whole: text.slice(taskAt, closeAt + TASK_CLOSE.length),
    };
  }

  function fingerprint(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 20 && r.height > 10 &&
      s.display !== "none" && s.visibility !== "hidden";
  }

  function findComposer() {
    const selectors = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'form div[contenteditable="true"]',
      'textarea[placeholder]',
      'textarea'
    ];

    const candidates = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        // Avoid editable elements inside our panel.
        if (el.closest("#ds-orch")) continue;
        candidates.push(el);
      }
      if (candidates.length) break;
    }

    if (!candidates.length) return null;

    // Usually the active composer is the lowest visible candidate on the page.
    candidates.sort((a, b) =>
      b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom
    );
    return candidates[0];
  }

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype :
      el.tagName === "INPUT" ? HTMLInputElement.prototype :
      null;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function setComposerText(text) {
    const el = findComposer();
    if (!el) {
      const editables = [...document.querySelectorAll('[contenteditable="true"], textarea')]
        .filter(x => !x.closest("#ds-orch"));
      throw new Error(`Could not find ChatGPT composer. Visible editor candidates: ${
        editables.filter(isVisible).length
      }`);
    }

    el.focus();

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      setNativeValue(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    // Modern ChatGPT editors may use Lexical or ProseMirror.
    // First try standards-based selection/input.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {}

    if (!inserted || !(el.innerText || el.textContent || "").includes(text.slice(0, Math.min(20, text.length)))) {
      // Fallback: replace editable content while preserving line breaks.
      el.innerHTML = "";
      const lines = String(text).split("\n");
      for (const line of lines) {
        const p = document.createElement("p");
        if (line === "") p.appendChild(document.createElement("br"));
        else p.textContent = line;
        el.appendChild(p);
      }
    }

    try {
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    } catch {}

    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  async function clickSend() {
    await new Promise(r => setTimeout(r, 500));

    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'form button[type="submit"]'
    ];

    let btn = null;
    for (const sel of selectors) {
      btn = [...document.querySelectorAll(sel)]
        .filter(b => !b.closest("#ds-orch"))
        .find(b => isVisible(b) && !b.disabled);
      if (btn) break;
    }

    if (!btn) {
      const buttons = [...document.querySelectorAll("button")].filter(b => !b.closest("#ds-orch"));
      btn = buttons.find(b => {
        const label = [
          b.getAttribute("aria-label"),
          b.getAttribute("data-testid"),
          b.title,
          b.innerText
        ].filter(Boolean).join(" ");
        return isVisible(b) && !b.disabled && /send|submit/i.test(label);
      });
    }

    if (!btn) throw new Error("Could not find an enabled ChatGPT Send button.");
    btn.click();
  }

  async function returnCoderReply(reply, usage, costUsd) {
    const cleanReply = String(reply || "").trim();

    const wrapped =
`${RESULT_OPEN}

${cleanReply}

${RESULT_CLOSE}

Coder metadata:
- turn: ${state.turn}
- DeepSeek input tokens: ${usage?.input ?? 0}
- DeepSeek output tokens: ${usage?.output ?? 0}
- reported cost USD: ${costUsd ?? "unknown"}

Continue orchestrating.
If more coding work is needed, emit exactly one new ${TASK_OPEN} ... ${TASK_CLOSE} block.
If the objective is complete, emit ${DONE_MARKER}.`;

    state.chatgptEstimatedTokens += estimateTokens(wrapped);
    setComposerText(wrapped);
    await clickSend();
  }

  async function processTask(task) {
    if (state.busy || state.paused) return;

    const fp = fingerprint(task.text);
    if (fp === state.lastTaskFingerprint) {
      setStatus("This CODER_TASK was already completed. Reset the session to run it again.");
      return;
    }
    state.busy = true;
    state.turn += 1;

    state.chatgptEstimatedTokens += estimateTokens(task.whole || task.text);
    renderStats();
    addLog("ChatGPT → coder", task.text, `turn ${state.turn}`);
    setStatus("Coder working…");

    try {
      const result = await httpPost("/task", {
        browserSessionId: state.browserSessionId,
        project: projectEl.value.trim(),
        prompt: task.text,
      });

      const u = result.usage || {};
      state.deepseekInput += Number(u.input || 0);
      state.deepseekOutput += Number(u.output || 0);
      state.deepseekCacheRead += Number(u.cacheRead || 0);
      state.deepseekCacheCreate += Number(u.cacheCreate || 0);
      state.costUsd += Number(result.costUsd || 0);

      addLog("Coder → ChatGPT", result.reply, [
        `in ${fmt(u.input)}`,
        `out ${fmt(u.output)}`,
        result.costUsd != null ? `$${Number(result.costUsd).toFixed(4)}` : ""
      ].filter(Boolean).join(" · "));
      renderStats();

      await returnCoderReply(result.reply, u, result.costUsd);
      // Mark a task as processed only after the coder result was successfully
      // returned to ChatGPT. Failed attempts therefore remain retryable.
      state.lastTaskFingerprint = fp;
      setStatus("Reply returned to ChatGPT; waiting for next task.");
    } catch (err) {
      state.paused = true;
      addLog("ERROR", err.message || String(err));
      setStatus("Paused after error: " + (err.message || String(err)));
    } finally {
      state.busy = false;
      dotEl.textContent = state.paused ? "● PAUSED" : "● ON";
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (state.paused || state.busy) return;
      const task = extractLatestTask();
      if (!task) return;
      if (task.done) {
        state.paused = true;
        setStatus("Orchestration complete.");
        return;
      }
      processTask(task);
    }, 700);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });

  $("#ds-start").addEventListener("click", () => {
    if (!projectEl.value.trim() || !tokenEl.value.trim()) {
      setStatus("Project directory and bridge token are required.");
      return;
    }
    state.paused = false;
    state.running = true;

    // Process an already-visible task immediately. Start should not depend on
    // a later DOM mutation to wake the scanner up.
    const task = extractLatestTask();
    if (task?.done) {
      state.paused = true;
      setStatus("The latest protocol marker is ORCHESTRATION_COMPLETE.");
      return;
    }
    if (task && !state.busy) {
      setStatus("CODER_TASK found. Sending to coder…");
      processTask(task);
      return;
    }

    setStatus("Watching ChatGPT for CODER_TASK blocks.");
    scheduleScan();
  });

  $("#ds-pause").addEventListener("click", () => {
    state.paused = true;
    setStatus("Paused.");
  });

  $("#ds-reset").addEventListener("click", async () => {
    state.paused = true;
    try {
      await httpPost("/session/reset", { browserSessionId: state.browserSessionId });
    } catch {}
    state.browserSessionId = crypto.randomUUID();
    state.lastTaskFingerprint = "";
    state.turn = 0;
    state.deepseekInput = state.deepseekOutput = state.deepseekCacheRead = state.deepseekCacheCreate = 0;
    state.chatgptEstimatedTokens = 0;
    state.costUsd = 0;
    renderStats();
    setStatus("Session reset.");
  });

  $("#ds-clear").addEventListener("click", () => {
    state.transcript.length = 0;
    logEl.innerHTML = "";
  });

  $("#ds-copy-prompt").addEventListener("click", async () => {
    const protocol =
`You are the orchestrator. Delegate coding work to the external coder by emitting exactly:

${TASK_OPEN}
A concrete coding task. Include what to inspect/change/test and any constraints.
${TASK_CLOSE}

After you receive a ${RESULT_OPEN} block, evaluate the coder's result and either issue another CODER_TASK or finish with:

${DONE_MARKER}

Do not put CODER_TASK markers around explanations intended only for me.`;
    try {
      await navigator.clipboard.writeText(protocol);
      setStatus("Protocol prompt copied.");
    } catch {
      addLog("PROTOCOL PROMPT", protocol);
      setStatus("Clipboard unavailable; prompt added to log.");
    }
  });



  $("#ds-scan").addEventListener("click", () => {
    const task = extractLatestTask();
    if (!task) {
      const pageText = getPageConversationText();
      const markerCount = (pageText.match(/<<<CODER_TASK>>>/g) || []).length;
      setStatus(`No complete CODER_TASK found. Marker occurrences: ${markerCount}`);
      return;
    }
    if (task.done) {
      setStatus("Found ORCHESTRATION_COMPLETE.");
      return;
    }
    setStatus("CODER_TASK found.");
    addLog("DETECTED TASK", task.text);
    if (!state.paused && !state.busy) processTask(task);
  });

  $("#ds-test-bridge").addEventListener("click", async () => {
    setStatus("Testing bridge…");
    try {
      const result = await httpGet("/health");
      setStatus(`Bridge OK: ${result.service || "reachable"}`);
      addLog("BRIDGE", "Connection successful.");
    } catch (err) {
      setStatus("Bridge test failed: " + (err.message || String(err)));
      addLog("BRIDGE ERROR", err.message || String(err));
    }
  });


  $("#ds-test-composer").addEventListener("click", () => {
    try {
      const el = findComposer();
      if (!el) {
        setStatus("Composer test failed: no visible editor found.");
        return;
      }

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const ce = el.getAttribute("contenteditable") || "";
      setStatus(`Composer found: <${tag}> role=${role || "-"} contenteditable=${ce || "-"}`);
      addLog("COMPOSER", `Found ${tag}; role=${role || "-"}; contenteditable=${ce || "-"}`);
    } catch (err) {
      setStatus("Composer test failed: " + (err.message || String(err)));
    }
  });

  // ---- Draggable / minimizable panel ----
  const dragHandle = $("#ds-drag-handle");
  const minimizeBtn = $("#ds-minimize");

  function clampPosition(left, top) {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  function applySavedPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem("ds-orch-position") || "null");
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      const pos = clampPosition(saved.left, saved.top);
      panel.style.left = pos.left + "px";
      panel.style.top = pos.top + "px";
    } catch {}
  }

  let dragState = null;

  dragHandle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, input, textarea, select, a")) return;

    const rect = panel.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };

    panel.style.right = "auto";
    panel.style.bottom = "auto";
    dragHandle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });

  dragHandle.addEventListener("pointermove", (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    const left = e.clientX - dragState.offsetX;
    const top = e.clientY - dragState.offsetY;
    const pos = clampPosition(left, top);

    panel.style.left = pos.left + "px";
    panel.style.top = pos.top + "px";
  });

  function endDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    dragState = null;

    const rect = panel.getBoundingClientRect();
    localStorage.setItem("ds-orch-position", JSON.stringify({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
    }));

    try { dragHandle.releasePointerCapture?.(e.pointerId); } catch {}
  }

  dragHandle.addEventListener("pointerup", endDrag);
  dragHandle.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", () => {
    const rect = panel.getBoundingClientRect();
    const pos = clampPosition(rect.left, rect.top);
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = pos.left + "px";
    panel.style.top = pos.top + "px";
  });

  minimizeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("minimized");
    minimizeBtn.textContent = panel.classList.contains("minimized") ? "+" : "−";
    minimizeBtn.title = panel.classList.contains("minimized") ? "Restore" : "Minimize";
  });

  applySavedPosition();
  renderStats();
})();
