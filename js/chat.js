/* Pinned: every behaviour below was verified against this exact build. */
import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.84";
import { SYSTEM_PROMPT, SUGGESTIONS } from "./profile.js";

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
  "Qwen3.5-0.8B-q4f16_1-MLC",          // 1629 MB — newest family
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

let engine = null;
let history = [{ role: "system", content: SYSTEM_PROMPT }];
let generating = false;

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

/* Small models keep opening with a citation of their own context. */
const PREAMBLE = /^\s*(?:based on|according to|from|per)\s+(?:the\s+)?(?:provided\s+)?(?:profile|information|context|details|background)[^,.:;]*[,.:;]\s*/i;
function stripPreamble(t) {
  const out = t.replace(PREAMBLE, "");
  return out === t ? t : out.charAt(0).toUpperCase() + out.slice(1);
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

function fail(title, detail, links = true) {
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

  /* Cache API storage is best-effort by default, so a browser under disk
     pressure can evict the model and force a re-download on the next visit.
     Asking for persistent storage exempts this origin from that eviction. */
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      const granted = await navigator.storage.persist();
      console.info("persistent storage:", granted ? "granted" : "refused");
    }
  } catch (e) { /* not fatal; the model still caches, just evictably */ }

  const models = pickModels();
  const worker = new Worker(new URL("./chat-worker.js", import.meta.url), { type: "module" });
  let modelId = null;
  let lastErr = null;

  /* A model can be listed in prebuiltAppConfig yet be unloadable (missing or
     newer-format weights on the CDN). Fall through to the next one instead of
     handing the visitor a dead page. */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const candidate of models) {
   /* A mid-download CDN hiccup (rate limiting, a dropped connection) surfaces as
      a generic cache error. Retry the same model once before falling back, so a
      blip doesn't silently hand the visitor a weaker model for the whole visit. */
   for (let attempt = 0; attempt < 2; attempt++) {
    try {
      engine = await webllm.CreateWebWorkerMLCEngine(worker, candidate, {
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
      });
      modelId = candidate;
      break;
    } catch (err) {
      lastErr = err;
      bar.style.width = "0%";
      if (attempt === 0) {
        console.warn(`${candidate} failed to load, retrying once`, err);
        loaderMsg.textContent = "Hit a snag fetching the weights, retrying…";
        await sleep(1500);
      } else {
        console.warn(`${candidate} failed twice, trying the next model`, err);
      }
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
      messages: [...history, { role: "user", content: "Which company does Reza work for?" }],
      max_tokens: 8, temperature: 0.1,
      extra_body: { enable_thinking: false },
    });
    console.info(`warm-up ok in ${((performance.now() - warmStart) / 1000).toFixed(1)}s`,
                 warm?.choices?.[0]?.message?.content?.slice(0, 40));
  } catch (e) {
    console.warn("warm-up failed; the first answer will be slower", e);
  }

  loader.hidden = true;
  chat.hidden = false;
  setStatus(modelId.replace(/-MLC$/, "") + " · running locally");
  showRuntime(modelId);
  input.disabled = false;
  sendBtn.disabled = false;
  input.focus();
}

/* --------------------------------------------------------------- generation */

async function ask(question) {
  if (generating || !engine) return;
  generating = true;
  input.value = "";
  input.style.height = "auto";
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  chips.hidden = true;

  addMessage("user", question);
  history.push({ role: "user", content: question });

  const body = addMessage("assistant", "");
  body.classList.add("thinking");
  let answer = "";
  const t0 = performance.now();
  let firstTokenMs = null;

  try {
    const stream = await engine.chat.completions.create({
      messages: history,
      stream: true,
      stream_options: { include_usage: true },
      /* Near-greedy: this is grounded lookup over a fixed profile, not creative
         writing, so we want the most probable answer every time. Low temperature
         makes small models prone to repetition loops, which is what the
         frequency penalty is here to break — the two go together. */
      temperature: 0.1,
      top_p: 0.9,
      frequency_penalty: 0.4,
      presence_penalty: 0.2,
      max_tokens: 500,
      extra_body: { enable_thinking: false },
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
        answer += delta;
        body.classList.remove("thinking");
        body.replaceChildren(render(stripPreamble(stripThink(answer).trimStart())));
        log.scrollTop = log.scrollHeight;
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

    const clean = stripPreamble(stripThink(answer).trim());
    if (!clean) {
      body.replaceChildren(render("I didn't manage an answer to that one. Try rephrasing?"));
    }
    history.push({ role: "assistant", content: clean });
  } catch (err) {
    if (err?.name === "AbortError") {
      /* Visitor pressed Stop. Keep whatever streamed so the log and history agree. */
      const partial = stripPreamble(stripThink(answer).trim());
      if (partial) history.push({ role: "assistant", content: partial });
      else history.pop();
    } else {
      console.error(err);
      body.classList.remove("thinking");
      body.replaceChildren(render("Something went wrong generating that answer. Try again?"));
      history.pop();
    }
  } finally {
    generating = false;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    input.focus();
  }
}

/* ------------------------------------------------------------------- wiring */

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (q) ask(q);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

stopBtn.addEventListener("click", () => { engine?.interruptGenerate(); });

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
