import type { ReactNode } from "react";

export function Modal({
  title, children, onClose, footer, width = 460,
}: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; width?: number }) {
  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          {title}
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
