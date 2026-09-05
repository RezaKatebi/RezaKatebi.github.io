/* Service worker that owns the language model.

   A page navigation destroys the page's JavaScript context, so a model held by
   the page (or by a dedicated worker the page owns) has to be rebuilt on every
   visit to the chat. A service worker outlives navigations, so the model stays
   resident: WebLLM's handler answers a reload request for a model it already
   holds with "Already loaded the model. Skip loading" and returns immediately.

   It registers no fetch handler on purpose, so it never intercepts or caches
   ordinary requests for the site. */
/* The direct jsDelivr URL, not esm.run: esm.run answers with a 301, and a
   service worker script (and its static imports) must not be redirected, or the
   worker fails to start with "ServiceWorker cannot be started". */
import * as webllm from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm";

const handler = new webllm.ServiceWorkerMLCEngineHandler();
void handler;

/* Take over without waiting for every open tab to close, so a first visit can
   use the worker immediately rather than only after a reload. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
