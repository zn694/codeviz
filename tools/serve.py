# serve.py —— CodeViz 启动器
# 双击：起本地静态服务（www 目录）+ 自动开浏览器
# 额外提供 POST /api/index：收 {dir} → 调 index.exe 索引 → 返回 index.json 内容
import http.server
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import webbrowser

PORT = 5174
WWW = ''


def resource_base():
    return sys._MEIPASS if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))


def index_exe_path():
    cands = [
        # frozen：与 exe 同目录（桌面版布局）
        os.path.join(os.path.dirname(resource_base()), 'index.exe'),
        # dev：tools/ 同级 build-tools/exe/
        os.path.join(resource_base(), '..', 'build-tools', 'exe', 'index.exe'),
    ]
    for c in cands:
        if os.path.isfile(os.path.abspath(c)):
            return os.path.abspath(c)
    return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WWW, **kw)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != '/api/index':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b'{}')
            dirpath = body.get('dir', '')
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, 'bad request')
            return
        if not dirpath or not os.path.isdir(dirpath):
            self.send_response(400)
            self._cors()
            self.end_headers()
            self.wfile.write('{"error":"目录不存在"}'.encode('utf-8'))
            return
        exe = index_exe_path()
        if not exe:
            self.send_response(500)
            self._cors()
            self.end_headers()
            self.wfile.write('{"error":"未找到 index.exe（需与 CodeViz.exe 同目录）"}'.encode('utf-8'))
            return
        fd, out = tempfile.mkstemp(suffix='.json')
        os.close(fd)
        try:
            proc = subprocess.run([exe, dirpath, out],
                                  capture_output=True, timeout=600,
                                  creationflags=subprocess.CREATE_NO_WINDOW)
            if proc.returncode != 0:
                msg = (proc.stderr or proc.stdout or b'index failed').decode('utf-8', 'replace')[:300]
                self.send_response(500)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({'error': msg}, ensure_ascii=False).encode('utf-8'))
                return
            with open(out, encoding='utf-8') as f:
                data = f.read()
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(data.encode('utf-8'))
        except subprocess.TimeoutExpired:
            self.send_response(500)
            self._cors()
            self.end_headers()
            self.wfile.write('{"error":"索引超时（>10 分钟）"}'.encode('utf-8'))
        finally:
            if os.path.exists(out):
                os.unlink(out)

    def log_message(self, *a):
        pass


def main():
    global WWW
    # noconsole 打包时 stdout/stderr 为 None：HTTP 日志写入会崩
    if sys.stdout is None:
        sys.stdout = open(os.devnull, 'w')
    if sys.stderr is None:
        sys.stderr = open(os.devnull, 'w')
    WWW = os.path.join(resource_base(), 'www')
    with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
        url = f'http://localhost:{PORT}/'
        threading.Timer(1.0, webbrowser.open, [url]).start()
        httpd.serve_forever()


if __name__ == '__main__':
    main()
