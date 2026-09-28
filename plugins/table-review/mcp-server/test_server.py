#!/usr/bin/env python3
# /// script
# dependencies = ["mcp>=1.0.0,<2"]
# ///
"""Runnable check against the real HTTP server and a fake claude CLI: uv run test_server.py"""

import asyncio
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
FAKE = TMP / "fake_claude.py"
LOG = TMP / "calls.jsonl"
# Streams three deltas; @@FAIL@@ exits non-zero, @@SLOW@@ hangs after one delta.
FAKE.write_text(f"""
import json, os, sys, time
prompt = sys.stdin.read()
with open({str(LOG)!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "cwd": os.getcwd(), "prompt": prompt}}) + "\\n")
def out(ev):
    print(json.dumps(ev), flush=True)
def delta(t):
    out({{"type": "stream_event", "event": {{"type": "content_block_delta", "delta": {{"type": "text_delta", "text": t}}}}}})
out({{"type": "system", "subtype": "init"}})
if "@@FAIL@@" in prompt:
    sys.exit(3)
for part in ["빠른 ", "답변 ", "입니다."]:
    delta(part)
    time.sleep(3600 if "@@SLOW@@" in prompt else 0.4)
out({{"type": "result", "subtype": "success", "is_error": False, "result": "빠른 답변 입니다."}})
""")
os.environ["TABLE_REVIEW_NO_BROWSER"] = "1"
os.environ["TABLE_REVIEW_CLAUDE_CMD"] = f"{sys.executable} {FAKE}"
import server  # noqa: E402

DOC = "# 계획\n\n- 1단계: 준비\n- 2단계: 배포"
CONTEXT = "SECRET-CONTEXT-7f3a: 금요일 배포는 피하기로 결정함"
ROW = {"index": 2, "blockType": "LI", "text": "1단계: 준비", "startLine": 3, "endLine": 3}
REC = TMP / "rec.sh"
URLS = TMP / "urls.log"
REC.write_text(f'#!/bin/sh\necho "$1" >> {URLS}\n')
REC.chmod(0o755)
base = ""  # http://127.0.0.1:PORT of the review under test


def http(path, body=None, token=None, raw=False):
    req = urllib.request.Request(
        f"{base}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"X-Review-Token": token} if token else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            data = res.read()
            return res.status, data.decode() if raw else json.loads(data)
    except urllib.error.HTTPError as e:
        return e.code, None


async def call(path, body=None, token=None, raw=False):
    return await asyncio.to_thread(http, path, body, token, raw)


async def refused(path="/"):
    """The page stops working: the listening socket closes within a moment of the response."""
    for _ in range(10):
        try:
            await call(path)
        except urllib.error.URLError as e:
            if isinstance(e.reason, ConnectionRefusedError):
                return True
        except ConnectionError:
            pass
        await asyncio.sleep(0.1)
    return False


async def start(**kw):
    """start_review; returns (result, token) and points base at the new page."""
    global base
    res = await server.start_review_impl(**kw)
    assert res["status"] == "opened", res
    base, token = res["url"].replace("localhost", "127.0.0.1").split("/?token=")
    return res, token


async def answers(token):
    return (await call("/api/answers", token=token))[1]["answers"]


async def until(token, qid, pred, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        a = (await answers(token)).get(qid)
        if a and pred(a):
            return a
        await asyncio.sleep(0.05)
    raise AssertionError(f"timed out waiting on {qid}: {await answers(token)}")


async def still_blocked(task, secs=0.5):
    done, _ = await asyncio.wait({task}, timeout=secs)
    return not done


def question(qid, text, rows=(ROW,)):
    return {"id": qid, "text": text, "rows": list(rows), "selectedText": ""}


def calls():
    return [json.loads(line) for line in LOG.read_text().splitlines()] if LOG.exists() else []


async def main():
    res, token = await start(content=DOC, title="T")
    assert res == {"status": "opened", "url": res["url"], "browser": "skipped", "next": server.OPENED_NEXT}, res
    session = server._session
    wait = asyncio.create_task(server.wait_review_impl(CONTEXT))

    # auth, and context never leaves the server over HTTP
    assert (await call("/api/review"))[0] == 403
    assert (await call("/api/deepen", {"id": "x"}))[0] == 403
    assert await call("/api/review", token=token) == (200, {"title": "T", "content": DOC, "file": ""})
    assert (await call("/api/deepen", {"id": "nope"}, token))[0] == 404

    # a second start_review leaves the open review alone
    again = await server.start_review_impl(content="other")
    assert (again["status"], again["url"], again["title"]) == ("already_open", res["url"], "T"), again
    assert server._session is session and await still_blocked(wait)

    # quick answer streams without waking the blocked tool
    await call("/api/question", question("q1", "왜 1단계가 먼저인가요?"), token)
    a = await until(token, "q1", lambda a: a["quick"]["text"] and not a["quick"]["done"])
    assert a["quick"]["text"] in ("빠른 ", "빠른 답변 "), a
    a = await until(token, "q1", lambda a: a["quick"]["done"])
    assert a == {"quick": {"text": "빠른 답변 입니다.", "done": True, "failed": False, "held": False},
                 "deep": {"state": "none", "text": ""}}, a
    assert await still_blocked(wait)

    call1 = calls()[0]
    assert call1["argv"][:3] == ["--model", "sonnet", "-p"] and ["--tools", ""] == call1["argv"][6:8], call1["argv"]
    assert CONTEXT in call1["prompt"] and "왜 1단계가 먼저인가요?" in call1["prompt"] and DOC in call1["prompt"]
    assert "Row 2 (LI, lines 3-3): 1단계: 준비" in call1["prompt"]
    assert Path(call1["cwd"]).resolve() != Path.cwd().resolve()

    # deepen wakes the tool with the quick answer and reason
    assert await call("/api/deepen", {"id": "q1"}, token) == (200, {"status": "ok"})
    res = await asyncio.wait_for(wait, 5)
    assert res["status"] == "question", res
    assert res["questions"] == [{**question("q1", "왜 1단계가 먼저인가요?"), "reason": "requested",
                                 "quick_answer": "빠른 답변 입니다."}], res
    assert (await answers(token))["q1"]["deep"]["state"] == "pending"

    # deep answer is stored; quick failure escalates by itself
    wait = asyncio.create_task(server.answer_question_impl([{"question_id": "q1", "answer": "**깊은** 답"}]))
    assert (await answers(token))["q1"]["deep"] == {"state": "done", "text": "**깊은** 답"}
    await call("/api/question", question("q2", "@@FAIL@@ 이건?"), token)
    res = await asyncio.wait_for(wait, 5)
    q2 = res["questions"][0]
    assert (q2["id"], q2["reason"], q2["quick_answer"]) == ("q2", "quick_failed", ""), res
    assert "code 3" in q2["quick_error"], q2
    a = await answers(token)
    assert a["q2"]["quick"]["failed"] and a["q2"]["deep"]["state"] == "pending", a

    # timeout kills the child and escalates
    os.environ["TABLE_REVIEW_QUICK_TIMEOUT"] = "1"
    wait = asyncio.create_task(server.answer_question_impl([]))
    await call("/api/question", question("q3", "@@SLOW@@ 느린 질문"), token)
    res = await asyncio.wait_for(wait, 5)
    assert res["questions"][0]["quick_error"] == "quick answer timed out", res
    assert session.questions["q3"]["proc"].poll() is not None
    os.environ["TABLE_REVIEW_QUICK_TIMEOUT"] = "60"

    # stop (card deleted while streaming) kills the child without escalating
    wait = asyncio.create_task(server.wait_review_impl())
    await call("/api/question", question("q4", "@@SLOW@@ 지울 질문"), token)
    await until(token, "q4", lambda a: a["quick"]["text"])
    assert await call("/api/stop", {"id": "q4"}, token) == (200, {"status": "ok"})
    await asyncio.sleep(0.3)
    assert session.questions["q4"]["proc"].poll() is not None
    assert await still_blocked(wait)
    assert session.context == CONTEXT, "a wait_review without context keeps the stored one"

    # cancelled waits (Esc, background task stopped) keep the review and free their threads
    threads = threading.active_count()
    for _ in range(20):
        wait.cancel()
        await asyncio.gather(wait, return_exceptions=True)
        wait = asyncio.create_task(server.wait_review_impl())
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.2)
    assert threading.active_count() <= threads + 1, (threads, threading.active_count())
    assert server._session is session and not session.closed
    # two live waits: the older one steps aside, the event goes to the newer one only
    newer = asyncio.create_task(server.wait_review_impl())
    assert (await asyncio.wait_for(wait, 5))["status"] == "superseded"
    await call("/api/question", question("q6", "@@FAIL@@ 둘 중 하나만"), token)
    res = await asyncio.wait_for(newer, 5)
    assert [q["id"] for q in res["questions"]] == ["q6"], res
    wait = asyncio.create_task(server.answer_question_impl([]))

    # a completed quick answer
    await call("/api/question", question("q5", "배포는 언제?", rows=()), token)
    await until(token, "q5", lambda a: a["quick"]["done"])

    for path in ("/", "/app.js", "/api/review", "/api/answers"):
        assert CONTEXT not in (await call(path, token=token, raw=True))[1], path

    # submit: server answers win; unanswered = neither deep nor completed quick
    sent = [
        {**question("q1", "왜 1단계가 먼저인가요?"), "answer": "client says"},
        {**question("q2", "@@FAIL@@ 이건?"), "answer": "client says", "answer_source": "quick"},
        question("q5", "배포는 언제?", rows=()),
    ]
    items = [{"id": "c1", "type": "comment", "rows": [ROW], "selectedText": "", "text": "좋음"}]
    assert (await call("/api/submit", {"status": "submitted", "questions": "x"}, token))[0] == 400
    await call("/api/submit", {"status": "submitted", "items": items, "questions": sent}, token)
    assert await refused(), "page still served after submit"
    res = await asyncio.wait_for(wait, 5)
    assert res["status"] == "submitted" and res["items"] == items and "file_path" not in res, res
    got = {q["id"]: (q.get("answer"), q.get("answer_source")) for q in res["questions"]}
    assert got == {"q1": ("**깊은** 답", "deep"), "q2": (None, None), "q5": ("빠른 답변 입니다.", "quick")}, got
    assert res["summary"] == {"comments": 1, "actions": 0, "questions": 3, "unanswered_questions": 1}, res
    assert (await server.answer_question_impl([]))["status"] == "error"
    assert (await server.wait_review_impl())["status"] == "error"

    # submit while nobody waits: the URL closes at once, children die, the next wait gets the result
    _, token = await start(content="x")
    session = server._session
    session.context = ""  # as if a wait_review had come and gone
    await call("/api/question", question("s1", "@@SLOW@@ 종료"), token)
    await until(token, "s1", lambda a: a["quick"]["text"])
    proc = session.questions["s1"]["proc"]
    await call("/api/submit", {"status": "submitted", "items": []}, token)
    assert await refused("/api/review")
    await asyncio.sleep(0.3)
    assert proc.poll() is not None, "child still running after shutdown"
    res = await asyncio.wait_for(server.wait_review_impl(), 1)
    assert res["summary"] == {"comments": 0, "actions": 0, "questions": 0, "unanswered_questions": 0}, res

    # cancel: same
    _, token = await start(content="x")
    await call("/api/submit", {"status": "cancelled", "items": []}, token)
    assert await refused()
    assert (await server.wait_review_impl())["status"] == "cancelled"
    assert (await server.start_review_impl(content="y"))["status"] == "opened", "a taken result is not returned again"
    assert (await server.start_review_impl(content="z", replace=True))["status"] == "opened"
    old = server._session
    server._session.shutdown()
    assert (await server.wait_review_impl())["status"] == "error" and server._session is None
    assert old.closed

    # TABLE_REVIEW_TIMEOUT closes the review
    os.environ["TABLE_REVIEW_TIMEOUT"] = "0.3"
    await start(content="x")
    assert (await server.wait_review_impl())["status"] == "timeout"
    assert await refused()
    del os.environ["TABLE_REVIEW_TIMEOUT"]

    await undelivered()
    await context_hold()
    await file_path()
    await browser()
    print("OK")


async def undelivered():
    """A result nobody collected is handed over by the next start_review, never dropped."""
    f = TMP / "undelivered.md"
    f.write_text("# 문서\n\n본문\n")
    for status in ("submitted", "cancelled"):
        _, token = await start(file_path=str(f))
        items = [{"id": "c1", "type": "comment", "rows": [], "selectedText": "x", "text": "메모"}]
        await call("/api/submit", {"status": status, "items": items, "questions": []}, token)
        res = await server.start_review_impl(content="다음 문서", replace=True)
        assert res["status"] == "undelivered_result" and res["next"] == server.UNDELIVERED_NEXT, res
        expected = ({"status": "cancelled"} if status == "cancelled" else
                    {"status": "submitted", "items": items, "questions": [], "file_path": str(f),
                     "summary": {"comments": 1, "actions": 0, "questions": 0, "unanswered_questions": 0}})
        assert res["result"] == expected, res
        assert (await server.wait_review_impl())["status"] == "error", "delivered once only"
        res, _ = await start(content="다음 문서")
        server._session.shutdown()
    # a waiter blocked when start_review collects the result does not get it a second time
    _, token = await start(content="x")
    wait = asyncio.create_task(server.wait_review_impl())
    await asyncio.sleep(0.1)
    server._session.result = {"status": "cancelled", "items": [], "questions": []}  # arrives, loop not yet run
    assert (await server.start_review_impl(content="y"))["status"] == "undelivered_result"
    late = await asyncio.wait_for(wait, 2)
    assert late["status"] == "error", late


async def context_hold():
    # a question before any wait_review waits for context, shown as held
    n = len(calls())
    _, token = await start(content=DOC)
    await call("/api/question", question("h1", "배경이 필요한 질문"), token)
    a = await until(token, "h1", lambda a: a["quick"]["held"])
    assert not a["quick"]["text"] and len(calls()) == n
    wait = asyncio.create_task(server.wait_review_impl(CONTEXT))
    await until(token, "h1", lambda a: a["quick"]["done"])
    assert CONTEXT in calls()[-1]["prompt"]
    # an empty context counts as supplied
    _, token = await start(content=DOC, replace=True)
    await asyncio.wait_for(wait, 1)
    wait = asyncio.create_task(server.wait_review_impl(""))
    await call("/api/question", question("h2", "빈 배경"), token)
    await until(token, "h2", lambda a: a["quick"]["done"], timeout=3)
    wait.cancel()
    # no wait_review at all: answer without context after TABLE_REVIEW_CONTEXT_WAIT
    os.environ["TABLE_REVIEW_CONTEXT_WAIT"] = "0.5"
    _, token = await start(content=DOC, replace=True)
    await call("/api/question", question("h3", "배경 없이"), token)
    await until(token, "h3", lambda a: a["quick"]["done"], timeout=3)
    assert "<context>\n(none)\n</context>" in calls()[-1]["prompt"]
    del os.environ["TABLE_REVIEW_CONTEXT_WAIT"]
    server._session.shutdown()


async def file_path():
    d = TMP / "files"
    d.mkdir()
    ok = d / "plan.md"
    ok.write_bytes("﻿# 계획\r\n\r\n- 1단계\r\n- 2단계\r\n".encode())
    bad = {
        "rel/plan.md": "absolute path",
        str(d / "missing.md"): "not found",
        str(d): "directory",
        str(d / "latin1.md"): "not UTF-8",
        str(d / "empty.md"): "empty",
        str(d / "big.md"): "larger than 2 MB",
        str(d / "locked.md"): "cannot read",
        str(d / "fifo.md"): "not a regular file",  # open() would block forever
        str(d / "fifo-link.md"): "not a regular file",
        "/dev/zero": "not a regular file",  # st_size 0, read never ends
    }
    os.mkfifo(d / "fifo.md")
    (d / "fifo-link.md").symlink_to(d / "fifo.md")
    (d / "plan-link.md").symlink_to(ok)
    (d / "latin1.md").write_bytes("caf\xe9".encode("latin-1"))
    (d / "empty.md").write_text(" \n")
    (d / "big.md").write_text("x" * (2 * 1024 * 1024 + 1))
    (d / "locked.md").write_text("secret")
    (d / "locked.md").chmod(0)
    before = server._session
    for path, msg in bad.items():
        res = await asyncio.wait_for(server.start_review_impl(file_path=path), 1)
        assert res["status"] == "error" and msg in res["message"] and "Traceback" not in res["message"], res
    assert server._session is before, "a failed start_review must not start a session"
    for kw in ({}, {"content": "x", "file_path": str(ok)}):
        assert (await server.start_review_impl(**kw))["status"] == "error", kw

    res, token = await start(file_path=str(ok))
    assert res["file_path"] == str(ok) and res["next"] == server.OPENED_NEXT, res
    status, review = await call("/api/review", token=token)
    assert review == {"title": "plan.md", "content": "# 계획\r\n\r\n- 1단계\r\n- 2단계\r\n", "file": "plan.md"}, review
    await call("/api/submit", {"status": "submitted", "items": [], "questions": []}, token)
    res = await server.wait_review_impl()
    assert res["file_path"] == str(ok), res
    res, _ = await start(file_path=str(d / "plan-link.md"))
    assert server._session.content.startswith("# 계획") and server._session.title == "plan-link.md", res
    server._session.shutdown()
    res, _ = await start(file_path=str(ok), title="내 계획")
    assert server._session.title == "내 계획"
    server._session.shutdown()


async def browser():
    os.environ.pop("TABLE_REVIEW_NO_BROWSER")
    os.environ["BROWSER"] = "true"  # webbrowser.open() would "succeed" and open nothing
    os.environ["TABLE_REVIEW_BROWSER"] = str(REC)
    res, _ = await start(content="x")
    assert res["browser"] == "opened" and URLS.read_text().split() == [res["url"]], (res, URLS.read_text())
    server._session.shutdown()
    for cmd in ("false", str(TMP / "no-such-opener")):
        os.environ["TABLE_REVIEW_BROWSER"] = cmd
        res, _ = await start(content="x", replace=True)
        assert res["browser"] == "failed", (cmd, res)
    os.environ["TABLE_REVIEW_BROWSER"] = f"{sys.executable} -c 'import time; time.sleep(30)'"
    t = time.monotonic()
    res, _ = await start(content="x", replace=True)
    assert res["browser"] == "opened" and time.monotonic() - t < 3, res
    server._session.shutdown()
    # the default is the platform opener, never $BROWSER
    del os.environ["TABLE_REVIEW_BROWSER"]
    cmd = server.browser_command("http://u")
    expected = {"darwin": ["open", "http://u"], "win32": ["cmd", "/c", "start", "", "http://u"]}.get(
        sys.platform, ["xdg-open", "http://u"])
    assert cmd in (expected, None) and (cmd is not None or sys.platform not in ("darwin", "win32")), cmd
    os.environ["TABLE_REVIEW_NO_BROWSER"] = "1"


if __name__ == "__main__":
    asyncio.run(main())
