import { createContext, useContext } from "react";
import type { CADRenderer } from "../render/renderer";
import type { CADGeometryEngine } from "../engine/geometryEngine";

export interface WorkspaceContextValue {
  renderer: CADRenderer | null;
  engine: CADGeometryEngine;
  kernelReady: boolean;
  kernelError: string | null;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside the CAD workspace");
  return ctx;
}
