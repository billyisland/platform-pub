---
name: Feed rules in settings
description: Plan to replace feed tabs with user-configurable feed rules in settings
type: project
---

Feed tab bar (For You / Following) removed 2026-04-04. Currently showing global feed to everyone by default.

**Why:** The Following tab was broken (showing empty despite 30+ follows), and the tab bar created visual clutter against the NoteComposer. The two-tab model wasn't doing useful work.

**How to apply:** When implementing feed customisation, build it as user-defined rules in Settings rather than restoring fixed tabs. The feed should remain a single stream with filtering/ranking controlled by the user's preferences.
