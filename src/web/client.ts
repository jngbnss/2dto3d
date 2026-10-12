/**
 * The preview page is shipped as a string so `tsc` output needs no asset copy
 * step and `node src/cli.ts serve` works straight from the source tree.
 */
export const CLIENT_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>6면 분석 미리보기</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#272c36; --text:#e6e9ef; --muted:#9aa3b2; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 "Pretendard","Segoe UI",system-ui,sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; font-weight:650; }
  .dir { color:var(--muted); font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 14px; cursor:pointer; font-size:13px; }
  button:hover { border-color:#3a4150; }
  .cadlink { margin-left:auto; background:#1b2a44; color:#9cc4ff; border:1px solid #2f4f80; border-radius:6px; padding:6px 14px; font-size:13px; text-decoration:none; }
  .cadlink:hover { border-color:#4c9aff; }
  main { padding:24px; display:grid; grid-template-columns:minmax(0,2fr) minmax(320px,1fr); gap:24px; align-items:start; }
  .views { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
  figure { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  figure img { display:block; width:100%; aspect-ratio:1; object-fit:contain; background:
      repeating-conic-gradient(#1c2029 0% 25%, #15181f 0% 50%) 50%/16px 16px; }
  figcaption { padding:8px 10px; font-size:12px; display:flex; justify-content:space-between; gap:8px; border-top:1px solid var(--line); }
  figcaption b { font-weight:600; }
  figcaption span { color:var(--muted); font-family:ui-monospace,Consolas,monospace; }
  figure.missing img { opacity:.25; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; }
  .score { font-size:40px; font-weight:700; letter-spacing:-1px; }
  .verdict { font-size:13px; padding:3px 10px; border-radius:999px; border:1px solid currentColor; }
  .pass { color:var(--ok); } .review { color:var(--warn); } .fail { color:var(--bad); }
  .check { margin:14px 0; }
  .check-head { display:flex; justify-content:space-between; font-size:13px; }
  .track { height:6px; background:#0c0e13; border-radius:4px; overflow:hidden; margin-top:5px; }
  .fill { height:100%; background:linear-gradient(90deg,#60a5fa,#4ade80); }
  .detail { color:var(--muted); font-size:11.5px; margin-top:4px; font-family:ui-monospace,Consolas,monospace; }
  ul { list-style:none; margin:10px 0 0; padding:0; }
  li { border-left:3px solid var(--line); padding:6px 0 6px 10px; margin-bottom:8px; font-size:12.5px; }
  li.error { border-color:var(--bad); } li.warn { border-color:var(--warn); } li.info { border-color:var(--muted); }
  .axes { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:12px; text-align:center; }
  .axes div { background:#0c0e13; border-radius:8px; padding:10px 6px; }
  .axes b { display:block; font-size:18px; font-family:ui-monospace,Consolas,monospace; }
  .axes small { color:var(--muted); }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:22px 0 0; }
  .hint { color:var(--muted); font-size:12px; }
  figure.slot { position:relative; cursor:pointer; }
  figure.slot .drop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    font-size:13px; color:var(--text); background:rgba(10,12,18,.72); opacity:0; transition:opacity .12s; pointer-events:none; }
  figure.slot:hover .drop, figure.slot.over .drop { opacity:1; }
  figure.slot.over { outline:2px solid #60a5fa; }
  figure.slot button.clear { position:absolute; top:6px; right:6px; width:24px; height:24px; padding:0;
    border-radius:50%; background:rgba(12,14,19,.82); border:1px solid var(--line); color:var(--muted);
    font-size:13px; line-height:1; opacity:0; transition:opacity .12s; }
  figure.slot:hover button.clear { opacity:1; }
  figure.slot button.clear:hover { color:var(--bad); border-color:var(--bad); }
  .carved { background:#0c0e13; border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:16px; font-size:12.5px; }
  .carved a { color:#60a5fa; }
  .carvedviews { grid-template-columns:repeat(3,1fr); gap:6px; margin-top:10px; }
  .carvedviews img { width:100%; aspect-ratio:1; object-fit:contain; background:#15181f; border-radius:4px; }
  @media (max-width: 980px) { main { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>6면 분석 미리보기</h1>
  <span class="dir" id="dir"></span>
  <button id="refresh">다시 분석</button>
  <button id="carve">3D 만들기</button>
  <button id="clearAll">전부 비우기</button>
  <span class="hint">이미지를 칸에 끌어다 놓거나 칸을 클릭해 고르세요</span>
  <a class="cadlink" href="/cad">3D CAD 편집기 열기 →</a>
</header>
<main>
  <section class="views" id="views"></section>
  <aside class="panel" id="report">불러오는 중…</aside>
</main>
<script type="module">
const ORDER = ["front", "back", "left", "right", "top", "bottom"];
const pct = (value) => (value * 100).toFixed(1);

async function load() {
  const response = await fetch("/api/report", { cache: "no-store" });
  const data = await response.json();
  document.getElementById("dir").textContent = data.directory;

  const byId = new Map(data.report.views.map((view) => [view.id, view]));
  document.getElementById("views").innerHTML = ORDER.map((id) => {
    const view = byId.get(id);
    const stamp = Date.now();
    const measure = view
      ? view.extent.width.toFixed(3) + " x " + view.extent.height.toFixed(3)
      : "없음";
    return '<figure class="slot ' + (view ? "" : "missing") + '" data-id="' + id + '">' +
      '<img alt="' + data.labels[id] + '" src="/views/' + id + '?t=' + stamp + '" />' +
      '<figcaption><b>' + data.labels[id] + '</b><span>' + measure + '</span></figcaption>' +
      '<div class="drop">놓기</div>' +
      (view ? '<button class="clear" title="이 뷰 지우기">✕</button>' : "") +
      '</figure>';
  }).join("");

  const report = data.report;
  const checks = report.checks.map((check) =>
    '<div class="check"><div class="check-head"><span>' + check.label + '</span><span>' +
    pct(check.score) + '</span></div><div class="track"><div class="fill" style="width:' +
    pct(check.score) + '%"></div></div><div class="detail">' + check.detail + '</div></div>'
  ).join("");

  const issues = report.issues.length === 0
    ? '<li class="info">검출된 문제 없음</li>'
    : report.issues.map((issue) => '<li class="' + issue.severity + '">' + issue.message + '</li>').join("");

  const verdictText = { pass: "통과", review: "검토 필요", fail: "재생성 권장" }[report.verdict];
  document.getElementById("report").innerHTML =
    '<div style="display:flex;align-items:center;gap:12px"><span class="score">' + pct(report.score) +
    '</span><span class="verdict ' + report.verdict + '">' + verdictText + '</span></div>' +
    '<div class="axes">' +
      '<div><small>X 폭</small><b>' + report.proportions.x.toFixed(3) + '</b></div>' +
      '<div><small>Y 높이</small><b>' + report.proportions.y.toFixed(3) + '</b></div>' +
      '<div><small>Z 깊이</small><b>' + report.proportions.z.toFixed(3) + '</b></div>' +
    '</div>' +
    '<h2>항목별 점수</h2>' + checks +
    '<h2>문제 ' + report.issues.length + '건</h2><ul>' + issues + '</ul>';
  bindSlots();
}

const picker = document.createElement("input");
picker.type = "file";
picker.accept = "image/*";
let target = null;

async function upload(id, file) {
  setStatus(id, "올리는 중…");
  const response = await fetch("/api/upload/" + id, { method: "POST", body: file });
  if (!response.ok) throw new Error(await response.text());
  await load();
}

function setStatus(id, text) {
  const slot = document.querySelector('figure[data-id="' + id + '"] figcaption span');
  if (slot) slot.textContent = text;
}

function bindSlots() {
  for (const slot of document.querySelectorAll("figure.slot")) {
    const id = slot.dataset.id;
    slot.addEventListener("click", () => {
      target = id;
      picker.value = "";
      picker.click();
    });
    const clear = slot.querySelector("button.clear");
    if (clear) {
      clear.addEventListener("click", async (event) => {
        event.stopPropagation();
        setStatus(id, "지우는 중…");
        await fetch("/api/clear/" + id, { method: "POST" });
        await load();
      });
    }
    slot.addEventListener("dragover", (event) => {
      event.preventDefault();
      slot.classList.add("over");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("over"));
    slot.addEventListener("drop", (event) => {
      event.preventDefault();
      slot.classList.remove("over");
      const file = event.dataTransfer?.files?.[0];
      if (file) upload(id, file).catch((error) => setStatus(id, "실패: " + error.message));
    });
  }
}

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file && target) upload(target, file).catch((error) => setStatus(target, "실패: " + error.message));
});

document.getElementById("carve").addEventListener("click", async () => {
  const button = document.getElementById("carve");
  button.disabled = true;
  button.textContent = "깎는 중…";
  try {
    const response = await fetch("/api/carve?res=128", { method: "POST" });
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    const result = JSON.parse(text);
    document.getElementById("report").insertAdjacentHTML(
      "afterbegin",
      '<div class="carved"><b>3D 완성</b> · 복셀 ' + result.voxels.x + "x" + result.voxels.y + "x" +
        result.voxels.z + " · 삼각형 " + result.triangles.toLocaleString() + "개 · 사용 뷰 " +
        result.usedViews.length + '개<br /><a href="/model.obj" download>carved.obj 내려받기</a>' +
        '<div class="views carvedviews">' +
        ORDER.map((id) => '<img src="/carved-views/' + id + "?t=" + Date.now() + '" alt="' + id + '" />').join("") +
        "</div></div>",
    );
  } catch (error) {
    alert("3D 만들기 실패: " + error.message);
  } finally {
    button.disabled = false;
    button.textContent = "3D 만들기";
  }
});

document.getElementById("clearAll").addEventListener("click", async () => {
  if (!confirm("6칸을 모두 비울까요?")) return;
  await Promise.all(ORDER.map((id) => fetch("/api/clear/" + id, { method: "POST" })));
  await load();
});

document.getElementById("refresh").addEventListener("click", load);
load().catch((error) => {
  document.getElementById("report").textContent = "오류: " + error.message;
});
</script>
</body>
</html>
`;
