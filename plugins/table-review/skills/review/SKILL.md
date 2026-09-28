---
name: review
description: |
  Open a browser review UI for a plan or markdown document, where the user clicks table rows (or selects text) to leave comments, ask questions that get answered live, or request changes. Use whenever the user wants to review, check, or give feedback on something you wrote or on a file: "review this", "check this plan", "let me review", "/review", "리뷰", "검토해줘", "피드백 줄게", "이 파일 리뷰해줘: path/to/file.md". Prefer this over asking for feedback in the terminal when the content is longer than a few lines, because the user can point at the exact row they mean.
allowed-tools:
  - mcp__plugin_table-review_table_review__start_review
  - mcp__plugin_table-review_table_review__wait_review
  - mcp__plugin_table-review_table_review__answer_question
  - Read
  - Agent
---

# Table Review

Opens a local web page showing the content as a table, one block (heading, paragraph, list item, code block, table row) per row. The user selects rows or text and does one of three things:

| Type | Meaning | When you see it |
|------|---------|-----------------|
| `comment` | Feedback or a note | On submit, in `items` |
| `action` | A change the user wants made | On submit, in `items` |
| question | Something the user wants to understand before commenting | Usually never, see below |

Questions are a reading aid, not review output. The user asks, reads the answer in the page, and then writes a comment or change request based on it.

The page answers questions by itself within a few seconds, using a separate quick model call that sees only the document and the `context` you pass. You are involved only when the user presses `깊이 조사` (deep investigation) because the quick answer was not enough.

## 1. Open the page first

The user is waiting for a browser tab, so get it open before doing anything slow. Everything you write into a tool call is generated token by token: passing an 11,000 character document as `content` together with a long background summary once took two minutes before the page appeared.

Pick the source in this order:

1. **A file on disk**: pass its absolute path as `file_path`. The server reads the file itself, so the page opens in seconds however long the document is. This covers a file the user named and also a plan or document you already saved to a file earlier in the conversation.
2. **Text that exists only in the conversation**: pass it as `content`, unchanged. The UI builds its rows from the markdown structure, so summarizing or reformatting would make row numbers meaningless to the user.

Call `start_review` with the source and a short descriptive `title`. It returns immediately:

```json
{"status": "opened", "url": "http://localhost:57232/?token=...", "browser": "opened"}
```

Tell the user in one or two lines that the page is open, and include the `url` exactly as returned. The browser does not always come to the front, and the token in the URL is required, so an address without it shows an error. If `browser` is `failed` or `skipped`, say the page did not open by itself and that they need to open the link.

`undelivered_result` means the user finished an earlier review whose result was never collected. The result is in `result`. Handle it as in step 4 first, tell the user you did, and then call `start_review` again for the new review. Skipping it would silently drop a review the user already wrote.

`already_open` means a review is still in progress. Give the user that `url` and continue with `wait_review`. Opening a new review closes the page they may be working in, so pass `replace: true` only when the user asks for a fresh review.

## 2. Write the context

`context` is everything the quick answerer knows beyond the document. It has no access to this conversation or to the codebase, so a question like "왜 이 방식인가요?" can only be answered well if the reason is in `context`. A thin context produces vague answers and sends the user to the slow path.

Write what a reviewer is likely to ask about and the document does not say:

- why each significant choice was made, and which alternatives were rejected and why
- constraints and requirements the user gave in this conversation
- relevant facts about the codebase or environment that you found (file names, existing patterns, versions)
- known risks, open questions, and assumptions

Aim for the facts a reviewer would ask about, in compact bullets. The page is already open while you write this, and a question asked before the context arrives is held for it, so length here costs the user waiting time on their first question. If you have no background (for example, the user asked you to open a file you know nothing about), say exactly that so the answerer does not invent reasons.

## 3. Run the review loop

Pass the context in the first `wait_review` call. The call blocks until something happens in the browser, then returns a `status`. Keep going until the status is final:

```
opened = start_review(file_path or content, title)     # returns at once
tell the user the page is open, with opened.url
result = wait_review(context)
while result.status == "question":
    answers = investigate each question in result.questions   (see below)
    result = answer_question(answers)      # delivers answers, then blocks again
# result.status is now "submitted", "cancelled", "timeout" or "error"
```

`answer_question` both delivers the answers and resumes waiting, so always call it after a `question` result. If you stop without calling it, the user is left staring at a spinner in a page that will never update.

A review usually takes longer than two minutes, and the client then moves the waiting call to the background and tells you so. That is the normal case, not a failure. The page is still open and the result arrives as a notification when the user submits. Tell the user you are waiting and end your turn. Do not call `start_review` again, and do not go looking for the server's port or process. If a waiting call was interrupted, call `wait_review` again to pick the review back up; nothing the user did in the page is lost. A result with status `superseded` belongs to an older waiting call that a newer one replaced. Ignore it and keep waiting on the newer call.

### Deep investigation

A `question` result means the user wants more than the quick answer gave. Each question looks like:

```json
{"id": "item-2", "text": "왜 Redis가 아니라 Postgres인가요?",
 "rows": [{"index": 4, "blockType": "LI", "text": "세션 저장소를 Postgres로 교체", "startLine": 12, "endLine": 12}],
 "selectedText": "",
 "quick_answer": "문서에 따르면 운영 중인 Redis 클러스터가 없기 때문입니다...",
 "reason": "requested"}
```

`reason` is `requested` when the user pressed the button, and `quick_failed` when the quick call could not run and the question came to you instead. In that case `quick_answer` is empty.

Investigate with a subagent (`Agent` tool) rather than inline. The user is waiting in the browser, and a subagent keeps file reads and searches out of this conversation's context. When several questions arrive together, spawn their subagents in one message so they run in parallel.

Give the subagent what it cannot know on its own:

- the question text and the rows or selected text it refers to
- the full reviewed document
- the reasoning from this conversation that led to that part of the document
- the `quick_answer` the user already read, with the instruction to go beyond it: check the claims against the actual code or sources, correct anything it got wrong, and add what it could not know. Repeating it in other words wastes the user's wait
- an instruction to reply in the language of the question, in a few short paragraphs of markdown, because the answer is shown in a narrow card

Then call `answer_question` with `[{ "question_id": <id>, "answer": <markdown> }, ...]`. If a subagent fails, still send an answer for that question saying what went wrong, so its card stops waiting.

## 4. Handle the final result

| status | What to do |
|--------|------------|
| `submitted` | Process the result as described below |
| `cancelled` | Say the review was cancelled and change nothing |
| `timeout` / `error` | Report the message and offer to reopen the review |

Once the status is final the page is closed and its address stops working.

A submitted result has two lists:

```json
{"status": "submitted",
 "items": [{"id": "item-5", "type": "action", "rows": [...], "selectedText": "", "text": "Postgres 대신 Redis로 바꿔주세요"}],
 "questions": [{"id": "item-2", "text": "왜 Redis가 아니라 Postgres인가요?", "rows": [...], "selectedText": "",
                "answer": "...", "answer_source": "quick"}],
 "summary": {"comments": 0, "actions": 1, "questions": 1, "unanswered_questions": 0},
 "file_path": "/abs/path/plan.md"}
```

`file_path` is present when the review was opened from a file. Row `startLine` and `endLine` refer to that file, so read those lines before editing rather than searching for the text.

`items` is what the user wants done:

- **`action`**: the user asked for this change. Apply it to the document or plan (edit the file if the content came from one), using `rows` to locate the spot.
- **`comment`**: feedback to take into account. Revise when the comment implies a change. A comment that only acknowledges or approves needs no change.

`questions` is background, not a to-do list:

- Use it to understand the items. A comment on the same rows as a question was most likely written after reading that answer, so read them together: "그럼 Redis로" only makes sense next to the question about Redis.
- Do not repeat answers the user already read, and do not change the document because of a question alone.
- Read the answers with `answer_source: "quick"` critically. They were written without this conversation or the codebase. If one told the user something wrong and an item depends on it, say so before acting on that item, since the user decided on bad information.
- A question **without** `answer` means the user submitted before any answer arrived. Answer it in your reply.

Then report briefly:

```
## 리뷰 결과

**수정 요청** N건 · **코멘트** N건

### 반영한 내용
- Row 4: <what changed>

### 확인이 필요한 내용
- Row 9: <comment you could not act on, and why>
```

Write the report in the user's language. If no items were submitted, the user approved the content as is, so say so and continue with the work the review was gating.
