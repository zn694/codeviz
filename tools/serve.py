# serve.py —— CodeViz 启动器
# 打包后双击：起本地静态服务（www 目录）→ 自动打开浏览器 → 关闭窗口即退出
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

PORT = 5174


def resource_base():
    # PyInstaller onefile：数据解包在临时目录 _MEIPASS
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def log(msg):
    # noconsole 打包时 sys.stdout 为 None，print 会崩
    if sys.stdout:
        try:
            print(msg)
        except OSError:
            pass


def main():
    # noconsole 打包时 stdout/stderr 为 None：HTTP 日志写入会崩（表现为连接被关闭）
    if sys.stdout is None:
        sys.stdout = open(os.devnull, 'w')
    if sys.stderr is None:
        sys.stderr = open(os.devnull, 'w')
    www = os.path.join(resource_base(), 'www')
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(
        *a, directory=www, **kw)
    with socketserver.TCPServer(('127.0.0.1', PORT), handler) as httpd:
        url = f'http://localhost:{PORT}/'
        threading.Timer(1.0, webbrowser.open, [url]).start()
        log(f'CodeViz 运行中：{url}（关闭本窗口即退出）')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
