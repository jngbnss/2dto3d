import { useProjectStore } from "../core/projectStore";
import { formatVolume } from "../core/units";

export function StatusBar({ kernelReady, kernelError }: { kernelReady: boolean; kernelError: string | null }) {
  const doc = useProjectStore((s) => s.doc);
  const selection = useProjectStore((s) => s.selection);
  const status = useProjectStore((s) => s.status);
  const busy = useProjectStore((s) => s.busy);
  const geometry = useProjectStore((s) => s.geometry);
  const buildErrors = useProjectStore((s) => s.buildErrors);
  const dirty = useProjectStore((s) => s.dirty);

  const selected = selection.length === 1 ? doc.objects[selection[0]] : null;
  const stats = selected ? geometry[selected.id] : null;
  const errorCount = Object.keys(buildErrors).length;

  return (
    <footer className={`statusbar statusbar--${status.level}`}>
      <span className="statusbar__item statusbar__item--msg">
        {kernelError ? `Kernel: ${kernelError}` : status.text}
      </span>
      <span className="statusbar__spacer" />
      {errorCount > 0 ? <span className="statusbar__item statusbar__item--err">{errorCount} build error(s)</span> : null}
      <span className="statusbar__item">
        {selection.length === 0
          ? "No selection"
          : selection.length === 1 && selected
            ? `${selected.name} · ${selected.kind === "solid" ? "CAD solid" : selected.kind === "mesh" ? "mesh" : "group"}`
            : `${selection.length} selected`}
      </span>
      {stats ? <span className="statusbar__item">{formatVolume(stats.volume, doc.displayUnit)}</span> : null}
      <span className="statusbar__item">{busy > 0 ? `Kernel working (${busy})…` : kernelReady ? "Kernel ready" : "Kernel starting…"}</span>
      <span className="statusbar__item">{dirty ? "Unsaved changes" : "Saved"}</span>
      <span className="statusbar__item">Unit: {doc.displayUnit}</span>
    </footer>
  );
}
