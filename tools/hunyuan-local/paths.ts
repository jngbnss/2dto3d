import { join, resolve } from "node:path";

/** Git-ignored install root for the local AI server. */
export const ROOT = resolve(import.meta.dirname, "..", "..", "local-ai");
export const REPO = join(ROOT, "Hunyuan3D-2");
export const VENV = join(ROOT, ".venv");
export const PYTHON = join(VENV, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
export const SERVER = join(import.meta.dirname, "server.py");
