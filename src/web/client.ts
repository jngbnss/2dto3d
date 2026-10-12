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
  @media (max-width: 980px) { main { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>6면 분석 미리보기</h1>
  <span class="dir" id="dir"></span>
  <button id="refresh">다시 분석</button>
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
    return '<figure class="' + (view ? "" : "missing") + '">' +
      '<img alt="' + data.labels[id] + '" src="/views/' + id + '?t=' + stamp + '" />' +
      '<figcaption><b>' + data.labels[id] + '</b><span>' + measure + '</span></figcaption>' +
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
}

document.getElementById("refresh").addEventListener("click", load);
load().catch((error) => {
  document.getElementById("report").textContent = "오류: " + error.message;
});
</script>
</body>
</html>
`;
