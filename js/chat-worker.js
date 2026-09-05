/* Runs the WebLLM engine off the main thread so the UI never blocks. */
import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.84";

const handler = new webllm.WebWorkerMLCEngineHandler();
self.onmessage = (msg) => { handler.onmessage(msg); };
