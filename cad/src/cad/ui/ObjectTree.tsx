import { useState } from "react";
import { useProjectStore } from "../core/projectStore";
import {
  childrenOf, duplicateObjects, groupObjects, removeObjects, renameObject,
  reparent, setVisible, topLevelOf, ungroup,
} from "../core/objectManager";
import type { CadObject } from "../core/types";

const KIND_ICON: Record<CadObject["kind"], string> = { solid: "◧", mesh: "△", group: "▣" };

export function ObjectTree() {
  const doc = useProjectStore((s) => s.doc);
  const selection = useProjectStore((s) => s.selection);
  const commit = useProjectStore((s) => s.commit);
  const select = useProjectStore((s) => s.select);
  const toggleSelect = useProjectStore((s) => s.toggleSelect);
  const setStatus = useProjectStore((s) => s.setStatus);
  const buildErrors = useProjectStore((s) => s.buildErrors);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const roots = childrenOf(doc, null);

  const doGroup = () => {
    if (selection.length < 1) return;
    commit("Group objects", (draft) => {
      const group = groupObjects(draft, selection);
      if (!group) throw new Error("Nothing to group");
    }, { log: `group ${selection.length} objects`, ids: selection });
  };

  const doUngroup = () => {
    const groups = selection.filter((id) => doc.objects[id]?.kind === "group");
    if (!groups.length) {
      setStatus("warn", "Select a group to ungroup");
      return;
    }
    commit("Ungroup", (draft) => {
      for (const id of groups) ungroup(draft, id);
    }, { log: `ungroup ${groups.length}`, ids: groups });
  };

  return (
    <aside className="panel panel--left">
      <header className="panel__header">
        Objects
        <span className="panel__count">{Object.keys(doc.objects).length}</span>
      </header>
      <div className="panel__toolbar">
        <button type="button" className="btn btn--sm" disabled={selection.length === 0} onClick={doGroup}>Group</button>
        <button type="button" className="btn btn--sm" disabled={selection.length === 0} onClick={doUngroup}>Ungroup</button>
        <button
          type="button" className="btn btn--sm" disabled={selection.length === 0}
          onClick={() => commit("Duplicate", (draft) => {
            const ids = duplicateObjects(draft, topLevelOf(draft, selection).map((o) => o.id), [20, 0, 0]);
            if (!ids.length) throw new Error("Nothing to duplicate");
          }, { log: `duplicate ${selection.length}`, ids: selection })}
        >
          Duplicate
        </button>
        <button
          type="button" className="btn btn--sm btn--danger" disabled={selection.length === 0}
          onClick={() => {
            const ids = [...selection];
            commit("Delete objects", (draft) => removeObjects(draft, ids), { log: `delete ${ids.length}`, ids });
            select([]);
          }}
        >
          Delete
        </button>
      </div>
      <div
        className="panel__scroll tree"
        onDragOver={(e) => {
          if (dragId) e.preventDefault();
        }}
        onDrop={() => {
          if (!dragId) return;
          commit("Move to root", (draft) => reparent(draft, dragId, null));
          setDragId(null);
        }}
      >
        {roots.length === 0 ? (
          <div className="panel__empty">No objects yet. Create a shape from the toolbar.</div>
        ) : null}
        {roots.map((object) => (
          <TreeRow
            key={object.id}
            object={object}
            depth={0}
            doc={doc}
            selection={selection}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            dragId={dragId}
            setDragId={setDragId}
            hasError={Boolean(buildErrors[object.id])}
            onSelect={toggleSelect}
            onRename={(id, name) => commit("Rename object", (draft) => renameObject(draft, id, name))}
            onToggleVisible={(id, visible) => commit(visible ? "Show object" : "Hide object", (draft) => setVisible(draft, id, visible))}
            onReparent={(id, parentId) => commit("Reparent", (draft) => reparent(draft, id, parentId))}
          />
        ))}
      </div>
    </aside>
  );
}

interface RowProps {
  object: CadObject;
  depth: number;
  doc: ReturnType<typeof useProjectStore.getState>["doc"];
  selection: string[];
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  dragId: string | null;
  setDragId: (id: string | null) => void;
  hasError: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onRename: (id: string, name: string) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  onReparent: (id: string, parentId: string | null) => void;
}

function TreeRow(props: RowProps) {
  const { object, depth, doc, selection, renamingId, setRenamingId, dragId, setDragId } = props;
  const children = childrenOf(doc, object.id);
  const selected = selection.includes(object.id);
  const buildErrors = useProjectStore((s) => s.buildErrors);

  return (
    <div className="tree__node">
      <div
        className={`tree__row${selected ? " tree__row--active" : ""}${props.hasError ? " tree__row--error" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable
        onDragStart={(e) => {
          setDragId(object.id);
          e.stopPropagation();
        }}
        onDragOver={(e) => {
          if (dragId && dragId !== object.id && object.kind === "group") {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onDrop={(e) => {
          if (dragId && dragId !== object.id && object.kind === "group") {
            e.preventDefault();
            e.stopPropagation();
            props.onReparent(dragId, object.id);
            setDragId(null);
          }
        }}
        onClick={(e) => props.onSelect(object.id, e.shiftKey || e.ctrlKey || e.metaKey)}
        onDoubleClick={() => setRenamingId(object.id)}
      >
        <button
          type="button"
          className="tree__eye"
          title={object.visible ? "Hide" : "Show"}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleVisible(object.id, !object.visible);
          }}
        >
          {object.visible ? "👁" : "🚫"}
        </button>
        <span className="tree__icon" style={{ color: object.color }}>{KIND_ICON[object.kind]}</span>
        {renamingId === object.id ? (
          <input
            className="tree__rename"
            autoFocus
            defaultValue={object.name}
            onBlur={(e) => {
              props.onRename(object.id, e.target.value);
              setRenamingId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenamingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="tree__name">{object.name}</span>
        )}
        {buildErrors[object.id] ? <span className="tree__flag" title={buildErrors[object.id]}>!</span> : null}
        <span className="tree__kind">{object.kind === "solid" ? "SOLID" : object.kind === "mesh" ? "MESH" : ""}</span>
      </div>
      {children.map((child) => (
        <TreeRow {...props} key={child.id} object={child} depth={depth + 1} hasError={Boolean(buildErrors[child.id])} />
      ))}
    </div>
  );
}
