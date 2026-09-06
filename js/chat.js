/* Pinned: every behaviour below was verified against this exact build. */
import * as webllm from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm";
import { SYSTEM_PROMPT, SUGGESTIONS, classify, REFUSALS } from "./profile.js?v=3b78f5b9";

/* Candidate models, newest first, resolved against whatever this build of WebLLM
   actually ships so a CDN version bump can't strand us on a dead id.

   On the manifest format: this runtime fetches tensor-cache.json (it never asks
   for ndarray-cache.json), and every model below has one. An earlier failure to
   load Qwen3.5 was HuggingFace returning 429 after repeated test downloads, not
   a broken model — Cache.add() reports any non-2xx as the opaque "Request
   failed", which is why boot() retries before giving up on a candidate.

   These are hybrid reasoning models. We pass extra_body.enable_thinking=false,
   which WebLLM implements by pre-seeding the literal string "<think>\n\n</think>\n\n"
   into the output — so the reply still ARRIVES with a think block and
   stripThink() below has to remove it. Sizes are vram_required_MB. */
const CANDIDATES = [
  "Qwen3.5-2B-q4f16_1-MLC",            // 2245 MB — better answers, not flagged low-resource
  "Qwen3.5-0.8B-q4f16_1-MLC",          // 1629 MB — fallback for weaker GPUs
  "Qwen3-1.7B-q4f16_1-MLC",            // 2037 MB — better answers, ~2x the wait
  "Qwen3-0.6B-q4f16_1-MLC",            // 1403 MB — fastest
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", // 1630 MB
  "Llama-3.2-1B-Instruct-q4f16_1-MLC", //  879 MB, last resort
];

const $ = (sel) => document.querySelector(sel);
const gate      = $("#gate");
const gateBody  = $("#gate-body");
const loader    = $("#loader");
const loaderMsg = $("#loader-msg");
const bar       = $("#bar");
const chat      = $("#chat");
const log       = $("#log");
const form      = $("#composer");
const input     = $("#input");
const sendBtn   = $("#send");
const stopBtn   = $("#stop");
const statusEl  = $("#status");
const chips     = $("#chips");
const runtime   = $("#runtime");
const clearBtn  = $("#clear");

let engine = null;

/* Only user/assistant turns live here; the system message is prepended per
   request by buildMessages() so the context budget can be enforced in one place. */
let turns = [];

/* WebLLM rebuilds the conversation from `messages` on every call and prefills all
   of it, so an unbounded history makes each answer slower than the last and
   eventually throws ContextWindowSizeExceededError, which would break the chat
   for good. Budget in characters (~4 per token) against the model's 4096 window. */
const CTX_CHARS      = 4096 * 4;
const RESERVE_CHARS  = 240 * 4 + 1200;   // room for max_tokens plus slack
/* The full resume is about 2500 tokens and the window is 4096, so only a few
   turns of history fit alongside it. buildMessages() drops the oldest turns
   rather than letting WebLLM throw ContextWindowSizeExceededError. */

function buildMessages() {
  const budget = CTX_CHARS - SYSTEM_PROMPT.length - RESERVE_CHARS;
  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const size = turns[i].content.length;
    if (used + size > budget && kept.length) break;
    kept.unshift(turns[i]);
    used += size;
  }
  /* A window must not open on an assistant reply with no question before it. */
  while (kept.length && kept[0].role === "assistant") kept.shift();
  return [{ role: "system", content: SYSTEM_PROMPT }, ...kept];
}
let generating = false;
/* `engine` is assigned before warm-up runs, so it cannot gate submissions: a
   question sent during warm-up would race the warm-up request. `ready` is only
   true once the model can actually answer. */
let ready = false;
/* A question typed while the model was still loading, to send once it is. */
let queued = false;
/* The "still loading" notice, removed once the model can answer. */
let loadingNote = null;
/* interruptGenerate() only sets a flag inside WebLLM: the stream then ends
   normally rather than rejecting, so a stop is indistinguishable from a finished
   answer unless we record it ourselves. */
let stopped = false;

/* ---------------------------------------------------------------- helpers */

const fmtBytes = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";

/* Everything here is measured on the visitor's own machine; the point of the
   panel is to make "this runs locally" checkable rather than just claimed. */
async function showRuntime(modelId) {
  const set = (id, text, good) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (good) el.classList.add("good");
  };

  try {
    const adapter = await navigator.gpu.requestAdapter();
    const i = adapter?.info || {};
    const name = [i.vendor, i.architecture].filter(Boolean).join(" ") || i.description || "WebGPU device";
    set("rt-gpu", name, true);
  } catch (e) { set("rt-gpu", "your GPU", true); }

  const entry = (webllm.prebuiltAppConfig?.model_list ?? []).find((m) => m.model_id === modelId);
  const vram = entry?.vram_required_MB ? ` · ${(entry.vram_required_MB / 1024).toFixed(1)} GB VRAM` : "";
  set("rt-model", modelId.replace(/-q4f16_1-MLC$/, "").replace(/-MLC$/, "") + vram);

  try {
    const { usage } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    set("rt-cache", fmtBytes(usage || 0) + (persisted ? " cached, kept" : " cached"));
  } catch (e) { set("rt-cache", "cached"); }

  runtime.hidden = false;
}

function pickModels() {
  const available = new Set(
    (webllm.prebuiltAppConfig?.model_list ?? []).map((m) => m.model_id)
  );
  const usable = CANDIDATES.filter((id) => available.has(id));
  return usable.length ? usable : [CANDIDATES[CANDIDATES.length - 1]];
}

/* Models emit markdown bold. Render it as real elements built from text nodes —
   never innerHTML, so model output still cannot inject markup. */
function inline(target, text) {
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
    const b = document.createElement("strong");
    b.textContent = m[1];
    target.appendChild(b);
    last = re.lastIndex;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

/* Models often inline bullets mid-paragraph ("initiatives: * A: ... * B: ..."),
   which would otherwise render as literal asterisks. A space-flanked asterisk is
   always a bullet: "**bold**" never has a space between its asterisks, so this
   cannot damage bold markers. */
function normalizeBullets(text) {
  return text.replace(/[ \t]\*[ \t]/g, "\n- ");
}

/* Minimal, escape-first renderer. We never inject model output as HTML. */
function render(text) {
  const frag = document.createDocumentFragment();
  const blocks = normalizeBullets(text).split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    const isList = lines.length > 0 && lines.every((l) => /^\s*(?:[-*•]|\d+\.)\s+/.test(l));
    if (isList && lines.length) {
      const ul = document.createElement("ul");
      for (const line of lines) {
        const li = document.createElement("li");
        inline(li, line.replace(/^\s*(?:[-*•]|\d+\.)\s+/, ""));
        ul.appendChild(li);
      }
      frag.appendChild(ul);
    } else {
      const p = document.createElement("p");
      inline(p, block);
      frag.appendChild(p);
    }
  }
  return frag;
}

/* enable_thinking:false still emits an empty <think></think> pair. */
const THINK = /<think>[\s\S]*?(?:<\/think>|$)/g;
const stripThink = (t) => t.replace(THINK, "");

/* The prompt gives the model a refusal sentence to use for off-topic questions.
   A small model sometimes appends it to a perfectly good answer, so drop it when
   there is real content in front of it. A bare refusal is left alone. */
const REFUSAL_TAIL = /\s*I only answer questions about Reza['\u2019]?s background and work\.?\s*$/i;
function stripRefusalTail(t) {
  const out = t.replace(REFUSAL_TAIL, "").trim();
  return out.length > 20 ? out : t;
}

/* Small models keep opening with a citation of their own context. */
const PREAMBLE = /^\s*(?:based on|according to|from|per)\s+(?:the\s+)?(?:provided\s+)?(?:profile|information|context|details|background)[^,.:;]*[,.:;]\s*/i;
function stripPreamble(t) {
  const out = t.replace(PREAMBLE, "");
  return out === t ? t : out.charAt(0).toUpperCase() + out.slice(1);
}

function attachCopy(el, getText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.textContent = "copy";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = "copied";
    } catch (e) {
      btn.textContent = "press ctrl+c";   // clipboard blocked, e.g. insecure context
    }
    setTimeout(() => { btn.textContent = "copy"; }, 1600);
  });
  el.appendChild(btn);
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = "msg msg-" + role;
  const body = document.createElement("div");
  body.className = "msg-body";
  if (text) body.appendChild(render(text));
  el.appendChild(body);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return body;
}

function setStatus(text) { statusEl.textContent = text; }

/* The reader may scroll up to re-read an earlier answer while a new one streams;
   only pin to the bottom when they are already there. */
function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

/* Rebuilding the answer DOM on every token is quadratic in answer length and
   forces a reflow per token. Coalesce to one render per animation frame. */
function streamInto(body) {
  let pending = null;
  let frameQueued = false;
  const flush = () => {
    frameQueued = false;
    if (pending === null) return;
    const stick = nearBottom();
    body.replaceChildren(render(pending));
    pending = null;
    if (stick) log.scrollTop = log.scrollHeight;
  };
  return {
    update(text) {
      pending = text;
      if (!frameQueued) { frameQueued = true; requestAnimationFrame(flush); }
    },
    finish(text) { pending = text; flush(); },
  };
}

/* Conversation survives a reload and moving between pages, and is gone once the
   tab is closed. sessionStorage rather than localStorage, so nothing about a
   visitor's questions outlives their visit. */
const STORE_KEY = "chat-turns-v1";
function saveTurns() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(turns.slice(-20)));
  } catch (e) { /* private mode or full quota: the chat still works, just not across reloads */ }
}
function loadTurns() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      return parsed.filter((t) => t && typeof t.content === "string"
        && (t.role === "user" || t.role === "assistant"));
    }
  } catch (e) { /* ignore malformed storage */ }
  return [];
}

function fail(title, detail, links = true) {
  /* Nothing will ever send now, so stop the composer implying otherwise. */
  ready = false;
  queued = false;
  input.disabled = true;
  sendBtn.disabled = true;
  gate.hidden = false;
  loader.hidden = true;
  chat.hidden = true;
  gateBody.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  gateBody.append(h, p);
  if (links) {
    const row = document.createElement("div");
    row.className = "hero-cta";
    row.innerHTML =
      '<a class="btn btn-primary" href="../assets/files/RezaKatebi.pdf">Download the resume instead</a>' +
      '<a class="btn" href="https://www.linkedin.com/in/reza-katebi/" target="_blank" rel="noopener">LinkedIn</a>';
    gateBody.appendChild(row);
  }
}

/* ---------------------------------------------------------- capability gate */

async function checkWebGPU() {
  if (!("gpu" in navigator)) {
    fail(
      "This browser can't run the model.",
      "The chat needs WebGPU, which is available in Chrome, Edge, Arc, and Safari 26+. " +
      "Firefox and older Safari versions won't work yet. Everything below still does."
    );
    return false;
  }
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter(); } catch (e) { /* handled below */ }
  if (!adapter) {
    fail(
      "No compatible GPU found.",
      "Your browser supports WebGPU but couldn't get a GPU adapter. This usually means " +
      "hardware acceleration is disabled, or the GPU is blocklisted by the browser."
    );
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ engine */

async function boot() {
  gate.hidden = true;
  loader.hidden = false;

  /* Reveal the conversation immediately so the download is not dead time: the
     visitor can type now and the question fires the moment the model is ready. */
  chat.hidden = false;
  chat.classList.add("is-loading");
  sendBtn.textContent = "Queue";
  input.disabled = false;
  input.placeholder = "Type your question now, it will send as soon as the model is ready…";
  loadingNote = addMessage("assistant",
    "Loading the model onto your GPU. Nothing is sent to a server. "
    + "You can type your question now and it will send by itself once this finishes.");
  input.focus();

  /* Cache API storage is best-effort by default, so a browser under disk
     pressure can evict the model and force a re-download on the next visit.
     Asking for persistent storage exempts this origin from that eviction. */
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      const granted = await navigator.storage.persist();
      console.info("persistent storage:", granted ? "granted" : "refused");
    }
  } catch (e) { /* not fatal; the model still caches, just evictably */ }

  /* Two candidates, one retry each. Beyond that the cause is almost always the
     network rather than a bad model, and eight silent load attempts is a long
     wait with a progress bar stuck at zero. */
  const models = pickModels().slice(0, 2);
  /* Prefer the service worker: it survives navigating away and back, so the
     model does not have to be rebuilt every time the page is opened. Falls back
     to a dedicated worker where service workers are unavailable (no secure
     context, or the registration is refused). */
  let useServiceWorker = false;
  try {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      await navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { type: "module" });
      await navigator.serviceWorker.ready;
      /* Registered and activated is not the same as controlling this page. On a
         first visit the page is uncontrolled until the worker claims it, and
         WebLLM throws "There is no active service worker" if it posts before
         then. Wait for the claim, but do not hang if it never arrives. */
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          const done = () => resolve();
          navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
          setTimeout(done, 4000);
        });
      }
      useServiceWorker = !!navigator.serviceWorker.controller;
    }
  } catch (e) {
    console.warn("service worker unavailable, using a dedicated worker", e);
  }

  /* The dedicated worker is only built if it is actually needed. */
  let dedicated = null;
  const getDedicated = () => (dedicated ||=
    new Worker(new URL("./chat-worker.js", import.meta.url), { type: "module" }));

  let modelId = null;
  let lastErr = null;

  /* Two models, and for each of them the service worker then a dedicated worker.
     That covers a transient CDN failure and a service worker that cannot serve
     this visitor, without turning a dead network into eight silent attempts. */
  const transports = useServiceWorker ? ["service worker", "worker"] : ["worker"];

  for (const candidate of models) {
    for (const transport of transports) {
      try {
        const opts = {
          initProgressCallback: (report) => {
            const pct = Math.max(0, Math.min(1, report.progress || 0));
            bar.style.width = (pct * 100).toFixed(1) + "%";
            bar.parentElement.setAttribute("aria-valuenow", Math.round(pct * 100));
            const mb = /(\d+)MB/.exec(report.text || "");
            loaderMsg.textContent = report.text?.includes("Loading model from cache")
              ? "Loading from cache…"
              : mb ? `${mb[1]} MB downloaded · ${Math.round(pct * 100)}%`
                   : (report.text || "Preparing…").replace(/ It can take a while.*$/, "");
          },
        };
        engine = transport === "service worker"
          ? await webllm.CreateServiceWorkerMLCEngine(candidate, opts)
          : await webllm.CreateWebWorkerMLCEngine(getDedicated(), candidate, opts);
        modelId = candidate;
        break;
      } catch (err) {
        lastErr = err;
        bar.style.width = "0%";
        console.warn(`${candidate} failed to load via ${transport}`, err);
        loaderMsg.textContent = "Hit a snag fetching the weights, trying another way…";
      }
    }
    if (modelId) break;
  }

  if (!modelId) {
    fail(
      "The model failed to load.",
      "Something went wrong fetching or compiling the weights: " +
      (lastErr?.message || lastErr) + ". A reload often fixes it."
    );
    return;
  }

  /* Warm up with the FULL system prompt and a real (short) generation, so the
     visitor never pays shader compilation or first-run kernel setup on their
     own first question. Note this cannot remove per-message prefill: WebLLM
     rebuilds the conversation from `messages` on every call and has no
     cross-request prefix cache, so the system prompt is prefilled each time. */
  loaderMsg.textContent = "Warming up the model…";
  const warmStart = performance.now();
  try {
    const warm = await engine.chat.completions.create({
      messages: [{ role: "system", content: SYSTEM_PROMPT },
                 { role: "user", content: "Which company does Reza work for?" }],
      max_tokens: 8, temperature: 0.1,
      extra_body: { enable_thinking: false },
    });
    console.info(`warm-up ok in ${((performance.now() - warmStart) / 1000).toFixed(1)}s`,
                 warm?.choices?.[0]?.message?.content?.slice(0, 40));
  } catch (e) {
    console.warn("warm-up failed; the first answer will be slower", e);
  }

  loader.hidden = true;
  chat.classList.remove("is-loading");
  sendBtn.textContent = "Send";
  if (loadingNote) { loadingNote.closest(".msg")?.remove(); loadingNote = null; }
  ready = true;
  /* Tells the other pages it is worth keeping the worker warm. Without this they
     would wake it (and re-parse the whole runtime) for visitors who never opened
     the chat at all. */
  try { sessionStorage.setItem("chat-engine-live", "1"); } catch (e) { /* private mode */ }
  setStatus(modelId.replace(/-MLC$/, "") + " · running locally");
  showRuntime(modelId);
  input.placeholder = "Ask about his experience, research, or skills…";
  input.disabled = false;
  sendBtn.disabled = false;

  /* Replay anything from a previous visit so the log matches what the model sees. */
  turns = loadTurns();
  if (turns.length) {
    for (const t of turns) {
      const el = addMessage(t.role, t.content);
      if (t.role === "assistant") attachCopy(el.parentElement, () => t.content);
    }
    clearBtn.hidden = false;
    log.scrollTop = log.scrollHeight;
  }

  input.focus();
  if (queued && input.value.trim()) { queued = false; form.requestSubmit(); }
}

/* --------------------------------------------------------------- generation */

async function ask(question) {
  if (generating || !ready) return;
  generating = true;
  stopped = false;
  input.value = "";
  input.style.height = "auto";
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  chips.hidden = true;

  addMessage("user", question);

  /* Refuse anything unrelated before spending a single token on it. The model is
     small enough that it would answer confidently and wrongly. Returning from
     inside the try means the finally below still restores the controls. */
  const kind = classify(question);
  if (kind !== "on-topic") {
    try {
      addMessage("assistant", REFUSALS[kind]);
      chips.hidden = false;
      setStatus(kind === "greeting" ? "Ready" : "Off topic, not sent to the model");
    } finally {
      generating = false;
      sendBtn.hidden = false;
      stopBtn.hidden = true;
      clearBtn.hidden = turns.length === 0;
      input.focus();
    }
    return;
  }

  turns.push({ role: "user", content: question });

  const body = addMessage("assistant", "");
  body.classList.add("thinking");
  body.setAttribute("aria-busy", "true");
  const stream_ = streamInto(body);
  let answer = "";
  const t0 = performance.now();
  let firstTokenMs = null;
  const tick = setInterval(() => {
    if (firstTokenMs === null) setStatus(`Thinking… ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }, 500);

  try {
    const stream = await engine.chat.completions.create({
      messages: buildMessages(),
      stream: true,
      stream_options: { include_usage: true },
      /* Near-greedy: this is grounded lookup over a fixed profile, not creative
         writing, so we want the most probable answer every time. Low temperature
         makes small models prone to repetition loops, which is what the
         frequency penalty is here to break — the two go together. */
      temperature: 0.1,
      top_p: 0.9,
      frequency_penalty: 0.7,
      presence_penalty: 0.4,
      max_tokens: 240,
      extra_body: { enable_thinking: false },
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        if (firstTokenMs === null) { firstTokenMs = performance.now() - t0; clearInterval(tick); }
        answer += delta;
        body.classList.remove("thinking");
        stream_.update(stripPreamble(stripThink(answer).trimStart()));
      }
      if (chunk.usage) {
        const secs = (performance.now() - t0) / 1000;
        const tps = chunk.usage.completion_tokens / secs;
        setStatus(`${chunk.usage.completion_tokens} tokens · ${tps.toFixed(1)} tok/s · on your GPU`);
        const el = document.getElementById("rt-speed");
        if (el) {
          el.textContent = `${tps.toFixed(1)} tok/s`
            + (firstTokenMs !== null ? ` · ${(firstTokenMs / 1000).toFixed(1)}s to first token` : "");
        }
      }
    }

    /* A stop that produced text is a real (partial) answer and is kept. With no
       text at all there is nothing worth remembering, so drop the user turn too:
       pushing an empty assistant message would leave a blank turn in every later
       request and desync what the model sees from what is on screen. */
    const clean = stripRefusalTail(stripPreamble(stripThink(answer).trim()));
    stream_.finish(clean || "");
    body.removeAttribute("aria-busy");
    if (clean) {
      turns.push({ role: "assistant", content: clean });
      saveTurns();
      attachCopy(body.parentElement, () => clean);
    } else {
      body.classList.remove("thinking");
      body.replaceChildren(render(stopped
        ? "Stopped before it got going."
        : "I didn't manage an answer to that one. Try rephrasing?"));
      turns.pop();
    }
  } catch (err) {
    console.error(err);
    body.classList.remove("thinking");
    body.replaceChildren(render(err?.name === "ContextWindowSizeExceededError"
      ? "This conversation got too long for the model's context. Older turns were dropped; ask again."
      : "Something went wrong generating that answer. Try again?"));
    turns.pop();
  } finally {
    clearInterval(tick);
    generating = false;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    clearBtn.hidden = turns.length === 0;
    input.focus();
  }
}

/* ------------------------------------------------------------------- wiring */

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  if (!ready) {
    /* Still downloading or warming up. Keep the text and send it when ready. */
    queued = true;
    setStatus("Queued. This will send as soon as the model finishes loading.");
    return;
  }
  ask(q);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

stopBtn.addEventListener("click", () => { stopped = true; engine?.interruptGenerate(); });

clearBtn.addEventListener("click", () => {
  turns = [];
  try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to remove */ }
  log.replaceChildren();
  addMessage("assistant", "Cleared. Ask me anything about Reza's background.");
  chips.hidden = false;
  clearBtn.hidden = true;
  setStatus("Ready");
  input.focus();
});

$("#start").addEventListener("click", async () => {
  if (await checkWebGPU()) boot();
});

/* Suggestion chips */
for (const s of SUGGESTIONS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = s;
  b.addEventListener("click", () => ask(s));
  chips.appendChild(b);
}

/* If the weights are already in the browser cache, skip the download warning. */
(async () => {
  if (!("gpu" in navigator)) { await checkWebGPU(); return; }
  try {
    /* hasModelInCache is WebLLM's own check, so this reflects the actual model
       we are about to load rather than "some webllm cache exists". */
    const modelId = pickModels()[0];
    if (await webllm.hasModelInCache(modelId)) {
      document.getElementById("gate-note").textContent =
        "Already downloaded on this device, so this will take a few seconds.";
    }
  } catch (e) { /* cache probing is a nicety, not a requirement */ }
})();
