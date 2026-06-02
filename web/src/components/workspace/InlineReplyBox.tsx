"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { LinkedAccount } from "../../lib/api/linked-accounts";
import { externalItems } from "../../lib/api/external-items";

const PROTOCOL_LABELS: Record<string, string> = {
  atproto: "BLUESKY",
  activitypub: "MASTODON",
  nostr_external: "NOSTR",
};

const MAX_CHARS = 1000;

interface Props {
  itemId: string;
  protocol: string;
  linkedAccount: LinkedAccount | null;
  onClose: () => void;
  onReplied: () => void;
}

export function InlineReplyBox({
  itemId,
  protocol,
  linkedAccount,
  onClose,
  onReplied,
}: Props) {
  const [content, setContent] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const autoGrow = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  async function handleSubmit() {
    if (!linkedAccount || !content.trim() || publishing) return;
    setPublishing(true);
    setError(null);
    try {
      await externalItems.reply(itemId, linkedAccount.id, content.trim());
      onReplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reply");
      setPublishing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  if (!linkedAccount) {
    return (
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-3 py-3 px-4 border border-grey-200 rounded"
      >
        <p className="text-ui-xs text-grey-500">
          Connect your {PROTOCOL_LABELS[protocol] ?? protocol} account to reply.{" "}
          <a href="/settings" className="underline text-black">
            Settings →
          </a>
        </p>
      </div>
    );
  }

  const platformLabel = PROTOCOL_LABELS[protocol] ?? protocol.toUpperCase();
  const remaining = MAX_CHARS - content.length;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="mt-3 border border-grey-200 rounded overflow-hidden"
    >
      <div className="px-3 py-2 flex items-center justify-between border-b border-grey-100">
        <span className="label-ui text-grey-400">
          REPLYING VIA {platformLabel}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-grey-400 hover:text-black text-[16px] leading-none"
          aria-label="Close reply"
        >
          ×
        </button>
      </div>

      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          autoGrow();
        }}
        onKeyDown={handleKeyDown}
        placeholder="Write a reply…"
        maxLength={MAX_CHARS}
        rows={2}
        className="w-full px-3 py-2 text-ui-sm resize-none outline-none bg-transparent"
        disabled={publishing}
      />

      <div className="px-3 py-2 flex items-center justify-between border-t border-grey-100">
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-ui-xs" style={{ color: "#B5242A" }}>
              {error}
            </span>
          )}
          {remaining <= 100 && (
            <span
              className="label-ui"
              style={{ color: remaining <= 0 ? "#B5242A" : "#999" }}
            >
              {remaining}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!content.trim() || content.length > MAX_CHARS || publishing}
          className="label-ui px-3 py-1 rounded disabled:opacity-40"
          style={{
            background: "#111",
            color: "#fff",
          }}
        >
          {publishing ? "SENDING…" : "REPLY"}
        </button>
      </div>
    </div>
  );
}
