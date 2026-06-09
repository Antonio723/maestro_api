# -*- coding: utf-8 -*-
# Orquestra - Agente de Impressao de Etiquetas (Python 3, somente stdlib).
#
# Escuta em 127.0.0.1:<porta> e imprime ZPL cru na impressora COMPARTILHADA
# informada (copy /b para \\host\compartilhamento). O navegador (front) fala com
# este agente por HTTP.
#
# Diferenca para o agente PowerShell: este agente guarda EM MEMORIA o encaixe
# enviado pelo front (POST /load) ao selecionar a OS. Assim, a cada clique o
# front manda so a chave da peca (POST /print {key}) — payload minusculo — e o
# AGENTE monta o ZPL localmente, sem reenviar o desenho a cada impressao.
# Tambem aceita {zpl} direto (compat. com o protocolo antigo).
#
# Uso:  python agent.py        (ou o iniciar-agente.bat)
# Porta: env ORQ_AGENT_PORT (padrao 9110).

import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("ORQ_AGENT_PORT", "9110"))

# Encaixes carregados pelo front: { fileName: { "id": item, ... } }. Em memoria;
# zera quando o agente reinicia (o front recarrega via /load ao reabrir a OS).
LOADED = {}

PRINTER_RE = re.compile(r"^[\w .$()+#-]{1,80}$")
HOST_RE = re.compile(r"^[A-Za-z0-9._-]{1,255}$")


# ─── Geracao de ZPL (porta fiel de Orquestra_API/services/labelService.js) ──────
def escape_zpl(value):
    s = "" if value is None else str(value)
    s = s.replace("^", " ").replace("~", " ")
    repl = {"Ç": "C", "ç": "c", "Ã": "A", "Õ": "O", "Á": "A", "É": "E",
            "Í": "I", "Ó": "O", "Ú": "U"}
    out = []
    for ch in s:
        o = ord(ch)
        if 0x20 <= o <= 0x7E:
            out.append(ch)
        else:
            out.append(repl.get(ch, ""))
    return "".join(out)


def _set_pixel(bitmap, width, height, x, y):
    if x < 0 or y < 0 or x >= width or y >= height:
        return
    bitmap[y][x // 8] |= 0x80 >> (x % 8)


def _draw_line(bitmap, width, height, start, end):
    x0, y0 = start["x"], start["y"]
    x1, y1 = end["x"], end["y"]
    dx = abs(x1 - x0)
    sx = 1 if x0 < x1 else -1
    dy = -abs(y1 - y0)
    sy = 1 if y0 < y1 else -1
    error = dx + dy
    while True:
        _set_pixel(bitmap, width, height, x0, y0)
        _set_pixel(bitmap, width, height, x0 + 1, y0)
        _set_pixel(bitmap, width, height, x0, y0 + 1)
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * error
        if e2 >= dy:
            error += dy
            x0 += sx
        if e2 <= dx:
            error += dx
            y0 += sy


def _fill_polygon(bitmap, width, height, points):
    for y in range(height):
        inters = []
        n = len(points)
        for i in range(n):
            cur = points[i]
            nxt = points[(i + 1) % n]
            if (cur["y"] <= y < nxt["y"]) or (nxt["y"] <= y < cur["y"]):
                x = cur["x"] + (y - cur["y"]) * (nxt["x"] - cur["x"]) / (nxt["y"] - cur["y"])
                inters.append(x)
        inters.sort()
        for i in range(0, len(inters), 2):
            start = max(0, int(-(-inters[i] // 1)))  # ceil
            end_val = inters[i + 1] if i + 1 < len(inters) else inters[i]
            end = min(width - 1, int(end_val // 1))   # floor
            for x in range(start, end + 1):
                _set_pixel(bitmap, width, height, x, y)


def _build_piece_graphic(item, width, height):
    bounds = item.get("bounds") or {}
    points = item.get("points") or []
    if not points or not bounds.get("width") or not bounds.get("height"):
        return "^A0N,28,28^FB204,1,0,C^FDSEM IMG^FS"

    row_bytes = -(-width // 8)  # ceil(width/8)
    bitmap = [bytearray(row_bytes) for _ in range(height)]
    pad = 14
    scale = min((width - pad * 2) / bounds["width"], (height - pad * 2) / bounds["height"])
    draw_w = bounds["width"] * scale
    draw_h = bounds["height"] * scale
    off_x = (width - draw_w) / 2
    off_y = (height - draw_h) / 2

    pts = [{
        "x": round(off_x + (p["x"] - bounds["minX"]) * scale),
        "y": round(off_y + (p["y"] - bounds["minY"]) * scale),
    } for p in points]

    _fill_polygon(bitmap, width, height, pts)
    for i in range(1, len(pts)):
        _draw_line(bitmap, width, height, pts[i - 1], pts[i])

    total_bytes = row_bytes * height
    hex_str = "".join("{:02X}".format(b) for row in bitmap for b in row)
    return "^GFA,{0},{0},{1},{2}".format(total_bytes, row_bytes, hex_str)


def build_item_zpl(item):
    piece_line = "{0} - {1}".format(item.get("code") or item.get("id"),
                                    item.get("description") or "ITEM")
    order = "OS: {0}".format(item["order"]) if item.get("order") else "OS: NAO INFORMADA"
    project = item.get("product") or item.get("vehicle") or "PROJETO NAO INFORMADO"
    layers = "{0} CAMADAS".format(item["layers"]) if item.get("layers") else "CAMADAS NAO INFORMADAS"
    vehicle = item.get("vehicle") or "VEICULO NAO INFORMADO"

    return "\n".join([
        "^XA",
        "^CI28",
        "^PW812",
        "^LL420",
        "^LH0,0",
        "^FO0,14^A0N,46,46^FB812,1,0,C^FD" + escape_zpl(order) + "^FS",
        "^FO18,86^GB776,310,10^FS",
        "^FO252,86^GB10,310,10^FS",
        "^FO252,158^GB542,10,10^FS",
        "^FO252,230^GB542,10,10^FS",
        "^FO252,302^GB542,10,10^FS",
        "^FO38,98^GB204,286,2^FS",
        "^FO38,98" + _build_piece_graphic(item, 204, 286) + "^FS",
        "^FO284,116^A0N,34,34^FD" + escape_zpl(piece_line)[:34] + "^FS",
        "^FO284,188^A0N,34,34^FD" + escape_zpl(layers)[:34] + "^FS",
        "^FO284,260^A0N,34,34^FD" + escape_zpl(project)[:34] + "^FS",
        "^FO284,332^A0N,34,34^FD" + escape_zpl(vehicle)[:34] + "^FS",
        "^XZ",
    ])


# ─── Impressao crua (copy /b para a impressora compartilhada) ───────────────────
def raw_print(zpl, printer, host):
    if not printer or not PRINTER_RE.match(printer):
        raise ValueError("Nome de compartilhamento invalido.")
    host = host or "localhost"
    if not HOST_RE.match(host):
        raise ValueError("Host invalido.")
    tmp = os.path.join(tempfile.gettempdir(), "orq-" + uuid.uuid4().hex + ".zpl")
    with open(tmp, "wb") as f:
        f.write(zpl.encode("iso-8859-1", errors="replace"))
    try:
        unc = "\\\\{0}\\{1}".format(host, printer)
        # /b = binario; shell=True para usar o builtin `copy` do cmd.
        proc = subprocess.run(
            'copy /b "{0}" "{1}"'.format(tmp, unc),
            shell=True, capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError("copy retornou codigo {0}: {1}".format(
                proc.returncode, (proc.stderr or proc.stdout or "").strip()))
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def list_printers():
    ps = ("Get-Printer | Select-Object Name,ShareName,Shared | "
          "ConvertTo-Json -Compress")
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=15,
        )
        data = json.loads(proc.stdout or "[]")
        if isinstance(data, dict):
            data = [data]
        return [{"name": str(p.get("Name", "")),
                 "shareName": str(p.get("ShareName") or ""),
                 "shared": bool(p.get("Shared"))} for p in data]
    except Exception:
        return []


def resolve_item(key):
    file_name = str(key).split("#")[0]
    item_id = str(key).split("#")[1] if "#" in str(key) else ""
    bucket = LOADED.get(file_name)
    if not bucket:
        return None
    return bucket.get(item_id)


# ─── HTTP ───────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # silencioso

    def _cors(self):
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if self.headers.get("Access-Control-Request-Private-Network"):
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json(200, {
                "ok": True,
                "agent": "orquestra-print-py",
                "platform": "win32",
                "supportsLoad": True,
                "loaded": list(LOADED.keys()),
                "items": sum(len(v) for v in LOADED.values()),
            })
        elif path == "/printers":
            self._send_json(200, {"ok": True, "printers": list_printers()})
        else:
            self._send_json(404, {"ok": False, "error": "rota nao encontrada"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        data = self._read_body()

        if path == "/load":
            file_name = data.get("fileName")
            items = data.get("items") or []
            if not file_name:
                self._send_json(200, {"ok": False, "error": "fileName ausente"})
                return
            LOADED[str(file_name)] = {str(it.get("id")): it for it in items}
            self._send_json(200, {"ok": True, "fileName": file_name,
                                  "count": len(LOADED[str(file_name)])})
            return

        if path == "/print":
            try:
                printer = data.get("printer")
                host = data.get("host")
                zpl = data.get("zpl")
                if not zpl:
                    key = data.get("key")
                    item = resolve_item(key) if key else None
                    if not item:
                        # O front cai p/ o fallback de reenviar o {zpl} ao receber isto.
                        self._send_json(200, {"ok": False, "code": "not_loaded",
                                              "error": "Peca nao carregada no agente."})
                        return
                    zpl = build_item_zpl(item)
                raw_print(zpl, printer, host)
                self._send_json(200, {"ok": True, "printer": printer})
            except Exception as exc:  # noqa: BLE001
                self._send_json(200, {"ok": False, "error": str(exc)})
            return

        self._send_json(404, {"ok": False, "error": "rota nao encontrada"})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("")
    print("  Orquestra - Agente de Impressao (Python)")
    print("  Ouvindo em http://127.0.0.1:%d" % PORT)
    print("  Deixe esta janela aberta. Feche-a (ou Ctrl+C) para parar o agente.")
    print("")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
