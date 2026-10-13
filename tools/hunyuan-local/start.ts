/**
 * Starts the local Hunyuan3D-2mv server (`npm run ai:local`). Extra arguments
 * pass through, e.g. `npm run ai:local -- --low-vram --port 8091`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PYTHON, REPO, SERVER } from "./paths.ts";

if (!existsSync(PYTHON) || !existsSync(REPO)) {
  console.error("로컬 AI가 설치되지 않았습니다. 먼저 'npm run ai:setup'을 실행하세요.");
  process.exit(1);
}
const child = spawn(PYTHON, ["-u", SERVER, "--repo", REPO, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
