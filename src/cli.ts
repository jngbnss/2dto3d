#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { VIEW_IDS } from "./views.ts";
import { demoMesh } from "./mesh/primitives.ts";
import { analyzeViewSet, formatReport, type ViewPaths } from "./analyze/report.ts";
import { describeGrid } from "./reconstruct/carve.ts";
import {
  carveFromViews,
  renderAndAnalyze,
  renderToDirectory,
  runFromImage,
  viewPathsFromDirectory,
} from "./pipeline.ts";
import { PROVIDERS } from "./generate/index.ts";
import { startServer } from "./web/server.ts";

const USAGE = `sixview — 2D 이미지 1장에서 6면 뷰를 만들고 3D 복원 적합성을 분석합니다.

사용법
  sixview demo    [--out <dir>] [--size <px>] [--json <file>]
  sixview render  <mesh.glb|obj> [--out <dir>] [--size <px>]
  sixview analyze <dir> | --front a.png --back b.png … [--json <file>]
  sixview carve   <dir> [--obj <file>] [--res <n>] [--tolerance <n>] [--json <file>]
  sixview run     <image> --provider <${Object.keys(PROVIDERS).join("|")}> [--model <id>] [--out <dir>] [--size <px>]
  sixview serve   [--dir <dir>] [--port <n>]

옵션
  --out        결과 디렉터리 (기본 ./out)
  --size       렌더 해상도, 정사각 픽셀 (기본 512)
  --obj        carve 출력 OBJ 경로 (기본 <out>/carved.obj)
  --res        복셀 해상도, 가장 긴 축 기준 (기본 128)
  --tolerance  실루엣 밖으로 벗어나도 허용할 뷰 수 (기본 0)
  --model      공급자 모델 id (기본값은 공급자별 문서 참조)
  --json       분석 결과를 JSON으로 저장

공급자 자격 증명
${Object.values(PROVIDERS)
  .map((p) => `  ${p.id.padEnd(10)} ${p.credentialEnv} — ${p.label}`)
  .join("\n")}
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      size: { type: "string" },
      obj: { type: "string" },
      res: { type: "string" },
      tolerance: { type: "string" },
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
      bottom: { type: "string" },
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
      process.stdout.write(`6면 렌더 저장: ${render.directory}\n\n`);
      const report = await analyzeViewSet(render.paths);
      process.stdout.write(`${formatReport(report)}\n`);
      await maybeWriteJson(values.json, report);
      return report.verdict === "fail" ? 2 : 0;
    }

    case "render": {
      const meshPath = positionals[1];
      if (!meshPath) throw new Error("메시 경로가 필요합니다: sixview render <mesh.glb>");
      const { render, report } = await renderAndAnalyze(resolve(meshPath), outDirectory, renderOptions);
      process.stdout.write(`6면 렌더 저장: ${render.directory}\n\n${formatReport(report)}\n`);
      await maybeWriteJson(values.json, report);
      return report.verdict === "fail" ? 2 : 0;
    }

    case "analyze": {
      const paths = await collectViewPaths(positionals[1], values);
      const provided = Object.keys(paths).length;
      if (provided === 0) {
        throw new Error(
          `분석할 뷰를 찾지 못했습니다. 디렉터리에 ${VIEW_IDS.map((id) => `${id}.png`).join(", ")}을 두거나 --front 등으로 직접 지정하세요.`,
        );
      }
      const report = await analyzeViewSet(paths);
      process.stdout.write(`${formatReport(report)}\n`);
      await maybeWriteJson(values.json, report);
      return report.verdict === "fail" ? 2 : 0;
    }

    case "carve": {
      const paths = await collectViewPaths(positionals[1], values);
      if (Object.keys(paths).length === 0) {
        throw new Error(
          `복원할 뷰를 찾지 못했습니다. 디렉터리에 ${VIEW_IDS.map((id) => `${id}.png`).join(", ")}을 두거나 --front 등으로 직접 지정하세요.`,
        );
      }
      const resolution = values.res === undefined ? undefined : Number.parseInt(values.res, 10);
      if (resolution !== undefined && (!Number.isFinite(resolution) || resolution < 16 || resolution > 512)) {
        throw new Error("--res는 16~512 사이여야 합니다.");
      }
      const objPath = resolve(values.obj ?? join(outDirectory, "carved.obj"));
      const result = await carveFromViews(paths, objPath, {
        ...(resolution === undefined ? {} : { resolution }),
        ...(values.tolerance === undefined ? {} : { tolerance: Number.parseInt(values.tolerance, 10) }),
      });
      process.stdout.write(
        `${formatReport(result.report)}\n\n복원 결과\n  ${describeGrid(result.grid)}\n  면 ${result.mesh.indices.length / 3}개 · 저장 ${result.objPath}\n`,
      );
      await maybeWriteJson(values.json, result.report);
      return result.report.verdict === "fail" ? 2 : 0;
    }

    case "run": {
      const imagePath = positionals[1];
      if (!imagePath) throw new Error("입력 이미지가 필요합니다: sixview run <image.png>");
      const provider = values.provider;
      if (!provider) {
        throw new Error(`--provider가 필요합니다 (${Object.keys(PROVIDERS).join(", ")}).`);
      }
      const result = await runFromImage(resolve(imagePath), {
        ...renderOptions,
        provider,
        model: values.model,
        outputDirectory: outDirectory,
        onProgress: (message) => process.stderr.write(`· ${message}\n`),
      });
      process.stdout.write(
        `메시: ${result.meshPath}\n6면 렌더: ${result.render.directory}\n\n${formatReport(result.report)}\n`,
      );
      await maybeWriteJson(values.json, result.report);
      return result.report.verdict === "fail" ? 2 : 0;
    }

    case "serve": {
      const port = values.port === undefined ? 5173 : Number.parseInt(values.port, 10);
      const directory = resolve(values.dir ?? outDirectory);
      const server = await startServer({ port, directory });
      process.stdout.write(`웹 미리보기: ${server.url}\n뷰 디렉터리: ${directory}\n종료: Ctrl+C\n`);
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
