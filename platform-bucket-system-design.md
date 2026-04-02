# Platform: Bucket-Based Categorisation System

## Design Notes — April 2026

---

## The Core Abstraction

A recurring need across Platform's planned features is the ability for users to **manually sort entities (accounts, articles, publication members) into named, non-overlapping categories with behavioural rules attached to each category**. We call these *buckets*.

Every bucket system has:

- A **configurable default** — the policy that applies to the unsorted mass (e.g. "how to handle unsolicited DMs from anyone I haven't explicitly categorised").
- **User-defined buckets** — named, hand-populated subsets, each carrying its own rules.
- **Strict partitioning** — every entity belongs to exactly one bucket at a time. No overlaps, no rule conflicts.

The existing schema already contains two degenerate cases of this pattern: the `blocks` and `mutes` junction tables. These are effectively hardcoded, single-purpose buckets with no user configurability. The generalisation would subsume them.

---

## Where Buckets Apply Across Platform

### DM & Messaging Policy

The founding use case. A writer or reader partitions all other accounts into categories that govern inbound message handling: blocked, free to DM, charged per message (at a set rate), or the default policy for unknown senders.

### Feed Curation

Readers could partition followed writers into named groups ("Tech," "Poetry," "News") that double as custom feed tabs. Strict partitioning is a deliberate constraint here — it forces the user to decide what each writer *primarily* is to them, creating a cleaner mental model than overlapping lists. This is opinionated and elegant rather than flexible.

### Publication Roles

A Publication (federation of writers under a shared subscription) needs to sort its members into role categories: editors, contributors, guest columnists. Each role carries permissions (direct publish vs. approval required), revenue share percentages, and masthead placement. One role per member, no overlap.

### Comment Moderation

Per-writer moderation policy for commenters: trusted (always approved), held for review, or pre-blocked from commenting. Replaces the current boolean `comments_enabled` with something richer.

### Notification Routing

Which followed writers generate push notifications vs. quiet badges vs. nothing? Another partition of accounts into behaviour categories.

### Reader Tiers / Article Access

Writers define named access tiers and assign articles to them. One tier per article, with a price attached. This is the bucket system applied to content rather than accounts.

---

## Where Buckets Don't Apply

**Editorial collections and reading lists** (e.g. "Best of 2026," "Research for my essay," a writer's named series) are *not* bucket problems. They involve multi-membership with no behavioural rules — a piece can belong to several collections simultaneously without conflict.

The test: **if overlapping membership would create a policy conflict, it's a bucket. If it wouldn't, it's a collection.** Collections are a simpler feature (a many-to-many join with a named group) that should exist separately. Keeping the bucket system pure — exclusive, rule-bearing — is what makes it reliable.

---

## Data Model Sketch

The generic model would involve:

- **`buckets`** — `id`, `owner_id`, `entity_type` (account | article | publication_member), `context` (dm_policy | feed_curation | pub_roles | comment_moderation | notification_routing | access_tier), `name`, `colour`, `icon`, `sort_order`, `rules` (JSONB — the behavioural config specific to this context), `is_default` (boolean), `is_system` (boolean, for non-deletable buckets like "Blocked").
- **`bucket_memberships`** — `bucket_id`, `target_id` (polymorphic — account UUID or article UUID), `assigned_at`.
- A **unique constraint** on `(context, owner_id, target_id)` to enforce the strict partition: one bucket per entity per context.

The existing `blocks` and `mutes` tables would migrate to become system-provided buckets within the `dm_policy` context.

---

## UI Design Principles

### Sort at the Moment of Encounter

Borrowed from HEY (Basecamp's email client). When a new sender emails you for the first time, HEY asks you to sort them immediately — into the Imbox, the Feed, or Paper Trail. Each destination has different notification and visibility rules.

For Platform: when someone first DMs you, when a new follower appears, when a writer applies to your Publication — that's the moment to offer the bucket assignment, not as a separate admin chore on a settings page. A small, unobtrusive affordance right in context.

### Mutual Exclusivity at the Data Level

Borrowed from Linear's label groups. Within a label group, only one label can be applied per issue. When you assign a new one, it automatically replaces the old one. No conflict resolution UI needed, because conflicts are structurally impossible.

For Platform: the unique constraint on `(context, owner_id, target_id)` means the UI never has to present a "this account is already in another bucket — what do you want to do?" dialog. Reassignment is a simple swap.

### Same Partition, Multiple Views

Borrowed from Notion's single-select database properties. The same exclusive-membership data can be rendered as a settings list (when configuring rules per bucket), as a kanban board (when actively sorting entities between buckets), or as a filter/tab bar (when browsing the results, e.g. viewing a custom feed).

For Platform: the bucket definitions live in one settings panel. The assignment gesture is sprinkled contextually wherever you encounter entities. And the *consequences* of the partition are felt in feeds, inboxes, and notification behaviour — all driven by the same underlying data.

### One Reusable Component, Many Skins

The interaction grammar should be the same everywhere: create a bucket, name it, configure its rules, assign things to it. The visual presentation changes per context (DM policy settings look different from Publication role management), but the underlying gestures are identical. The user should feel, without being told, that organising their DM rules and organising a Publication's contributor roster are the same kind of action.

---

## Reference Products

| Product | What it does well | What it lacks |
|---|---|---|
| **HEY** (email) | Sorting at moment of encounter; configurable default (the Screener); behavioural rules per bucket | Only three fixed buckets — no user-defined categories |
| **Linear** (project management) | Label groups enforce mutual exclusivity at data level; clean keyboard-driven assignment | Not a social/publishing context; labels are secondary to status |
| **Notion** (databases) | User-defined single-select properties; same data viewable as table, board, calendar, gallery | Feels like infrastructure — you're always building your tool before using it; no behavioural rules attached |
| **Instagram Close Friends** | Single user-defined audience bucket with behavioural consequences (green ring, exclusive content) | Only one custom bucket; no partition of all followers, just an opt-in list |

No existing product combines all three instincts (user-definable buckets + behavioural rules + strict partitioning + moment-of-encounter assignment) into a single reusable component that works across multiple feature contexts.

---

## Open Questions

- **How many buckets before the UI becomes burdensome?** HEY's three-bucket simplicity is part of its appeal. If a user creates fifteen DM policy buckets, the moment-of-encounter sorting becomes a dropdown rather than a quick tap. Consider whether to cap bucket count per context or trust users.
- **Bucket inheritance for Publications.** If a Publication founder defines contributor roles, do individual members see those as buckets within their own account, or are they purely a Publication-level concept?
- **Migration path from existing blocks/mutes.** The current `blocks` and `mutes` tables would become system buckets. Existing data migrates cleanly, but the API surface changes.
- **Nostr representation.** If buckets need to be portable across the federation, they'd need a Nostr event kind. If they're platform-local, they stay in Postgres only. DM policy arguably needs federation; feed curation arguably doesn't.
