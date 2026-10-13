#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { VIEW_IDS } from "./views.ts";
import { demoMesh } from "./mesh/primitives.ts";
import { writeGlb } from "./mesh/index.ts";
import { syntheticFixtures } from "./synthetic.ts";
import { analyzeViewSet, formatReport, type ViewPaths } from "./analyze/report.ts";
import { loadTransforms } from "./orientation.ts";
import {
  reconstructFromViews,
  renderAndAnalyze,
  renderToDirectory,
  runFromViews,
  viewPathsFromDirectory,
} from "./pipeline.ts";
import { DEFAULT_PROVIDER, PROVIDERS } from "./generate/index.ts";
import { startServer } from "./web/server.ts";

const USAGE = `sixview — front/back/left/right/top 5면 정투영 이미지로 3D 메시를 복원합니다.

사용법
  sixview serve   [--dir <dir>] [--port <n>]   5면 업로드·방향/정렬 보정·검증·3D 생성 + /viewer
  sixview analyze <dir> | --front a.png … --top e.png [--json <file>]   정렬 품질만 검사
  sixview build   <dir> | --front a.png … --top e.png [--out <dir>] [--method silhouette|geometry|ai|hybrid] [--res <n>] [--symmetry] [--rounding <0..1>] [--smoothing <n>]
                  silhouette: 실루엣 교집합 / geometry: 기본 형상 후보 / ai: AI 형상 / hybrid: 후보 자동 선택
                  → <out>/model.glb, model.obj, voxels.glb, result/*.png (ai는 ai-raw.glb도)
  sixview demo    [--out <dir>] [--size <px>]   샘플 형상을 5면으로 렌더 (테스트용 입력)
  sixview synthetic [--out <dir>] [--size <px>] 구·원통·컵 손잡이·구멍 상자·비대칭 GT 세트 생성
  sixview render  <mesh.glb|obj> [--out <dir>] [--size <px>]
  sixview run     <dir> | --front a.png … [--provider <${Object.keys(PROVIDERS).join("|")}>] [--model <id>] [--out <dir>]
                  (선택) 생성형 모델로 3D 생성 → 입력 비율 보정·색 입히기

<dir>에 views.json(웹에서 저장한 회전·반전·보정 값)이 있으면 그대로 적용합니다.

옵션
  --out        결과 디렉터리 (기본 ./out, build는 기본 <dir>)
  --size       렌더 해상도, 정사각 픽셀 (기본 512)
  --method     build 방식: silhouette | geometry | ai(인터넷 필요) | hybrid(기본 후보 자동 선택)
  --res        복원 격자 해상도, 가장 긴 축 기준 (기본 160)
  --symmetry   좌우 대칭 prior (자동차 등)
  --rounding   곡면 보정 0~1: 수평 단면을 타원으로 깎아 대각선 모서리를 둥글게 (캐릭터 0.8~1, 자동차 0)
  --smoothing  실루엣 보존 스무딩 반복 횟수 (기본 12)
  --model      공급자 모델 id (기본값은 공급자별 문서 참조)
  --json       분석 결과를 JSON으로 저장

공급자 (run, 기본 ${DEFAULT_PROVIDER})
${Object.values(PROVIDERS)
  .map((p) => `  ${p.id.padEnd(12)} ${(p.credentialEnv ?? "키 불필요").padEnd(22)} ${p.label}`)
  .join("\n")}
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      size: { type: "string" },
      res: { type: "string" },
      symmetry: { type: "boolean" },
      method: { type: "string" },
      rounding: { type: "string" },
      smoothing: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      json: { type: "string" },
      dir: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
      front: { type: "string" },
      back: { type: "string" },
      left: { type: "string" },
      right: { type: "string" },
      top: { type: "string" },
    },
  });

  const command = positionals[0];
  if (values.help === true || command === undefined || command === "help") {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  const outDirectory = resolve(values.out ?? "out");
  const size = values.size === undefined ? undefined : Number.parseInt(values.size, 10);
  if (size !== undefined && (!Number.isFinite(size) || size < 64 || size > 4096)) {
    throw new Error("--size는 64~4096 사이여야 합니다.");
  }
  const renderOptions = size === undefined ? {} : { size };

  switch (command) {
    case "demo": {
      const render = await renderToDirectory(demoMesh(), outDirectory, renderOptions);
      process.stdout.write(`${VIEW_IDS.length}면 렌더 저장: ${render.directory}\n\n`);
      const report = await analyzeViewSet(render.paths);
      process.stdout.write(`${formatReport(report)}\n`);
      await maybeWriteJson(values.json, report);
      return report.verdict === "fail" ? 2 : 0;
    }

    case "synthetic": {
      await mkdir(outDirectory, { recursive: true });
      for (const [id, mesh] of Object.entries(syntheticFixtures())) {
        const directory = resolve(outDirectory, id);
        await renderToDirectory(mesh, directory, renderOptions);
        await writeFile(resolve(directory, "truth.glb"), writeGlb(mesh));
        process.stdout.write(`${id}: ${directory}\n`);
      }
      return 0;
    }

    case "render": {
      const meshPath = positionals[1];
      if (!meshPath) throw new Error("메시 경로가 필요합니다: sixview render <mesh.glb>");
      const { render, report } = await renderAndAnalyze(resolve(meshPath), outDirectory, renderOptions);
      process.stdout.write(`${VIEW_IDS.length}면 렌더 저장: ${render.directory}\n\n${formatReport(report)}\n`);
      await maybeWriteJson(values.json, report);
      return report.verdict === "fail" ? 2 : 0;
    }

    case "analyze": {
      const directory = positionals[1];
      const paths = await collectViewPaths(directory, values);
      if (Object.keys(paths).length === 0) {
        throw new Error(
          `분석할 뷰를 찾지 못했습니다. 디렉터리에 ${VIEW_IDS.map((id) => `${id}.png`).join(", ")}을 두거나 --front 등으로 직접 지정하세요.`,
        );
      }
      const report = await analyzeViewSet(paths, directory ? await loadTransforms(resolve(directory)) : {});
      process.stdout.write(`${formatReport(report)}\n`);
      await maybeWriteJson(values.json, report);
      return report.verdict === "fail" ? 2 : 0;
    }

    case "build": {
      const directory = positionals[1];
      const paths = await collectViewPaths(directory, values);
      if (Object.keys(paths).length === 0) {
        throw new Error(
          `복원할 뷰를 찾지 못했습니다. 디렉터리에 ${VIEW_IDS.map((id) => `${id}.png`).join(", ")}을 두거나 --front 등으로 직접 지정하세요.`,
        );
      }
      const resolution = values.res === undefined ? undefined : Number.parseInt(values.res, 10);
      if (resolution !== undefined && (!Number.isFinite(resolution) || resolution < 32 || resolution > 384)) {
        throw new Error("--res는 32~384 사이여야 합니다.");
      }
      const smoothing = values.smoothing === undefined ? undefined : Number.parseInt(values.smoothing, 10);
      const method = values.method ?? "silhouette";
      if (method !== "silhouette" && method !== "geometry" && method !== "ai" && method !== "hybrid") {
        throw new Error("--method는 silhouette, geometry, ai 또는 hybrid입니다.");
      }
      const result = await reconstructFromViews(paths, directory ? await loadTransforms(resolve(directory)) : {}, {
        outputDirectory: values.out ? outDirectory : resolve(directory ?? "out"),
        method,
        ...(values.provider ? { provider: values.provider } : {}),
        ...(resolution === undefined ? {} : { resolution }),
        ...(smoothing === undefined || !Number.isFinite(smoothing) ? {} : { smoothing }),
        symmetry: values.symmetry === true,
        rounding: values.rounding === undefined ? 0 : Math.min(1, Math.max(0, Number.parseFloat(values.rounding) || 0)),
        onProgress: (message: string) => process.stderr.write(`· ${message}\n`),
      });
      const scores = (label: string, e: { score: number; shapeScore?: number; textureScore?: number; colourScore: number; comparisons: ReadonlyArray<{ id: string; iou: number; colour: number }> }): string =>
        `  ${label} 외곽 ${(e.score * 100).toFixed(1)}%` +
        (e.shapeScore === undefined ? "" : ` · 형상 ${(e.shapeScore * 100).toFixed(1)}%`) +
        (e.textureScore === undefined ? "" : ` · 텍스처 ${(e.textureScore * 100).toFixed(1)}%`) +
        ` · 색 충돌 일관성 ${(e.colourScore * 100).toFixed(1)}% — ` +
        e.comparisons.map((c) => `${c.id} ${(c.iou * 100).toFixed(0)}/${(c.colour * 100).toFixed(0)}`).join(" · ");
      process.stdout.write(
        `${formatReport(result.report)}\n\n복원 결과 (${result.method}, 해상도 ${result.resolution})\n` +
          (result.strategy ? `  선택 후보 ${result.strategy}\n` : "") +
          (result.warning ? `  [경고] ${result.warning}\n` : "") +
          `  삼각형 ${(result.mesh.indices.length / 3).toLocaleString()}개\n` +
          `  메시 연결성 ${result.meshQuality.components}개 · 경계 ${result.meshQuality.boundaryEdges} · 비다양체 ${result.meshQuality.nonManifoldEdges} · 자기교차 ${result.meshQuality.selfIntersections ?? "검사 한도 초과"}\n` +
          (result.generated ? `${scores(`AI 원본(회전 ${result.generated.yaw}°)`, result.generated)}\n` : "") +
          `${scores("결과", result)}\n` +
          `  ${result.files.glb}\n  ${result.files.obj}\n  ${result.files.voxels}\n  재렌더: ${result.files.renders}\n`,
      );
      await maybeWriteJson(values.json, {
        report: result.report,
        method: result.method,
        comparisons: result.comparisons,
        score: result.score,
        colourScore: result.colourScore,
        ...(result.generated ? { generated: result.generated } : {}),
      });
      return result.report.verdict === "fail" ? 2 : 0;
    }

    case "run": {
      const inputs = positionals.slice(1).map((path) => resolve(path));
      const [first] = inputs;
      const directory = first !== undefined && (await stat(first)).isDirectory() ? first : undefined;
      const paths = await collectViewPaths(directory, values);
      // Loose images are taken in canonical order: front, back, left, right, top.
      if (!directory) inputs.slice(0, VIEW_IDS.length).forEach((path, i) => (paths[VIEW_IDS[i] ?? "front"] = path));
      if (!paths.front) {
        throw new Error("front 이미지가 필요합니다: sixview run <dir> | <front.png> [back.png] [left.png] [right.png] [top.png]");
      }
      const result = await runFromViews(paths, directory ? await loadTransforms(directory) : {}, {
        ...renderOptions,
        provider: values.provider ?? DEFAULT_PROVIDER,
        model: values.model,
        outputDirectory: outDirectory,
        onProgress: (message: string) => process.stderr.write(`· ${message}\n`),
      });
      process.stdout.write(
        `입력\n${formatReport(result.inputReport)}\n\n메시: ${result.meshPath}\n결과 렌더: ${result.render.directory}\n\n${formatReport(result.report)}\n`,
      );
      await maybeWriteJson(values.json, { input: result.inputReport, result: result.report });
      return result.report.verdict === "fail" ? 2 : 0;
    }

    case "serve": {
      const port = values.port === undefined ? 5173 : Number.parseInt(values.port, 10);
      const directory = resolve(values.dir ?? outDirectory);
      const server = await startServer({ port, directory });
      process.stdout.write(
        `웹 미리보기: ${server.url}\n` +
          `3D 뷰어: ${server.url}viewer\n` +
          `뷰 디렉터리: ${directory}\n종료: Ctrl+C\n`,
      );
      const { promise } = Promise.withResolvers<number>();
      return promise; // Serves until the process is interrupted.
    }

    default:
      process.stderr.write(`알 수 없는 명령 '${command}'.\n\n${USAGE}`);
      return 1;
  }
}

async function collectViewPaths(
  directory: string | undefined,
  values: Partial<Record<string, string | boolean>>,
): Promise<ViewPaths> {
  const paths: ViewPaths = directory ? await viewPathsFromDirectory(resolve(directory)) : {};
  for (const id of VIEW_IDS) {
    const explicit = values[id];
    if (typeof explicit === "string") paths[id] = resolve(explicit);
  }
  return paths;
}

async function maybeWriteJson(target: string | undefined, report: unknown): Promise<void> {
  if (!target) return;
  await writeFile(resolve(target), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`\nJSON 저장: ${resolve(target)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`오류: ${message}\n`);
      process.exitCode = 1;
    });
}

export { main };
