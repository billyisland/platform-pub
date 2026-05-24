"use client";

import { useState } from "react";

interface PollOption {
  title: string;
  votesCount: number;
}

interface PollDisplayProps {
  poll: {
    options: PollOption[];
    multiple: boolean;
    expiresAt: string | null;
    closed: boolean;
  };
  canVote: boolean;
  onVote: (choices: number[]) => void;
  voting: boolean;
}

export function PollDisplay({
  poll,
  canVote,
  onVote,
  voting,
}: PollDisplayProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const totalVotes = poll.options.reduce((s, o) => s + o.votesCount, 0);
  const showResults = poll.closed || !canVote;

  function toggleOption(index: number) {
    if (!canVote || voting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        if (!poll.multiple) next.clear();
        next.add(index);
      }
      return next;
    });
  }

  return (
    <div className="mt-2 space-y-1.5">
      {poll.options.map((opt, i) => {
        const pct =
          totalVotes > 0 ? Math.round((opt.votesCount / totalVotes) * 100) : 0;
        const isSelected = selected.has(i);

        return (
          <button
            key={i}
            type="button"
            disabled={!canVote || voting || poll.closed}
            onClick={() => toggleOption(i)}
            className="relative w-full text-left rounded px-3 py-1.5 overflow-hidden border transition-colors"
            style={{
              borderColor: isSelected ? "#B5242A" : "#ddd",
              cursor:
                canVote && !voting && !poll.closed ? "pointer" : "default",
            }}
          >
            {showResults && (
              <div
                className="absolute inset-0 rounded"
                style={{
                  width: `${pct}%`,
                  backgroundColor: "rgba(0,0,0,0.06)",
                  transition: "width 0.3s ease",
                }}
              />
            )}
            <div className="relative flex items-center justify-between gap-2">
              <span className="text-ui-xs flex items-center gap-2">
                {canVote && !poll.closed && (
                  <span
                    className="inline-block w-3.5 h-3.5 border border-grey-400 flex-shrink-0"
                    style={{
                      borderRadius: poll.multiple ? "2px" : "50%",
                      backgroundColor: isSelected ? "#B5242A" : "transparent",
                      borderColor: isSelected ? "#B5242A" : undefined,
                    }}
                  />
                )}
                {opt.title}
              </span>
              {showResults && (
                <span className="label-ui text-grey-400 flex-shrink-0">
                  {pct}%
                </span>
              )}
            </div>
          </button>
        );
      })}

      <div className="flex items-center gap-3 mt-2">
        {canVote && !poll.closed && (
          <button
            type="button"
            className="label-ui"
            style={{
              color: selected.size > 0 && !voting ? "#B5242A" : "#999",
              background: "none",
              border: "none",
              padding: 0,
              cursor: selected.size > 0 && !voting ? "pointer" : "default",
            }}
            disabled={selected.size === 0 || voting}
            onClick={() => onVote(Array.from(selected))}
          >
            {voting ? "VOTING..." : "VOTE"}
          </button>
        )}
        <span className="label-ui text-grey-400">
          {totalVotes} {totalVotes === 1 ? "VOTE" : "VOTES"}
        </span>
        {poll.closed && (
          <span className="label-ui text-grey-400">POLL CLOSED</span>
        )}
        {!poll.closed && poll.expiresAt && (
          <span className="label-ui text-grey-400">
            ENDS {new Date(poll.expiresAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
