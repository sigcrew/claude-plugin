# claude-plugin

sigcrew의 [Claude Code](https://claude.com/claude-code) 플러그인 마켓플레이스입니다.

## 플러그인

| 플러그인 | 설명 | 호출 |
|---|---|---|
| [table-review](plugins/table-review) | 계획이나 마크다운 문서를 브라우저의 테이블 화면에서 리뷰합니다. Row를 선택해 코멘트, 질문, 수정 요청을 남깁니다. | `/table-review:review` |

## 설치

### 준비

| 필요한 것 | 확인 | 설치 |
|---|---|---|
| Claude Code | `claude --version` | [설치 안내](https://docs.claude.com/en/docs/claude-code/setup) |
| uv | `uv --version` | `brew install uv` 또는 [설치 안내](https://docs.astral.sh/uv/getting-started/installation/) |

uv는 `table-review`의 MCP 서버를 실행할 때 씁니다. Python 패키지는 첫 실행 때 uv가 자동으로 받습니다.

### 1. 마켓플레이스 추가

Claude Code 안에서 실행합니다.

```
/plugin marketplace add sigcrew/claude-plugin
```

### 2. 플러그인 설치

```
/plugin install table-review@sigcrew
```

### 3. Claude Code 재시작

재시작해야 플러그인의 스킬과 MCP 서버가 로드됩니다.

### 4. 확인

```
/plugin
```

설치된 플러그인 목록에 `table-review`가 보이고, `/mcp`에서 `table_review` 서버가 연결 상태면 됩니다.

### 터미널에서 설치

Claude Code 밖에서도 같은 작업을 할 수 있습니다.

```bash
claude plugin marketplace add sigcrew/claude-plugin
claude plugin install table-review@sigcrew
claude plugin list
```

## 사용

Claude에게 "검토해줘", "review this"라고 하거나 직접 호출합니다.

```
/table-review:review docs/plan.md
```

브라우저 탭이 열립니다. 조작 방법은 [table-review README](plugins/table-review/README.md)에 있습니다.

## 업데이트

```bash
claude plugin marketplace update sigcrew
claude plugin update table-review@sigcrew
```

업데이트 후 Claude Code를 재시작합니다.

## 제거

```bash
claude plugin uninstall table-review@sigcrew
claude plugin marketplace remove sigcrew
```

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| `/mcp`에서 `table_review`가 실패로 표시됨 | `uv --version`이 동작하는지 확인합니다. 설치 직후라면 터미널을 새로 열고 Claude Code를 재시작합니다. |
| `/table-review:review`가 목록에 없음 | 설치 후 Claude Code를 재시작했는지 확인합니다. |
| 브라우저가 열리지 않음 | 기본 브라우저가 설정되어 있는지 확인합니다. SSH 등 화면이 없는 환경에서는 쓸 수 없습니다. |
| 브라우저 탭이 보이지 않음 | Claude가 출력한 페이지 주소를 직접 엽니다. 주소의 `?token=` 부분까지 포함해야 합니다. |
| 페이지에 HTTP 403이 표시됨 | 주소에 `?token=`이 빠진 경우입니다. Claude가 출력한 주소 전체를 사용합니다. |
| 페이지가 열리는 데 1분 이상 걸림 | 파일로 저장된 문서는 `/table-review:review <파일 경로>`로 열면 바로 열립니다. 대화에만 있는 내용은 Claude가 본문을 다시 출력해야 해서 오래 걸립니다. |
| 탭을 닫았더니 Claude가 계속 기다림 | Claude가 출력한 주소를 다시 열거나, Claude Code에서 Esc로 대기를 중단합니다. |
| 질문 답변이 매번 30초 넘게 걸림 | 빠른 답변이 실패해 깊이 조사로 넘어가는 상태입니다. 터미널에서 `claude --version`이 동작하는지 확인합니다. |

## 개발

저장소를 받아 설치 없이 바로 로드할 수 있습니다.

```bash
git clone git@github.com:sigcrew/claude-plugin.git
cd claude-plugin
claude --plugin-dir plugins/table-review
```

변경 후 검증합니다.

```bash
claude plugin validate --strict .
claude plugin validate --strict plugins/table-review
cd plugins/table-review/mcp-server && uv run test_server.py && python3 test_lifecycle.py
```

### 플러그인 추가

1. `plugins/<이름>/.claude-plugin/plugin.json`을 만듭니다.
2. `.claude-plugin/marketplace.json`의 `plugins`에 등록합니다.
3. 위 검증 명령을 통과시킵니다.

동작이 바뀌면 해당 플러그인 `plugin.json`의 `version`을 올립니다.
