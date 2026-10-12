import type { Feature, SolidRecipe, TessellationResult, Transform } from "../core/types";
import { IDENTITY } from "../core/types";
import KernelWorker from "./kernel.worker?worker";
import { featureKey, recipeKey } from "./recipeKey";
import type { ErrorCode, WorkerRequest, WorkerResponse } from "./protocol";

export class GeometryEngineError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = "GeometryEngineError";
    this.code = code;
  }
}

/**
 * `Omit` collapses a discriminated union into a single non-discriminated shape,
 * which would let a malformed request typecheck. Distributing keeps each variant
 * intact minus its id.
 */
type RequestBody = WorkerRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: GeometryEngineError) => void;
  label: string;
}

/**
 * CADGeometryEngine — the main-thread face of the OCCT kernel.
 *
 * Responsibilities:
 *  - own the worker lifecycle (including restart after a hard crash),
 *  - correlate requests/responses,
 *  - memoise tessellation results so that moving an object never rebuilds its
 *    geometry (placement is a renderer concern, shape is a kernel concern),
 *  - never throw asynchronously into the void: every failure is a rejected
 *    promise the UI turns into a status-bar message.
 */
export class CADGeometryEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private resultCache = new Map<string, TessellationResult>();
  private inFlight = new Map<string, Promise<TessellationResult>>();
  private maxResults = 256;
  private bootPromise: Promise<void> | null = null;
  private disposed = false;

  /** Mesh quality, in mm of chord deviation. */
  tolerance = 0.08;
  angularTolerance = 18;

  onCrash: ((message: string) => void) | null = null;

  private ensureWorker(): Worker {
    if (this.disposed) throw new GeometryEngineError("Geometry engine disposed", "KERNEL_INIT");
    if (this.worker) return this.worker;
    const worker = new KernelWorker();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data);
    worker.onerror = (event) => this.fail(event.message || "Geometry worker crashed");
    worker.onmessageerror = () => this.fail("Geometry worker sent an undecodable message");
    this.worker = worker;
    return worker;
  }

  /** Boots the WASM kernel. Safe to call repeatedly. */
  init(): Promise<void> {
    if (!this.bootPromise) {
      this.bootPromise = this.send({ type: "init" }, "kernel init").then(() => undefined);
      this.bootPromise.catch(() => {
        this.bootPromise = null;
      });
    }
    return this.bootPromise;
  }

  private fail(message: string) {
    const err = new GeometryEngineError(message, "KERNEL_INIT");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.inFlight.clear();
    this.worker?.terminate();
    this.worker = null;
    this.bootPromise = null;
    this.onCrash?.(message);
  }

  private receive(res: WorkerResponse) {
    const entry = this.pending.get(res.id);
    if (!entry) return;
    this.pending.delete(res.id);
    if (res.ok) entry.resolve(res);
    else entry.reject(new GeometryEngineError(res.error, res.code));
  }

  private send<T = any>(req: RequestBody, label: string): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, label });
      worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  /**
   * Tessellate a feature in its LOCAL frame. Placement is deliberately excluded
   * so that translating/rotating an object is a pure renderer update.
   */
  async tessellate(feature: Feature): Promise<TessellationResult> {
    const key = `${featureKey(feature)}|t${this.tolerance}|a${this.angularTolerance}`;
    const cached = this.resultCache.get(key);
    if (cached) return cached;
    const running = this.inFlight.get(key);
    if (running) return running;

    const job = this.send<Extract<WorkerResponse, { type: "tessellate" }>>(
      {
        type: "tessellate",
        job: {
          key,
          recipe: { feature, transform: IDENTITY },
          tolerance: this.tolerance,
          angularTolerance: this.angularTolerance,
        },
      },
      "tessellate",
    )
      .then((res) => {
        const r: TessellationResult = {
          positions: res.payload.positions,
          normals: res.payload.normals,
          indices: res.payload.indices,
          edges: res.payload.edges,
          volume: res.payload.volume,
          area: res.payload.area,
          bbox: res.payload.bbox,
          triangleCount: res.payload.triangleCount,
        };
        this.resultCache.set(key, r);
        this.trimResults();
        return r;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, job);
    return job;
  }

  private trimResults() {
    while (this.resultCache.size > this.maxResults) {
      const oldest = this.resultCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.resultCache.delete(oldest);
    }
  }

  /** Validate a feature without building render buffers. */
  async measure(feature: Feature, transform: Transform = IDENTITY): Promise<{ volume: number; area: number }> {
    const res = await this.send<Extract<WorkerResponse, { type: "measure" }>>(
      { type: "measure", recipe: { feature, transform } },
      "measure",
    );
    return { volume: res.volume, area: res.area };
  }

  async exportSTEP(items: { recipe: SolidRecipe; name: string }[]): Promise<string> {
    const res = await this.send<Extract<WorkerResponse, { type: "exportSTEP" }>>(
      { type: "exportSTEP", items },
      "STEP export",
    );
    return res.text;
  }

  async exportSTL(items: { recipe: SolidRecipe; name: string }[], tolerance = this.tolerance): Promise<ArrayBuffer> {
    const res = await this.send<Extract<WorkerResponse, { type: "exportSTL" }>>(
      { type: "exportSTL", items, tolerance },
      "STL export",
    );
    return res.buffer;
  }

  async importSTEP(data: string): Promise<{ assetId: string; solidCount: number }> {
    const res = await this.send<Extract<WorkerResponse, { type: "importSTEP" }>>(
      { type: "importSTEP", data },
      "STEP import",
    );
    return { assetId: res.assetId, solidCount: res.solidCount };
  }

  /** Changes mesh quality and invalidates every cached tessellation. */
  setQuality(tolerance: number, angularTolerance: number) {
    this.tolerance = tolerance;
    this.angularTolerance = angularTolerance;
    this.resultCache.clear();
  }

  dispose() {
    this.disposed = true;
    for (const p of this.pending.values()) {
      p.reject(new GeometryEngineError("Geometry engine disposed", "KERNEL_INIT"));
    }
    this.pending.clear();
    this.inFlight.clear();
    this.resultCache.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

/** One engine per page. Workers are expensive; the kernel is stateless per call. */
let singleton: CADGeometryEngine | null = null;

export function getGeometryEngine(): CADGeometryEngine {
  if (!singleton) singleton = new CADGeometryEngine();
  return singleton;
}

export { recipeKey };
