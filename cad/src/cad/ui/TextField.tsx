import { useEffect, useRef, useState } from "react";

interface Props {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Text input that commits on Enter/blur, never per keystroke.
 *
 * Committing per keystroke would push one undo entry per character, and renaming
 * "Shaft" to "Shaft assembly" would collide with itself mid-word — the
 * uniqueness check fires on the half-typed prefix and rewrites it.
 */
export function TextField({ label, value, onCommit, placeholder, disabled }: Props) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused) setText(value);
  }, [value, focused]);

  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setText(value);
      return;
    }
    if (trimmed !== value) onCommit(trimmed);
  };

  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <span className="field__input">
        <input
          ref={inputRef}
          type="text"
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              setText(value);
              inputRef.current?.blur();
            }
          }}
        />
      </span>
    </label>
  );
}
