"""Local reranker sidecar: scores (query, document) pairs with a cross-encoder.

POST /rerank {"query": "...", "docs": ["...", ...]} -> {"model": "...", "scores": [0..1, ...]}
Listens on 127.0.0.1 only. Ollama cannot run cross-encoders, so this runs next to it.

    %LOCALAPPDATA%/tsolve-decision/rerank-venv/Scripts/python.exe rerank/server.py   (Windows; keep the venv outside OneDrive)
erank-venvScriptspython.exe rerankserver.py   (Windows; keep the venv outside OneDrive)
    RERANK_MODEL=... PORT=8790 python rerank/server.py
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from sentence_transformers import CrossEncoder

MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
PORT = int(os.environ.get("PORT", "8790"))
MAX_DOCS = 32

print(f"loading {MODEL} ...", flush=True)
model = CrossEncoder(MODEL, max_length=512, device="cpu")
torch.set_grad_enabled(False)


def scores(query: str, docs: list[str]) -> list[float]:
    # raw logits, then sigmoid ourselves so the result does not depend on the library's default activation
    logits = model.predict([(query, d) for d in docs], activation_fn=torch.nn.Identity(), convert_to_tensor=True)
    return [round(float(x), 4) for x in torch.sigmoid(logits.float()).reshape(-1)]


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if self.path != "/rerank":
            return self._send(404, {"error": "POST /rerank only"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1_000_000:
                return self._send(413, {"error": "body over 1 MB"})
            body = json.loads(self.rfile.read(length) or b"{}")
            query, docs = body.get("query"), body.get("docs")
            if not isinstance(query, str) or not isinstance(docs, list) or not all(isinstance(d, str) for d in docs):
                return self._send(422, {"error": "send {query: string, docs: string[]}"})
            if not docs or len(docs) > MAX_DOCS:
                return self._send(422, {"error": f"send 1-{MAX_DOCS} docs"})
        except (ValueError, json.JSONDecodeError):
            return self._send(422, {"error": "body must be JSON"})
        started = time.perf_counter()
        result = scores(query, docs)
        self._send(200, {"model": MODEL, "scores": result, "ms": round((time.perf_counter() - started) * 1000)})

    def log_message(self, fmt: str, *args) -> None:  # one short line per request
        print(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)


if __name__ == "__main__":
    print(f"reranker on http://127.0.0.1:{PORT}/rerank ({MODEL})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
