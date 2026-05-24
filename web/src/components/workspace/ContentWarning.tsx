"use client";

import { useState, type ReactNode } from "react";

interface ContentWarningProps {
  warningText: string;
  children: ReactNode;
}

export function ContentWarning({ warningText, children }: ContentWarningProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <span className="label-ui text-grey-400">{warningText}</span>
        <button
          type="button"
          className="btn-text-muted"
          onClick={() => setRevealed((r) => !r)}
        >
          {revealed ? "HIDE CONTENT" : "SHOW CONTENT"}
        </button>
      </div>
      {revealed && children}
    </div>
  );
}
