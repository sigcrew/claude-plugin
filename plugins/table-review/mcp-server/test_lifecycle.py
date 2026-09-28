#!/usr/bin/env python3
"""Slow check: the server exits when its MCP client goes away. Run: python3 test_lifecycle.py

Starts server.py over real stdio in each state (idle, review waiting, answer_question waiting,
quick-answer child running), then takes the client away:
  stdin  - close stdin, parent stays
  sh     - SIGKILL an intermediate sh parent, stdin stays open (reparented)
  uvkill - real `uv run --directory ... server.py`, SIGKILL uv, stdin stays open
  uvterm - real launch, SIGTERM uv (uv forwards it), stdin stays open
Python must exit, the port close and children die within 5 seconds.
"""
import json, os, signal, socket, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

SRV = Path(__file__).resolve().parent
PY = subprocess.run(["uv", "python", "find", "--script", str(SRV / "server.py")],
                    capture_output=True, text=True).stdout.strip()
TMP = Path(tempfile.mkdtemp())
URLS = TMP / "urls.log"
REC = TMP / "rec.sh"
# Records the URL and makes noise: none of it may reach the MCP stdout.
REC.write_text(f'#!/bin/sh\necho "$1" >> {URLS}\necho NOISE\necho NOISE >&2\n')
REC.chmod(0o755)
FAKE = TMP / "fake_claude.py"
FAKE.write_text("""
import json, sys, time
p = sys.stdin.read()
print(json.dumps({"type": "stream_event", "event": {"delta": {"type": "text_delta", "text": "x"}}}), flush=True)
time.sleep(3600 if "SLOW" in p else 0)
print(json.dumps({"type": "result", "is_error": False, "result": "fast"}), flush=True)
""")


def kids(pid):
    return [int(p) for p in subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()]


def alive(pid):
    st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(st) and not st.startswith("Z")


def listening(port):
    try:
        socket.create_connection(("127.0.0.1", port), 0.5).close()
        return True
    except OSError:
        return False


class Client:
    def __init__(self, mode):
        env = {**os.environ, "BROWSER": "true", "TABLE_REVIEW_BROWSER": str(REC),
               "TABLE_REVIEW_CLAUDE_CMD": f"{sys.executable} {FAKE}"}
        env.pop("TABLE_REVIEW_NO_BROWSER", None)
        argv = {"stdin": [PY, str(SRV / "server.py")],
                "sh": ["sh", "-c", f"'{PY}' '{SRV}/server.py'; echo parent-still-here >&2"]
                }.get(mode, ["uv", "run", "--directory", str(SRV), "server.py"])
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        self.n = 0
        self.req("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "lifecycle", "version": "0"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.py = self.proc.pid if mode == "stdin" else None
        while self.py is None:
            k = kids(self.proc.pid)
            self.py = k[0] if k else time.sleep(0.05)

    def send(self, msg):
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()

    def call(self, name, args):
        self.n += 1
        self.send({"jsonrpc": "2.0", "id": self.n, "method": "tools/call",
                   "params": {"name": name, "arguments": args}})
        return self.n

    def read(self, rid):
        while True:
            msg = json.loads(self.proc.stdout.readline())  # any non-JSON line on stdout fails here
            if msg.get("id") == rid:
                return msg["result"]

    def tool(self, rid):
        return json.loads(self.read(rid)["content"][0]["text"])

    def req(self, method, params):
        self.n += 1
        self.send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        return self.read(self.n)


def api(url, path, body):
    base, token = url.replace("localhost", "127.0.0.1").split("/?token=")
    r = urllib.request.Request(f"{base}/api/{path}", json.dumps(body).encode(), {"X-Review-Token": token})
    return json.loads(urllib.request.urlopen(r, timeout=5).read())


def setup(c, state):
    """Bring the server into `state`; returns the review port, or None when idle."""
    if state == "idle":
        return None
    res = c.tool(c.call("start_review", {"content": "# t\n\nbody", "title": "t"}))
    assert res["status"] == "opened" and res["browser"] == "opened", res
    assert URLS.read_text().split()[-1] == res["url"], "BROWSER=true must not swallow the URL"
    rid = c.call("wait_review", {"context": "ctx"})
    if state == "answer":
        api(res["url"], "question", {"id": "q1", "text": "q", "rows": []})
        api(res["url"], "deepen", {"id": "q1"})
        assert c.tool(rid)["status"] == "question"
        c.call("answer_question", {"answers": [{"question_id": "q1", "answer": "a"}]})
    elif state == "child":
        api(res["url"], "question", {"id": "q2", "text": "SLOW", "rows": []})
    time.sleep(0.5)
    return int(res["url"].split(":")[2].split("/")[0])


def run(state, mode):
    c = Client(mode)
    port = setup(c, state)
    children = kids(c.py)
    assert state != "child" or children, "no quick-answer child"
    t = time.monotonic()
    if mode == "stdin":
        c.proc.stdin.close()
    else:
        os.kill(c.proc.pid, signal.SIGTERM if mode == "uvterm" else signal.SIGKILL)
    gone = lambda: not alive(c.py) and not (port and listening(port)) and not any(map(alive, children))
    while not gone() and time.monotonic() - t < 5:
        time.sleep(0.1)
    ok = gone()
    print(f"{state:7} {mode:7} {'PASS' if ok else 'FAIL'} {time.monotonic() - t:.1f}s"
          f"  python={'alive' if alive(c.py) else 'gone'}"
          f" port={'-' if not port else 'LISTEN' if listening(port) else 'closed'}"
          f" children={[k for k in children if alive(k)]}", flush=True)
    for pid in [c.py, *children, c.proc.pid]:  # clean up only what this test started
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    c.proc.wait()
    return ok


def special_files():
    """A FIFO or /dev/zero as file_path errors at once; the server keeps answering."""
    fifo = TMP / "fifo.md"
    os.mkfifo(fifo)
    c = Client("stdin")
    ok = True
    for path in (str(fifo), "/dev/zero"):
        t = time.monotonic()
        res = c.tool(c.call("start_review", {"file_path": path}))
        n = len(c.req("tools/list", {})["tools"])
        secs = time.monotonic() - t
        good = res["status"] == "error" and n == 3 and secs < 1
        ok &= good
        print(f"special {path.split('/')[-1]:8} {'PASS' if good else 'FAIL'} {secs:.2f}s  {res.get('message')}", flush=True)
    c.proc.stdin.close()
    c.proc.wait(5)
    return ok


if __name__ == "__main__":
    results = [special_files()] + [run(s, m) for s in ("idle", "review", "answer", "child")
               for m in ("stdin", "sh", "uvkill", "uvterm")]
    print(f"{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)
