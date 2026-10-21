'use strict';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token') || '';
const TYPES = {
  comment: { label: '코멘트', icon: '💬' },
  question: { label: '질문', icon: '❓' },
  action: { label: '수정 요청', icon: '✏️' },
  suggestion: { label: '제안', icon: '📝' },
};
const TYPE_BY_KEY = { 1: 'comment', 2: 'question', 3: 'action', 4: 'approve', 5: 'suggestion' };
const APPROVE_TEXT = '제안 승인';  // key 4: saved as a comment without opening the editor

let rows = [];               // {index, blockType, text, startLine, endLine, html, depth}
let items = [];              // saved items, newest first
let selected = new Set();    // row indexes (0-based into rows)
let anchor = null;           // shift-click range start
let folded = new Set();      // heading row indexes whose section is collapsed
let seen = new Set();        // row indexes the user marked as read
let barRow = null;           // row the table action bar floats over
let barX = null;             // clientX of the last row click
let previewSel = null;       // {text, range}
let editing = null;          // unsaved item shown in #q-editor or #c-editor
let view = 'table';
let nextId = 1;
let pollTimer = null;
let done = false;
let ended = false;            // read-only: submitted or server gone; keep the cards readable, stop talking to it

// ---------- safe markdown ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only http(s), mailto and relative URLs are allowed.
function safeUrl(href) {
  const h = String(href || '').replace(/[\u0000-\u0020\u007f]/g, '');
  const m = /^([^/?#]*?):/.exec(h);
  if (!m) return h;
  return /^(https?|mailto)$/i.test(m[1]) ? h : null;
}

// marked 12 passes title/alt already escaped and link text already rendered.
marked.use({
  gfm: true,
  renderer: {
    html(html, block) { return block ? `<pre class="raw-html">${esc(html.trim())}</pre>` : esc(html); },
    link(href, title, text) {
      const url = safeUrl(href);
      if (url === null) return `<span class="bad-link">${text}</span>`;
      return `<a href="${esc(url)}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(href, title, text) {
      const url = safeUrl(href);
      if (url === null) return text;
      return `<img src="${esc(url)}" alt="${text}"${title ? ` title="${title}"` : ''}>`;
    },
  },
});
const md = (s) => marked.parse(String(s ?? ''));
const mdInline = (s) => marked.parseInline(String(s ?? ''));

// ---------- markdown -> rows ----------

function buildRows(content) {
  const src = content.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const out = [];
  let cursor = 0;

  // Best-effort 1-based line numbers: find the block's first line in the source.
  const lines = (raw) => {
    const body = raw.replace(/^\n+/, '').trimEnd();
    const first = body.split('\n')[0];
    const pos = first ? src.indexOf(first, cursor) : -1;
    if (pos < 0) return [null, null];
    cursor = pos + first.length;
    const start = src.slice(0, pos).split('\n').length;
    return [start, start + body.split('\n').length - 1];
  };
  // Rows are indented by the heading they fall under (relative to the shallowest heading in
  // the document, so a file that starts at H2 is not indented from the start), plus list nesting.
  const tokens = marked.lexer(src);
  const base = Math.min(...tokens.filter((t) => t.type === 'heading').map((t) => t.depth), Infinity);
  let section = 0;  // indent for content rows under the current heading
  const add = (blockType, text, html, raw, depth = 0) => {
    const [startLine, endLine] = lines(raw);
    out.push({ index: out.length + 1, blockType, text, html, depth: section + depth, startLine, endLine });
  };

  const addList = (list, depth) => {
    for (const item of list.items) {
      const nested = item.tokens.filter((t) => t.type === 'list');
      const own = item.tokens.filter((t) => t.type !== 'list');
      let raw = item.raw;
      if (nested.length) {
        const cut = raw.indexOf(nested[0].raw.trimStart().split('\n')[0]);
        if (cut > 0) raw = raw.slice(0, cut);
      }
      const text = raw.trim().replace(/^([-*+]|\d+[.)])\s+/, '');
      add('LI', text, marked.parser(own), raw, depth);
      for (const n of nested) addList(n, depth + 1);
    }
  };

  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'hr':
        lines(tok.raw);
        break;
      case 'heading':
        section = tok.depth - base;
        add('H' + tok.depth, tok.text, `<span class="h h${tok.depth}">${mdInline(tok.text)}</span>`, tok.raw);
        section += 1;
        break;
      case 'paragraph':
        add('P', tok.text, mdInline(tok.text), tok.raw);
        break;
      case 'list':
        addList(tok, 0);
        break;
      case 'code':
        add('CODE', tok.text, `<pre><code>${esc(tok.text)}</code></pre>`, tok.raw);
        break;
      case 'blockquote':
        add('QUOTE', tok.text, `<blockquote>${marked.parser(tok.tokens)}</blockquote>`, tok.raw);
        break;
      case 'table': {
        const [start] = lines(tok.raw);
        tok.rows.forEach((cells, r) => {
          const pairs = cells.map((c, i) => [tok.header[i]?.text ?? '', c.text]);
          const line = start === null ? null : start + 2 + r;
          out.push({
            index: out.length + 1,
            blockType: 'TR',
            text: pairs.map(([h, v]) => `${h}: ${v}`).join(' | '),
            html: pairs.map(([h, v]) => `<div><span class="k">${mdInline(h)}</span>: ${mdInline(v)}</div>`).join(''),
            depth: section,
            startLine: line,
            endLine: line,
          });
        });
        break;
      }
      default: {
        const text = tok.raw.trim();
        add('P', text, `<span class="raw">${esc(text)}</span>`, tok.raw);
      }
    }
  }
  return out;
}

// ---------- rendering ----------

// Rows under a heading: everything after it that is indented deeper, up to the next heading at its level.
function sectionRows(i) {
  const out = [];
  for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) out.push(j);
  return out;
}

function renderRows() {
  $('rows').innerHTML = rows.map((r, i) => `
    <tr data-i="${i}" aria-selected="false">
      <td class="num">${r.index}</td>
      <td class="content" style="padding-left:${0.75 + r.depth * 1.25 + (r.blockType[0] === 'H' ? 1.4 : 0)}rem"><div class="cell">${
        r.blockType[0] === 'H' && sectionRows(i).length ? '<button type="button" class="fold" aria-expanded="true" aria-label="접기"></button>' : ''
      }<div class="measure">${r.html}</div></div></td>
      <td class="status"><button type="button" class="seen" aria-pressed="false" title="확인 표시 (Space)">✓</button><span class="st-list"></span></td>
    </tr>`).join('');
}

const trs = () => $('rows').children;
const visibleRows = () => [...trs()].map((tr, i) => (tr.hidden ? -1 : i)).filter((i) => i >= 0);

function applyFolds() {
  const hidden = new Set();
  for (const h of folded) for (const j of sectionRows(h)) hidden.add(j);
  [...trs()].forEach((tr, i) => {
    tr.hidden = hidden.has(i);
    const b = tr.querySelector('.fold');
    if (b) b.setAttribute('aria-expanded', !folded.has(i));
  });
  for (const i of [...selected]) if (hidden.has(i)) selected.delete(i);
  renderSelection();
  renderStatus();
}

function toggleFold(i) {
  if (folded.has(i)) folded.delete(i); else folded.add(i);
  applyFolds();
}

function toggleSeen(idx) {
  const all = idx.every((i) => seen.has(i));
  for (const i of idx) if (all) seen.delete(i); else seen.add(i);
  renderStatus();
}

function renderStatus() {
  const counts = rows.map(() => ({ comment: 0, question: 0, action: 0, suggestion: 0 }));
  for (const it of items) if (!it.parent) for (const r of it.rows) counts[r.index - 1][it.type]++;
  const icons = (c) => Object.entries(c).filter(([, n]) => n)
    .map(([t, n]) => `<span class="st" data-type="${t}">${TYPES[t].icon} ${n}</span>`).join(' ');
  [...trs()].forEach((tr, i) => {
    let c = counts[i], note = '';
    if (folded.has(i)) {  // a collapsed heading carries the cards of the rows it hides
      const sec = sectionRows(i);
      c = { ...c };
      for (const j of sec) for (const t in c) c[t] += counts[j][t];
      note = `<span class="folded-n">${sec.length}행 접힘</span>`;
    }
    tr.querySelector('.st-list').innerHTML = note + icons(c);
    const b = tr.querySelector('.seen');
    b.classList.toggle('on', seen.has(i));
    b.setAttribute('aria-pressed', seen.has(i));
  });
  const total = (t) => items.filter((it) => it.type === t && !it.parent).length;
  $('counts').textContent = `코멘트 ${total('comment')} · 질문 ${total('question')} · 수정 요청 ${total('action')} · 제안 ${total('suggestion')} · 확인 ${seen.size}/${rows.length}`;
}

function renderSelection() {
  $('rows').querySelectorAll('tr').forEach((tr, i) => tr.setAttribute('aria-selected', selected.has(i)));
  $('action-bar').hidden = !(view === 'table' && selected.size && !ended);
  $('sel-count').textContent = `${selected.size}개 선택`;
  positionBar();
}

// Float the table action bar just above the anchor row (below it when there is no room),
// at the click's x, kept inside the main pane under the sticky header.
function positionBar() {
  const bar = $('action-bar');
  if (bar.hidden) return;
  const i = selected.has(barRow) ? barRow : Math.max(...selected);
  const row = $('rows').children[i].getBoundingClientRect();
  const pane = $('main').getBoundingClientRect();
  const headBottom = $('table-view').querySelector('th').getBoundingClientRect().bottom;
  const h = bar.offsetHeight, w = bar.offsetWidth, gap = 4;
  let top = row.top - h - gap;
  if (top < headBottom + gap) top = row.bottom + gap;
  top = Math.min(Math.max(top, headBottom + gap), pane.bottom - h - gap);
  const x = barX ?? pane.left + pane.width / 2;
  const left = Math.min(Math.max(x - w / 2, pane.left + gap), pane.right - w - gap);
  bar.style.top = `${top - pane.top}px`;
  bar.style.left = `${left - pane.left}px`;
}

let barFrame = 0;
function schedulePositionBar() {
  if (!barFrame) barFrame = requestAnimationFrame(() => { barFrame = 0; positionBar(); });
}
$('table-view').addEventListener('scroll', schedulePositionBar, { passive: true });
window.addEventListener('resize', schedulePositionBar);

function targetLabel(it) {
  if (!it.rows.length) return '선택한 텍스트';
  const nums = it.rows.map((r) => r.index);
  const parts = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return 'Row ' + parts.join(', ');
}

function targetPreview(it) {
  const s = it.rows.length ? it.rows[0].text : it.selectedText;
  const more = it.rows.length > 1 ? ` 외 ${it.rows.length - 1}개` : '';
  return (s.length > 80 ? s.slice(0, 80) + '…' : s) + more;
}

function cardHead(it) {
  return `<div class="card-head"><span class="badge">${TYPES[it.type].label}</span>
    <span class="target">${esc(targetLabel(it))}</span></div>
    <div class="target-preview">${esc(targetPreview(it))}</div>`;
}

const isQ = (it) => it.type === 'question';
const byId = (id) => items.find((x) => x.id === id);
// Follow-up questions hang under their parent card, oldest first.
const children = (it) => items.filter((c) => c.parent === it.id).reverse();

// Word-level diff as <del>/<ins> markup. ponytail: O(n·m) LCS, fine for a paragraph; blocks past
// the cap fall back to old-then-new so a huge code block cannot freeze the page.
function wordDiff(a, b) {
  const A = a.split(/(\s+)/).filter(Boolean), B = b.split(/(\s+)/).filter(Boolean);
  if (A.length * B.length > 250000) return `<del>${esc(a)}</del>\n<ins>${esc(b)}</ins>`;
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  const push = (tag, s) => {
    const last = out[out.length - 1];
    if (last && last.tag === tag) last.s += s; else out.push({ tag, s });
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('', A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return out.map(({ tag, s }) => (tag ? `<${tag}>${esc(s)}</${tag}>` : esc(s))).join('');
}

const qParts = '<div class="q-quick answer"></div><div class="q-deep answer"></div><div class="q-follow followup"></div>';
function cardHtml(it) {
  // Question answers are filled in part by part by updateQuestion().
  let body = `<div class="text">${esc(it.text)}</div>`, foot = '';
  if (it.type === 'suggestion') body = `<div class="text diff">${wordDiff(it.original, it.text)}</div>`;
  if (isQ(it)) {
    foot = qParts + children(it).map((c) =>
      `<div class="thread-item" data-id="${esc(c.id)}"><div class="text">${esc(c.text)}</div>${qParts}</div>`).join('')
      + '<div class="q-ask"></div>';
  }
  return `<article class="card ${it.type}" data-id="${esc(it.id)}">
    <button type="button" class="del" aria-label="삭제">×</button>
    ${cardHead(it)}
    ${body}${foot}</article>`;
}

// Questions live in the top section, newest first. Comments and actions in the bottom one follow
// document order (first row of each card; text selections from the preview last), newest first on ties.
const firstRow = (it) => (it.rows.length ? it.rows[0].index : Number.MAX_SAFE_INTEGER);
function renderCards() {
  const qs = items.filter((it) => isQ(it) && !it.parent);
  const cs = items.filter((it) => !isQ(it)).sort((a, b) => firstRow(a) - firstRow(b));
  $('q-cards').innerHTML = qs.map(cardHtml).join('');
  $('c-cards').innerHTML = cs.map(cardHtml).join('');
  items.filter(isQ).forEach(updateQuestion);
  $('q-count').textContent = qs.length;
  $('c-count').textContent = cs.length;
  updateEmpty();
  renderStatus();
}

function updateEmpty() {
  $('q-empty').hidden = items.some(isQ) || editing?.type === 'question';
  $('c-empty').hidden = items.some((it) => !isQ(it)) || (!!editing && editing.type !== 'question');
}

const spinner = (label) => `<div class="pending"><span class="spinner" aria-hidden="true"></span>${label}</div>`;

function questionParts(it) {
  const q = it.quick || { text: '', done: false, failed: false, held: false };
  const d = it.deep || { state: 'none', text: '' };
  let quick;
  if (it.failed) quick = '<div class="pending failed">전송 실패 — 제출 시 미답변 질문으로 전달됩니다</div>';
  else if (q.failed) quick = '<div class="pending failed">빠른 답변 실패, 깊이 조사로 전환합니다</div>';
  else if (q.held) quick = spinner('배경 정리 중…');
  else if (!q.text) quick = spinner('답변 생성 중…');
  else {
    quick = `<div class="answer-label">답변${q.done ? '' : ' <span class="streaming">작성 중</span>'}</div>
      <div class="markdown">${md(q.text)}</div>`;
  }
  let deep = '';
  if (d.state === 'pending') deep = spinner('깊이 조사 중…');
  if (d.state === 'done') deep = `<div class="answer-label">깊이 조사 답변</div><div class="markdown">${md(d.text)}</div>`;
  let follow = '';
  if (q.done || d.state === 'done') {
    follow = `<button type="button" data-follow="comment">코멘트</button>
      <button type="button" data-follow="action">수정 요청</button>`;
    if (q.done) follow += `<button type="button" data-deepen${d.state === 'none' ? '' : ' disabled'}>깊이 조사</button>`;
  }
  return { quick, deep, follow };
}

const answered = (it) => !!(it.quick?.done || it.deep?.state === 'done');
const bestAnswer = (it) => (it.deep?.state === 'done' ? it.deep.text : it.quick?.text || '');

// Patch only the parts that changed, and never under the user's text selection,
// so streaming does not steal focus, reset scroll, or collapse a selection.
let staleQuestions = false;
function updateQuestion(it) {
  const card = $('q-cards').querySelector(`[data-id="${CSS.escape(it.id)}"]`);
  if (!card) return;
  const sel = window.getSelection();
  for (const [name, html] of Object.entries(questionParts(it))) {
    const el = card.querySelector(`.q-${name}`);
    if (el.rendered === html) continue;
    if (!sel.isCollapsed && (el.contains(sel.anchorNode) || el.contains(sel.focusNode))) {
      staleQuestions = true;
      continue;
    }
    el.innerHTML = html;
    el.rendered = html;
  }
  // The follow-up box sits at the bottom of the top-level card, once the latest question is answered.
  const top = it.parent ? byId(it.parent) : it;
  const topCard = top && card.closest('.card');
  if (!topCard) return;
  const last = [top, ...children(top)].pop();
  const ask = topCard.querySelector('.q-ask');
  const want = answered(last) && !ended;
  if (want && !ask.firstChild) {
    ask.innerHTML = '<textarea class="ask" rows="1" placeholder="이어서 질문… (Enter)" aria-label="후속 질문"></textarea>';
  } else if (!want && ask.firstChild) ask.replaceChildren();
}

function askFollowup(top, text) {
  const item = { id: `item-${nextId++}`, type: 'question', parent: top.id, rows: top.rows, selectedText: top.selectedText, text };
  const thread = [top, ...children(top)].map((x) => ({ question: x.text, answer: bestAnswer(x) }));
  items.unshift(item);
  renderCards();
  sendQuestion(item, thread);
}
document.addEventListener('selectionchange', () => {
  if (staleQuestions && window.getSelection().isCollapsed) {
    staleQuestions = false;
    items.filter(isQ).forEach(updateQuestion);
  }
});

// ---------- selection ----------

function hasSelection() {
  return view === 'table' ? selected.size > 0 : !!previewSel;
}

function clearSelection() {
  selected.clear();
  anchor = null;
  renderSelection();
  previewSel = null;
  $('float-bar').hidden = true;
  window.getSelection().removeAllRanges();
}

$('rows').addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });
function onRowClick(e) {
  const tr = e.target.closest('tr');
  if (!tr || e.target.closest('a')) return;
  const i = Number(tr.dataset.i);
  const st = e.target.closest('.st');
  if (st) { focusCards(i, st.dataset.type); return; }
  if (e.target.closest('.seen')) { if (!ended) toggleSeen([i]); return; }
  if (e.target.closest('.fold')) { toggleFold(i); return; }
  if (e.target.closest('.status')) return;  // empty part of the status cell: not a row toggle
  barRow = i;
  barX = e.clientX;
  const sel = window.getSelection();
  if (!sel.isCollapsed && tr.contains(sel.anchorNode) && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    // Text dragged inside a row: keep it (it becomes a quote in the card) and make sure the row is selected.
    if (!selected.has(i)) { selected = new Set([i]); anchor = i; }
    renderSelection();
    return;
  }
  if (e.shiftKey && anchor !== null) {
    selected = new Set();
    for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) if (!trs()[k].hidden) selected.add(k);
  } else if (e.metaKey || e.ctrlKey) {
    if (selected.has(i)) selected.delete(i); else selected.add(i);
    anchor = i;
  } else if (selected.size === 1 && selected.has(i)) {
    selected.clear();
    anchor = null;
  } else {
    selected = new Set([i]);
    anchor = i;
  }
  renderSelection();
}
$('rows').addEventListener('click', onRowClick);
// Keep a text selection dragged inside a row when the overlay buttons are pressed.
$('action-bar').addEventListener('mousedown', (e) => e.preventDefault());

// ↑/↓ (or k/j) move the selection one visible row; with Shift the range grows from the anchor.
function moveSelection(dir, extend) {
  const vis = visibleRows();
  if (!vis.length) return;
  const step = (i) => vis[Math.min(Math.max(vis.indexOf(i) + dir, 0), vis.length - 1)];
  const lo = Math.min(...selected), hi = Math.max(...selected);
  if (!selected.size) {
    barRow = dir > 0 ? vis[0] : vis[vis.length - 1];
    selected = new Set([barRow]);
    anchor = barRow;
  } else if (extend && anchor !== null) {
    barRow = step(hi !== anchor ? hi : lo);  // the end opposite the anchor moves
    selected = new Set(vis.filter((i) => i >= Math.min(anchor, barRow) && i <= Math.max(anchor, barRow)));
  } else {
    barRow = step(dir > 0 ? hi : lo);
    selected = new Set([barRow]);
    anchor = barRow;
  }
  barX = null;
  trs()[barRow].scrollIntoView({ block: 'nearest' });
  renderSelection();
}

// Status icon: scroll to the first card of that type on the row and flash every such card.
function focusCards(i, type) {
  const ids = new Set(items.filter((it) => it.type === type && it.rows.some((r) => r.index === i + 1)).map((it) => it.id));
  const cards = [...$('sidebar').querySelectorAll('.card[data-id]')].filter((c) => ids.has(c.dataset.id));
  const seen = new Set();  // questions and comments scroll separately: bring the first card of each into view
  for (const c of cards) {
    const section = c.closest('.side-section');
    if (!seen.has(section)) { seen.add(section); c.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    c.classList.remove('flash');
    void c.offsetWidth;  // restart the animation on a repeated click
    c.classList.add('flash');
    c.addEventListener('animationend', () => c.classList.remove('flash'), { once: true });
  }
}
// macOS turns Ctrl+click into a context menu instead of a click; treat it as Ctrl+click.
$('rows').addEventListener('contextmenu', (e) => {
  if (!e.ctrlKey || e.button !== 0) return;
  e.preventDefault();
  onRowClick(e);
});

$('preview-view').addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (ended || !text || !sel.rangeCount || !$('preview-view').contains(sel.anchorNode)) {
      previewSel = null;
      $('float-bar').hidden = true;
      return;
    }
    const range = sel.getRangeAt(0).cloneRange();
    previewSel = { text, range };
    const rect = range.getBoundingClientRect();
    const bar = $('float-bar');
    bar.hidden = false;
    bar.style.top = `${Math.max(8, rect.top - bar.offsetHeight - 8)}px`;
    bar.style.left = `${Math.min(window.innerWidth - bar.offsetWidth - 8, Math.max(8, rect.left))}px`;
  });
});
// Keep the text selection when pressing toolbar buttons.
$('float-bar').addEventListener('mousedown', (e) => e.preventDefault());

// ---------- items ----------

// target: {rows, selectedText, range}; defaults to the current selection.
function startItem(type, target) {
  if (ended || (!target && !hasSelection())) return;
  const next = target ? { ...target } : view === 'table'
    ? { rows: [...selected].sort((a, b) => a - b).map((i) => {
        const { index, blockType, text, startLine, endLine } = rows[i];
        return { index, blockType, text, startLine, endLine };
      }), selectedText: '', range: null }
    : { rows: [], selectedText: previewSel.text, range: previewSel.range };
  // Quote text dragged inside the rows (read before flushing: saving clears the selection).
  let quote = '';
  if (view === 'table' && !target) {
    const sel = window.getSelection();
    const t = sel.toString().trim();
    if (t && $('rows').contains(sel.anchorNode)) quote = '> ' + t.replace(/\n/g, '\n> ') + '\n\n';
  }
  flushEditing();  // a card still being written is kept, not abandoned
  editing = next;
  editing.id = `item-${nextId++}`;
  editing.type = type === 'approve' ? 'comment' : type;
  if (type === 'approve') { saveItem(APPROVE_TEXT); return; }

  // Prefill: a suggestion starts from the current text; other cards quote the dragged text.
  let prefill = quote, hint = 'Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소';
  if (type === 'suggestion') {
    editing.original = editing.rows.length ? editing.rows.map((r) => r.text).join('\n\n') : editing.selectedText;
    prefill = editing.original;
    hint = '원문을 고쳐 쓰세요 · ' + hint;
  }
  const box = document.createElement('article');
  box.className = `card ${type} editing`;
  box.innerHTML = `${cardHead(editing)}
    <textarea rows="${type === 'suggestion' ? 6 : 3}" aria-label="${TYPES[type].label} 입력" placeholder="${TYPES[type].label} 입력…"></textarea>
    <div class="hint">${hint}</div>`;
  const ta = box.querySelector('textarea');
  ta.value = prefill;
  ta.selectionStart = ta.selectionEnd = prefill.length;
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEditing(ta);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      discardEditing();
    }
  });
  $(isQ(editing) ? 'q-editor' : 'c-editor').replaceChildren(box);
  updateEmpty();
  $('float-bar').hidden = true;
  ta.focus();
}

// Save the open editor if it holds a valid text, otherwise drop it.
function flushEditing() {
  if (!editing) return;
  const ta = document.querySelector('.editor-slot textarea');
  const text = ta ? ta.value.trim() : '';
  if (text && !(editing.type === 'suggestion' && text === editing.original.trim())) saveItem(text, true);
  else discardEditing();
}

function discardEditing() {
  editing = null;
  $('q-editor').replaceChildren();
  $('c-editor').replaceChildren();
  updateEmpty();
}

function saveEditing(ta) {
  const text = ta.value.trim();
  if (!text || (editing.type === 'suggestion' && text === editing.original.trim())) {
    if (editing.type === 'comment') discardEditing();
    else ta.classList.add('invalid');  // a suggestion has to change something
    return;
  }
  saveItem(text);
}

function saveItem(text, keepSelection = false) {
  const { range, ...item } = editing;
  item.text = text;
  if (range) {
    try {
      const mark = document.createElement('mark');
      mark.className = `hl ${item.type}`;
      mark.dataset.item = item.id;
      range.surroundContents(mark);
    } catch { /* crosses element boundaries: skip highlight */ }
  }
  items.unshift(item);
  discardEditing();
  if (!keepSelection) clearSelection();
  renderCards();
  if (item.type === 'question') sendQuestion(item);
}

function sendQuestion(item, thread = []) {
  item.sent = api('question', { id: item.id, text: item.text, rows: item.rows, selectedText: item.selectedText, thread })
    .catch((err) => {
      item.failed = true;
      updateQuestion(item);
      showError(`질문 전송 실패: ${err.message}`);
    });
  syncPolling();
}

const inFlight = (it) => isQ(it) && !it.failed
  && (!it.quick || (!it.quick.done && !it.quick.failed) || it.deep?.state === 'pending');

function syncPolling() {
  if (!pollTimer && !done && !ended && items.some(inFlight)) pollTimer = setTimeout(poll, 400);
}

async function poll() {
  try {
    const { answers } = await api('answers');
    for (const it of items) {
      if (isQ(it) && answers[it.id]) {
        Object.assign(it, answers[it.id]);
        updateQuestion(it);
      }
    }
  } catch (err) {
    showError(`답변 확인 실패: ${err.message}`);
  }
  pollTimer = null;
  syncPolling();
}

$('c-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  $('c-cards').dataset.filter = b.dataset.filter;
  $('c-filter').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
});

$('sidebar').addEventListener('keydown', (e) => {
  const ta = e.target.closest('textarea.ask');
  if (!ta || e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = ta.value.trim();
    const top = byId(ta.closest('.card').dataset.id);
    if (text && top && !ended) askFollowup(top, text);
  } else if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); }
});

$('sidebar').addEventListener('click', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (!card || e.target.closest('a, .ask')) return;
  const it = byId(card.dataset.id);
  if (!it) return;
  const q = byId(e.target.closest('[data-id]').dataset.id) || it;  // a follow-up inside the card, or the card itself
  const follow = e.target.closest('[data-follow]');
  if (ended && (follow || e.target.closest('[data-deepen], .del'))) return;
  if (follow) {
    startItem(follow.dataset.follow, { rows: it.rows, selectedText: it.selectedText, range: null });
    return;
  }
  if (e.target.closest('[data-deepen]')) {
    q.deep = { state: 'pending', text: '' };
    updateQuestion(q);
    syncPolling();
    api('deepen', { id: q.id }).catch((err) => {
      q.deep = { state: 'none', text: '' };
      updateQuestion(q);
      showError(`깊이 조사 요청 실패: ${err.message}`);
    });
    return;
  }
  const mark = document.querySelector(`mark[data-item="${CSS.escape(it.id)}"]`);
  if (e.target.closest('.del')) {
    if (inFlight(it) && it.sent) {
      // Stop the quick-answer child once the question has reached the server.
      it.sent.then(() => api('stop', { id: it.id })).catch((err) => showError(`답변 중지 실패: ${err.message}`));
    }
    for (const c of children(it)) if (inFlight(c) && c.sent) c.sent.then(() => api('stop', { id: c.id })).catch(() => {});
    items = items.filter((x) => x !== it && x.parent !== it.id);
    if (mark) mark.replaceWith(...mark.childNodes);
    renderCards();
    syncPolling();
    return;
  }
  if (!window.getSelection().isCollapsed) return;  // the user is selecting text in the card
  let targets = [];
  if (it.rows.length) {
    setView('table');
    targets = it.rows.map((r) => $('rows').children[r.index - 1]);
  } else if (mark) {
    setView('preview');
    targets = [mark];
  }
  if (!targets.length) return;
  targets[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  for (const t of targets) {
    t.classList.remove('flash');
    void t.offsetWidth;
    t.classList.add('flash');
  }
});

// ---------- server ----------

async function api(path, body) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Review-Token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // No connection at all: the review was closed or the session died.
    sessionEnded();
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showError(msg) {
  if (ended) return;
  const el = $('error');
  el.textContent = `${msg} (클릭하여 닫기)`;
  el.hidden = false;
}
$('error').addEventListener('click', () => { if (!ended) $('error').hidden = true; });

function sessionEnded() {
  if (!done) readOnly('리뷰 세션이 종료되었습니다. 작성한 항목은 사이드바에 남아 있으니 필요하면 복사하세요.');
}

// Cards stay visible and copyable; nothing can be edited or sent any more.
function readOnly(note) {
  if (ended) return;
  ended = true;
  if (editing) discardEditing();
  clearSelection();
  document.body.classList.add('readonly');
  $('error').textContent = note;
  $('error').hidden = false;
  $('submit').disabled = $('cancel').disabled = true;
}

let doneNote = '';
function dismissDone() {
  $('done').hidden = true;
  document.body.classList.add('finished');  // neutral note: this is not an error
  readOnly(doneNote);
}
$('done-view').addEventListener('click', dismissDone);

// Items live only in memory: warn before a reload or tab close throws them away.
window.addEventListener('beforeunload', (e) => {
  // items holds saved comments, actions and questions alike.
  if (!done && items.length) e.preventDefault();
});

async function submit(status) {
  if (done || ended) return;
  if (status === 'cancelled' && !confirm('리뷰를 취소할까요? 작성한 항목은 전달되지 않습니다.')) return;
  const payload = {
    status,
    items: items.filter((it) => !isQ(it)).map(({ id, type, rows: r, selectedText, text, original }) =>
      (original === undefined ? { id, type, rows: r, selectedText, text } : { id, type, rows: r, selectedText, text, original })),
    questions: items.filter(isQ).map(({ id, rows: r, selectedText, text, parent }) =>
      (parent ? { id, text, rows: r, selectedText, parent } : { id, text, rows: r, selectedText })),
    seen: [...seen].sort((a, b) => a - b).map((i) => rows[i].index),
  };
  try {
    await api('submit', payload);
  } catch (err) {
    showError(`제출 실패: ${err.message}`);
    return;
  }
  done = true;
  syncPolling();
  $('done').querySelector('p').textContent = status === 'submitted'
    ? '제출 완료, 이 탭을 닫아도 됩니다' : '리뷰가 취소되었습니다. 이 탭을 닫아도 됩니다';
  doneNote = status === 'submitted' ? '리뷰를 제출했습니다. 읽기 전용입니다.' : '리뷰를 취소했습니다. 읽기 전용입니다.';
  $('done').hidden = false;
  $('done-view').focus();
  window.close();  // usually blocked for tabs the script did not open
}

// ---------- view, keyboard, splitter ----------

function setView(v) {
  view = v;
  $('table-view').hidden = v !== 'table';
  $('preview-view').hidden = v !== 'preview';
  $('view-table').setAttribute('aria-pressed', v === 'table');
  $('view-preview').setAttribute('aria-pressed', v === 'preview');
  if (v === 'table') { previewSel = null; $('float-bar').hidden = true; }
  renderSelection();
}

$('view-table').addEventListener('click', () => setView('table'));
$('view-preview').addEventListener('click', () => setView('preview'));
$('submit').addEventListener('click', () => submit('submitted'));
$('cancel').addEventListener('click', () => submit('cancelled'));
document.querySelectorAll('.actions button').forEach((b) =>
  b.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;  // modifier clicks are meant for the rows
    startItem(b.dataset.type);
  }));

// While a selection modifier is held, the table overlay lets clicks through to the rows under it.
const setPassThrough = (on) => $('action-bar').classList.toggle('pass-through', on);
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, (e) => setPassThrough(e.metaKey || e.ctrlKey || e.shiftKey));
}
window.addEventListener('blur', () => setPassThrough(false));
document.addEventListener('visibilitychange', () => setPassThrough(false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('done').hidden) {
    dismissDone();
    return;
  }
  if (done || ended || e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    if (editing) discardEditing(); else clearSelection();
    return;
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    if (!editing) { e.preventDefault(); submit('submitted'); }
    return;
  }
  if (e.target.closest && e.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
  if ((e.key === 't' || e.key === 'p') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    setView(e.key === 't' ? 'table' : 'preview');
    return;
  }
  const nav = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
  if (nav && view === 'table' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    moveSelection(nav, e.shiftKey);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (e.key === ' ' && view === 'table' && selected.size) {
    e.preventDefault();
    toggleSeen([...selected]);
    return;
  }
  const type = TYPE_BY_KEY[e.key];
  if (type && hasSelection()) {
    e.preventDefault();
    startItem(type);
  }
});

// Sidebar width is a share of the layout (default 5:5); CSS keeps it at least 260px.
// Theme: '' follows the system setting; 'light' / 'dark' pin one (also applied pre-paint in index.html).
const THEME_KEY = 'table-review.theme';
function setTheme(v, save) {
  if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
  $('theme').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.theme === v));
  if (save) try { v ? localStorage.setItem(THEME_KEY, v) : localStorage.removeItem(THEME_KEY); } catch { /* storage unavailable */ }
}
$('theme').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-theme]');
  if (b) setTheme(b.dataset.theme, true);
});
setTheme(document.documentElement.dataset.theme || '', false);

const FONT_KEY = 'table-review.font-size';
function setDocSize(px, save) {
  const size = Math.min(Math.max(px, 12), 22);
  $('main').style.setProperty('--doc-size', `${size}px`);
  schedulePositionBar();
  if (save) try { localStorage.setItem(FONT_KEY, String(size)); } catch { /* storage unavailable */ }
}
const docSize = () => parseFloat(getComputedStyle($('main')).getPropertyValue('--doc-size')) || 15;
$('font-dec').addEventListener('click', () => setDocSize(docSize() - 1, true));
$('font-inc').addEventListener('click', () => setDocSize(docSize() + 1, true));
try {
  const saved = Number(localStorage.getItem(FONT_KEY));
  if (saved) setDocSize(saved, false);
} catch { /* storage unavailable */ }

const SIDEBAR_KEY = 'table-review.sidebar-ratio';
function setSidebarRatio(r, save) {
  const ratio = Math.min(Math.max(r, 0.15), 0.7);
  $('layout').style.setProperty('--sidebar-w', `${(ratio * 100).toFixed(2)}%`);
  $('ratio').querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', Math.abs(Number(b.dataset.ratio) - ratio) < 0.005));
  schedulePositionBar();
  if (save) try { localStorage.setItem(SIDEBAR_KEY, String(ratio)); } catch { /* storage unavailable */ }
}
// The ratio is of the layout's content box: the percentage width resolves against it, not the padding.
function layoutBox() {
  const l = $('layout'), cs = getComputedStyle(l), r = l.getBoundingClientRect();
  const left = r.left + parseFloat(cs.paddingLeft), right = r.right - parseFloat(cs.paddingRight);
  return { left, right, width: right - left };
}
const sidebarRatio = () => $('sidebar').offsetWidth / layoutBox().width;
$('ratio').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ratio]');
  if (b) setSidebarRatio(Number(b.dataset.ratio), true);
});
setSidebarRatio(0.5, false);
try {
  const saved = Number(localStorage.getItem(SIDEBAR_KEY));
  if (saved) setSidebarRatio(saved, false);
} catch { /* storage unavailable */ }

const splitter = $('splitter');
splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
});
splitter.addEventListener('pointermove', (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  const box = layoutBox();
  setSidebarRatio((box.right - e.clientX) / box.width, false);
});
splitter.addEventListener('pointerup', (e) => {
  splitter.releasePointerCapture(e.pointerId);
  document.body.classList.remove('resizing');
  setSidebarRatio(sidebarRatio(), true);
});
splitter.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: 0.02, ArrowRight: -0.02 }[e.key];
  if (step) setSidebarRatio(sidebarRatio() + step, true);
});

// Question / comment split: CSS min-heights keep both sections usable.
const SPLIT_KEY = 'table-review.question-ratio';
function setQuestionRatio(r, save) {
  const ratio = Math.min(Math.max(r, 0.1), 0.9);
  $('sidebar').style.setProperty('--q-h', `${(ratio * 100).toFixed(1)}%`);
  if (save) try { localStorage.setItem(SPLIT_KEY, String(ratio)); } catch { /* storage unavailable */ }
}
const currentRatio = () => $('q-section').offsetHeight / $('sidebar').clientHeight;
try {
  const saved = Number(localStorage.getItem(SPLIT_KEY));
  if (saved) setQuestionRatio(saved, false);
} catch { /* storage unavailable */ }

const hsplitter = $('hsplitter');
hsplitter.addEventListener('pointerdown', (e) => {
  hsplitter.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing-rows');
});
hsplitter.addEventListener('pointermove', (e) => {
  if (!hsplitter.hasPointerCapture(e.pointerId)) return;
  const box = $('sidebar').getBoundingClientRect();
  setQuestionRatio((e.clientY - box.top) / box.height, false);
});
hsplitter.addEventListener('pointerup', (e) => {
  hsplitter.releasePointerCapture(e.pointerId);
  document.body.classList.remove('resizing-rows');
  setQuestionRatio(currentRatio(), true);
});
hsplitter.addEventListener('keydown', (e) => {
  const step = { ArrowUp: -0.05, ArrowDown: 0.05 }[e.key];
  if (step) {
    e.preventDefault();
    setQuestionRatio(currentRatio() + step, true);
  }
});

// ---------- boot ----------

(async () => {
  try {
    const { title, content, file } = await api('review');
    document.title = title;
    $('title').textContent = title;
    $('file').textContent = file && file !== title ? file : '';
    rows = buildRows(content);
    renderRows();
    $('preview-view').innerHTML = md(content);
    renderCards();
    renderSelection();
  } catch (err) {
    showError(`리뷰 내용을 불러오지 못했습니다: ${err.message}`);
  }
})();
