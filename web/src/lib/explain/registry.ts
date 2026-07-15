// Explain engine — registry of kinds, copy-as-data, and the derived ordering.
//
// EXPLAIN-ADR §4 (ExplainKind), Appendix A (copy), D4/D5/D7 (ordering + forks).
// This module is pure (no React, no DOM): the engine renders `copy` verbatim,
// so all editorial rules (no em-dashes) live here as data. Two programs consume
// it — first-run (editorialises) and Explain (describes) — sharing the kinds.

// ---------------------------------------------------------------------------
// Kinds (§4). Twelve; `vessel.numeral`/`source.volume`/`card.pip` are cut or
// parked. Reserved `[next]` kinds (menu-open, pane interiors) ship no copy and
// no registration, so they are not in this union yet.
// ---------------------------------------------------------------------------

export type ExplainKind =
  // singletons
  | "floor"
  | "disc"
  // per-feed instance + tagged leaves
  | "vessel"
  | "vessel.name"
  | "vessel.gear"
  | "vessel.hide"
  | "vessel.addSource"
  | "vessel.resize"
  // card kinds — one representative instance in the sequence (D5), all
  // instances hover-discoverable
  | "card"
  | "card.byline"
  | "card.reply"
  | "card.quote";

export const EXPLAIN_KINDS: readonly ExplainKind[] = [
  "floor",
  "disc",
  "vessel",
  "vessel.name",
  "vessel.gear",
  "vessel.hide",
  "vessel.addSource",
  "vessel.resize",
  "card",
  "card.byline",
  "card.reply",
  "card.quote",
] as const;

// ---------------------------------------------------------------------------
// Explain-program labels — Appendix A.2 / A.3, verbatim.
//
// `vessel` forks on starter provenance (D7), so it is NOT in this record; use
// explainVesselLabel(fromStarter). Every other kind has one fixed label.
// ---------------------------------------------------------------------------

export const EXPLAIN_LABELS: Record<Exclude<ExplainKind, "vessel">, string> = {
  floor:
    "This space is yours to fill with feeds. You can have as many as you want, configured as you like and positioned however suits you. They stay where they are put.",
  // disc anchors to the About button (D3): leads with About, then notes the
  // menu role the corner resumes once Explain closes.
  disc:
    "Right now this opens About: a fuller account of what all.haus is and how it works. When Explain is off, this same corner is the ∀ menu, where everything runs from: writing, searching, your messages, your money, your settings. There is no other interface to learn.",
  "vessel.name":
    "This is the feed's name. Click to rename it and manage its sources, or click and drag to move the feed container around this workspace.",
  "vessel.gear":
    "Each feed's individual settings live behind this button: renaming, appearance, the full list of sources, and deletion.",
  "vessel.hide":
    "This hides the feed without destroying it. Restore a hidden one from the menu at any time.",
  "vessel.addSource":
    "Type here to add a source: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. It all arrives in the same place.",
  "vessel.resize": "Drag this corner to make the feed bigger or smaller.",
  card: "This is one item from one of the feed's sources, shown in the order it arrived.",
  "card.byline":
    "Hover over the name to follow this person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute.",
  "card.reply":
    "This posts a reply, which appears in the thread underneath the original.",
  "card.quote":
    "This quotes the item into a post of your own, so you can add your thoughts on top. The original stays attached and attributed.",
};

// vessel label forks on provenance (D7): the Billy Island copy renders only on
// the actual starter clone; every other feed gets the neutral variant.
export function explainVesselLabel(fromStarter: boolean): string {
  return fromStarter
    ? "A feed is a list of sources plus the weights you have given them. To get you started, this one is copied from a feed belonging to Billy Island, founder of all.haus. For better or worse, it reflects his interests. Change what's in it, or delete it if you want to start fresh."
    : "A feed is a list of sources plus the weights you have given them. Change what's in it, or delete it if you want to start fresh.";
}

// Resolve any Explain label, folding the vessel fork in. `fromStarter` is only
// consulted for `vessel`.
export function explainCopy(kind: ExplainKind, fromStarter = false): string {
  return kind === "vessel"
    ? explainVesselLabel(fromStarter)
    : EXPLAIN_LABELS[kind];
}

// ---------------------------------------------------------------------------
// First-run program — Appendix A.1, six beats, verbatim.
//
// Beat 1 forks on provenance (D7); beat 6 carries the "done" affordance and two
// paragraphs. Beats 1-4 anchor to their kind where it exists, free-float centred
// where it does not (D8); beats 5-6 are floor beats and always free-float.
// ---------------------------------------------------------------------------

export interface FirstRunBeat {
  kind: ExplainKind;
  copy: string;
  // D8: beats 5-6 always free-float over the floor; beats 1-4 anchor if their
  // target exists and free-float centred otherwise (resolved at open()).
  alwaysFloat?: boolean;
  // Beat 6 carries the explicit dismiss affordance (§6).
  done?: boolean;
}

function firstRunVesselCopy(fromStarter: boolean): string {
  return fromStarter
    ? "This is a feed: a list of sources plus the weights you have given them. This one is copied from a feed belonging to Billy Island, founder of all.haus, and for better or worse it reflects his interests. It's yours now. Change it or delete it as you see fit."
    : "This is a feed: a list of sources plus the weights you have given them. It's yours to change or delete as you see fit.";
}

// The full six-beat sequence, resolving the provenance fork for beat 1.
export function firstRunBeats(fromStarter: boolean): FirstRunBeat[] {
  return [
    { kind: "vessel", copy: firstRunVesselCopy(fromStarter) },
    {
      kind: "vessel.addSource",
      copy: "You can add a source here: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. Everything arrives in one place and reads the same way, so you don't need a separate app for each.",
    },
    {
      kind: "card.byline",
      copy: "Hover over a name to follow that person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute. The mixing is done by you, not for you.",
    },
    {
      kind: "disc",
      copy: "This is About: the full account of what all.haus is and how it works, worth reading once. The rest of the time, this same corner is your menu, the one place everything runs from: writing, searching, your messages, your money, your settings. There is no other interface to learn.",
    },
    {
      kind: "floor",
      copy: "Make as many feeds as you like and arrange them however suits you. They stay where they are put.",
      alwaysFloat: true,
    },
    {
      kind: "floor",
      copy: "There is no algorithm here. Your feeds run in order of time, weighted by you and answerable to nobody else. Whatever you publish lives on an open protocol and remains yours wherever you take it. The public square should not have a landlord.\n\nYou can press Explain at any time to be shown how anything works.",
      alwaysFloat: true,
      done: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Derived Explain ordering (§4, D4/D5).
//
//   floor → per-vessel (vessel, then its leaves) by sort_rank → card kinds
//   (one representative instance) → disc last.
//
// Pure over a minimal shape; the resolver (later slice) maps each step to a live
// DOM rect via the registration Map + `[data-explain]` query.
// ---------------------------------------------------------------------------

// The per-vessel leaf order — the vessel root first, then its tagged leaves.
export const VESSEL_LEAF_ORDER: readonly ExplainKind[] = [
  "vessel",
  "vessel.name",
  "vessel.gear",
  "vessel.hide",
  "vessel.addSource",
  "vessel.resize",
] as const;

// Card kinds contribute one representative sequential annotation each (D5).
export const CARD_KIND_ORDER: readonly ExplainKind[] = [
  "card",
  "card.byline",
  "card.reply",
  "card.quote",
] as const;

export interface SequenceStep {
  kind: ExplainKind;
  // vessel + leaf steps carry the feedId they belong to; floor/disc/card kinds
  // (D5 representative) carry none.
  key?: string;
}

// Build the sequential Explain program from the vessels present at open().
// `vessels` are the registered vessel roots (feedId + sort_rank); `hasCards`
// gates the representative card kinds (D5: omitted, hover-only, if no vessel has
// cards).
export function buildExplainSequence(
  vessels: { key: string; order: number }[],
  hasCards: boolean,
): SequenceStep[] {
  const steps: SequenceStep[] = [{ kind: "floor" }];
  const sorted = [...vessels].sort((a, b) => a.order - b.order);
  for (const v of sorted) {
    for (const kind of VESSEL_LEAF_ORDER) steps.push({ kind, key: v.key });
  }
  if (hasCards) {
    for (const kind of CARD_KIND_ORDER) steps.push({ kind });
  }
  steps.push({ kind: "disc" });
  return steps;
}
