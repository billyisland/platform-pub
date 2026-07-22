# all.haus ∀ disc — brand assets

Canonical geometry: apex kisses the bottom rim, feet meet the top rim flush
(see FORALL-CUT-AND-LOCKUP-ADR §III.1). Disc ink #1A1A18, ground bone #F0EFEB.

This is the geometry of **every** disc instance, not just these exports: as of
2026-07-22 the live ForallMenu trigger and `favicon.svg` carry it too (ported by
28/94 into their 56-unit frame). It is narrower than the bare `ForAllMark` glyph
(≈16.7° vs ~20.5° splay) because pinning both ends to a rim forces that — a
consequence of the construction, not a second design. Keep these files, the
trigger and the favicon in step; only the bare glyph sits outside it.

- **allhaus-cut.svg / -1024.png** — true cut: ink disc, the ∀ is a real
  transparent hole, transparent outside. Drop onto any known solid ground and the
  ground shows through the letter. The SVG uses a `<mask>`; verify in a browser
  (some rasterisers ignore SVG masks — the PNG is pre-punched and always correct).
- **allhaus-disc-on-bone.svg / -1024.png** — self-contained for **bone** sections:
  ink disc, bone ∀ painted in, transparent outside. Use where you can't/won't mask.
- **allhaus-disc-on-ink.svg / -1024.png** — self-contained for **ink** sections:
  bone disc, ink ∀, transparent outside.
- **proof.png** — the four cases side by side (each asset over its ground, plus the
  cut over both grounds so you can see it vanish on ink and read on bone).

Not for the favicon, Stripe, or images composited on backgrounds you don't control
— those need a painted glyph on a fixed ground, not a hole. See the ADR §II.
