# table-review

Table-first interactive markdown review for Claude Code. Based on
[interactive-review](https://github.com/team-attention/agents) by Team Attention (MIT).

## Install

```bash
/plugin marketplace add sigcrew/claude-plugin
/plugin install table-review@sigcrew
```

Requires [uv](https://docs.astral.sh/uv/). Quick answers also need the `claude` CLI on `PATH`, which is already the case when you run Claude Code from a terminal.

## Use

Say "review this", "검토해줘", or run `/table-review:review <file>`. A browser tab opens and Claude also prints the page address, in case the tab did not come to the front.

A file on disk opens in seconds, because the server reads it directly. Text that exists only in the conversation takes longer, since Claude has to write it out again: about a minute for 10,000 characters.

| Do this | To |
|---------|----|
| Click a row | Select it |
| Cmd/Ctrl+click | Add or remove a row from the selection |
| Shift+click | Select a range |
| `1` | Comment on the selection |
| `2` | Ask a question, answered in the card within seconds |
| `3` | Request a change |
| Enter / Shift+Enter | Save the card / new line |
| Esc | Clear the selection or discard the card being edited |
| Cmd/Ctrl+Enter | Submit the review |

The three actions appear as an overlay above the last row you selected.

The sidebar has two areas. Questions and their answers sit on top, comments and change requests below. An answered question has `코멘트` and `수정 요청` buttons that start a card on the same rows. On submit, Claude acts on comments and change requests, and gets the questions as background only.

### How questions are answered

| | Quick answer | `깊이 조사` (deep investigation) |
|---|---|---|
| When | Every question, automatically | When you press the button on an answered card |
| Speed | Usually 2 seconds to first text and 5 to 7 seconds to finish. Slow runs took up to 6 and 9 seconds | About 35 to 45 seconds |
| Knows | The document and a background summary Claude wrote when opening the review | The whole conversation and the codebase |
| Runs in | A separate headless `claude` call with tools disabled | A subagent of your Claude Code session |

The quick answer says so when the document does not contain the answer. If the quick call cannot run, the question goes to deep investigation by itself.

The `미리보기` view shows the rendered document. Select text there to get the same three actions.

The theme follows the system setting. Drag the dividers to resize the sidebar and its two areas.

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `TABLE_REVIEW_TIMEOUT` | `0` | Seconds to wait for the browser before giving up. `0` waits forever. |
| `TABLE_REVIEW_MODEL` | `sonnet` | Model for quick answers. |
| `TABLE_REVIEW_QUICK_TIMEOUT` | `60` | Seconds before a quick answer gives up and the question goes to deep investigation. |
| `TABLE_REVIEW_CLAUDE_CMD` | `claude` | Command used for quick answers. Use an absolute path. |
| `TABLE_REVIEW_CONTEXT_WAIT` | `45` | Seconds a question waits for Claude's background summary before it is answered without it. |
| `TABLE_REVIEW_BROWSER` | platform opener | Command that opens the page. The address is appended. Defaults to `open` (macOS), `xdg-open` (Linux), `start` (Windows). The `BROWSER` variable is ignored. |
| `TABLE_REVIEW_NO_BROWSER` | unset | Set to `1` to skip opening the browser (tests). |

## When a review ends

| Event | What happens |
|-------|--------------|
| `리뷰 제출` or `취소` | The page closes and its address stops working. Claude gets the result |
| The Claude Code session ends | The review server exits within a few seconds and the page shows that the session ended. Cards stay on screen so you can copy your text |
| The wait is interrupted in Claude Code | The page stays open. Claude picks the review back up when it waits again |
| A second review is requested | The open review is kept. Claude reopens it instead of replacing it, unless you ask for a fresh one |

## Limitations

- Cards live in the browser tab's memory. The browser warns before a reload or tab close, but leaving anyway discards them.
- Closing the tab without submitting leaves Claude waiting. Reopen the address Claude printed, or interrupt the wait in Claude Code.
- Quick answers cannot see your conversation or your files, so they can be wrong or shallow. Use `깊이 조사` when the answer matters.
- Quick answers start `claude` without your settings files. If your login depends on them (for example a custom API endpoint configured in `settings.json`), the quick call fails and every question takes the deep path.
- Ctrl+click was tested on macOS only.

## Development

```bash
claude --plugin-dir plugins/table-review
cd plugins/table-review/mcp-server && uv run test_server.py && python3 test_lifecycle.py
```

Bump `version` in `.claude-plugin/plugin.json` when behavior changes.
