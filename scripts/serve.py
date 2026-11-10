"""仅监听本机：web 为页面根目录，assets 与 docs 为共享只读资源路径。"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = PROJECT_ROOT / 'web'

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        public_path = urlsplit(path).path
        # Both / and /web/ open the same workbench without moving source assets.
        if public_path == '/web':
            public_path = '/'
        elif public_path.startswith('/web/'):
            public_path = public_path[len('/web'):]
        directory = WEB_ROOT
        for mount in ('assets', 'docs'):
            prefix = '/' + mount
            if public_path == prefix or public_path.startswith(prefix + '/'):
                directory = PROJECT_ROOT / mount
                public_path = public_path[len(prefix):] or '/'
                break
        previous = self.directory
        self.directory = str(directory)
        try:
            return super().translate_path(public_path)
        finally:
            self.directory = previous

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8790)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(WEB_ROOT)))
    print(f'小白 3D: http://127.0.0.1:{server.server_port}/', flush=True)
    server.serve_forever()
