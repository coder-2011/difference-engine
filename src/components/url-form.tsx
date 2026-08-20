"use client";

import { CornerDownLeft } from "lucide-react";
import { useEffect, useRef } from "react";

type UrlFormProps = {
  action: (formData: FormData) => Promise<void>;
};

/** True when the key event originated in a field that should keep the typed character. */
function isEditingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable
      || target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement);
}

/** Launches a GitHub URL or pull request request, with T focusing the field immediately. */
export function UrlForm({ action }: UrlFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    /** Focuses the launcher as soon as T is pressed outside another editor. */
    function focusSearch(event: KeyboardEvent): void {
      const isT = event.key === "t" || event.key === "T" || event.code === "KeyT";
      if (!isT || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditingTarget(event.target)) return;

      event.preventDefault();
      inputRef.current?.focus();
    }

    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <form className="url-form" action={action}>
      <span className="url-prompt" aria-hidden="true">›</span>
      <div className="url-field">
        <input
          ref={inputRef}
          name="url"
          type="text"
          required
          aria-label="GitHub URL or pull request request"
          placeholder="paste a github url or type what you want open"
        />
        <kbd className="url-key-hint" aria-hidden="true">T</kbd>
      </div>
      <button aria-label="Open diff"><CornerDownLeft size={13} /><span>to open</span></button>
    </form>
  );
}
