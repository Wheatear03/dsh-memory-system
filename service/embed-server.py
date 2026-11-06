"""本地 embedding HTTP 服务（OpenAI 兼容 /embeddings）
给 dsh-remembers 的 CMEM_EMBED_BASE 用。
模型：BAAI/bge-small-zh-v1.5（中文，小，快）
端口：8090
"""
import json
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")

from http.server import BaseHTTPRequestHandler, HTTPServer

_model = None
MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
PORT = int(os.environ.get("EMBED_PORT", "8090"))


def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME)
    return _model


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/health", "/"):
            self._send(200, {"ok": True, "model": MODEL_NAME, "port": PORT})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        # 同时接受 OpenAI 标准的 /v1/embeddings 和裸的 /embeddings
        # （2026-10-31：mnemon 只看 endpoint 结尾有没有 /v1 来判协议，
        #  补上 /v1 这条路才能接过去）
        if self.path.rstrip("/") not in ("/embeddings", "/v1/embeddings"):
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            inp = body.get("input")
            if isinstance(inp, str):
                inp = [inp]
            if not isinstance(inp, list) or not inp:
                self._send(400, {"error": "input required"})
                return
            m = get_model()
            vecs = m.encode([str(x) for x in inp], normalize_embeddings=True, batch_size=16).tolist()
            self._send(200, {
                "object": "list",
                "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vecs)],
                "model": MODEL_NAME,
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            })
        except Exception as e:
            self._send(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print("[embed] " + fmt % args, flush=True)


if __name__ == "__main__":
    print("[embed] loading model %s ..." % MODEL_NAME, flush=True)
    get_model()
    print("[embed] ready on http://127.0.0.1:%d" % PORT, flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
