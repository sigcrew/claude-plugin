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


def http(path, body=None, token=None, raw=False):
    req = urllib.request.Request(
        f"http://127.0.0.1:{server._session.port}{path}",
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


async def started(prev=None):
    while server._session is None or server._session is prev:
        await asyncio.sleep(0.01)
    return server._session.token


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


async def main():
    wait = asyncio.create_task(server.start_review_impl(DOC, "T", CONTEXT))
    token = await started()
    session = server._session

    # auth, and context never leaves the server over HTTP
    assert (await call("/api/review"))[0] == 403
    assert (await call("/api/deepen", {"id": "x"}))[0] == 403
    assert await call("/api/review", token=token) == (200, {"title": "T", "content": DOC})
    assert (await call("/api/deepen", {"id": "nope"}, token))[0] == 404

    # quick answer streams without waking the blocked tool
    await call("/api/question", question("q1", "왜 1단계가 먼저인가요?"), token)
    a = await until(token, "q1", lambda a: a["quick"]["text"] and not a["quick"]["done"])
    assert a["quick"]["text"] in ("빠른 ", "빠른 답변 "), a
    a = await until(token, "q1", lambda a: a["quick"]["done"])
    assert a == {"quick": {"text": "빠른 답변 입니다.", "done": True, "failed": False},
                 "deep": {"state": "none", "text": ""}}, a
    assert await still_blocked(wait)

    call1 = json.loads(LOG.read_text().splitlines()[0])
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
    wait = asyncio.create_task(server.answer_question_impl([]))
    await call("/api/question", question("q4", "@@SLOW@@ 지울 질문"), token)
    await until(token, "q4", lambda a: a["quick"]["text"])
    assert await call("/api/stop", {"id": "q4"}, token) == (200, {"status": "ok"})
    await asyncio.sleep(0.3)
    assert session.questions["q4"]["proc"].poll() is not None
    assert await still_blocked(wait)

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
    res = await asyncio.wait_for(wait, 5)
    assert res["status"] == "submitted" and res["items"] == items, res
    got = {q["id"]: (q.get("answer"), q.get("answer_source")) for q in res["questions"]}
    assert got == {"q1": ("**깊은** 답", "deep"), "q2": (None, None), "q5": ("빠른 답변 입니다.", "quick")}, got
    assert res["summary"] == {"comments": 1, "actions": 0, "questions": 3, "unanswered_questions": 1}, res
    assert (await server.answer_question_impl([]))["status"] == "error"

    # shutdown kills running children; missing "questions" key accepted
    wait = asyncio.create_task(server.start_review_impl("x"))
    token = await started(session)
    session = server._session
    await call("/api/question", question("s1", "@@SLOW@@ 종료"), token)
    await until(token, "s1", lambda a: a["quick"]["text"])
    proc = session.questions["s1"]["proc"]
    await call("/api/submit", {"status": "submitted", "items": []}, token)
    res = await asyncio.wait_for(wait, 5)
    assert res["summary"] == {"comments": 0, "actions": 0, "questions": 0, "unanswered_questions": 0}, res
    await asyncio.sleep(0.3)
    assert proc.poll() is not None, "child still running after shutdown"
    print("OK")


if __name__ == "__main__":
    asyncio.run(main())
