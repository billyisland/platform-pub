# Waitlist — lawful basis & purpose note

**CLOSED-BETA-ADR D5.** A draft processing note for the closed-beta waiting
list, to sit beside the existing DPIA for Harper James to review. This is the
_what is stored, why, for how long, how it is used_ line the ADR requires
before or alongside the Phase 2 build. **Draft for legal review — not published
copy.**

**Status:** Draft — 2026-07-24. Written against the shipped Phase 2 code
(migration 162 `waitlist`; `POST /waitlist` in `gateway/src/routes/waitlist.ts`).

---

## What is stored

The `waitlist` table (migration 162) holds, per prospective user:

| Field              | Contents                                                         |
| ------------------ | --------------------------------------------------------------- |
| `email`            | The email address the person entered, lower-cased. Unique.      |
| `publish_interest` | A single boolean — did they tick "I'd also like to publish".     |
| `created_at`       | When they joined the list.                                      |
| `id`               | A random UUID primary key (not derived from any personal data). |

Deliberately **no more personal data than necessary** (data minimisation): no
name, no IP, no marketing profile, no tracking identifiers. The publish-interest
flag is a single unticked opt-in, not a reader/writer classification.

## Lawful basis

**Consent** (UK GDPR Art. 6(1)(a)). The person actively submits their email to a
form headed "Not open yet… Join the list", whose sole stated purpose is to be
contacted when the beta opens. The act of joining _is_ the consent to be
contacted about admission; the publish-interest tick is a further, separable,
freely-given opt-in.

> To confirm with counsel: whether the single "join the list" action is
> sufficient consent for the one narrow purpose below, or whether a separate
> consent checkbox / linked privacy notice is required at the point of capture.
> The current form has no separate consent tick — joining is the consent.

## Purpose (and purpose limitation)

The list is used for **one purpose only**: to invite people to the closed beta in
cohorts as capacity opens, and to contact them about that admission. It is **not**
used for marketing, is **not** shared with third parties, and is **not** combined
with any other dataset. Admitting a waitlister to the platform is a manual action
(CLOSED-BETA-ADR §VII — no automated cohort-invite tooling exists); the list only
_stores_ the interest.

The `publish_interest` flag serves the same single purpose at finer grain: it
lets would-be publishers be invited within a cohort. It is not a commitment by
the person to publish, nor by us to grant publishing.

## Retention

Retain only while the closed beta is running and cohorts are still being drawn
from the list. On one of:

- the person being admitted (their email then lives as an `accounts` row under
  the platform's normal account-data terms — the waitlist row can be deleted);
- the person asking to be removed;
- the beta fully opening / the list being retired,

the corresponding rows are deleted. **To fix with counsel:** a concrete backstop
period (e.g. "deleted no later than N months after the beta opens to the
public") so retention is not open-ended.

## Data-subject rights

- **Erasure / withdrawal of consent:** a person can ask to be taken off the list
  at any time via the contact line (`info@all.haus`). Because consent is the
  basis, withdrawal is straightforward — delete the row.
- **Access / rectification:** the only stored field of substance is their own
  email; honoured via the same contact line.

> Operational note: there is no self-serve "remove me" endpoint in Phase 2 —
> removal is a manual action off `info@all.haus`. If the list grows, a one-click
> unsubscribe in the invitation emails should be added (and would in any case be
> required on those emails).

## Enumeration-safety (why the endpoint cannot leak membership)

`POST /waitlist` returns a **fixed generic acknowledgement** whether the email
is new or already present (the `UNIQUE(email)` constraint makes a repeat an
`ON CONFLICT DO NOTHING` no-op, and the route never branches on the result). So
the waitlist cannot be used to probe **who is already a member or already
waiting** — the same posture as the magic-link login route ("if an account
exists, we've sent a link"). This matters for the members' privacy, not just the
waitlisters': it closes the ADR D5 concern that the waitlist could otherwise leak
existing-membership by response-differencing.

## Open points for counsel

1. Consent sufficiency of the single join action vs. a separate consent tick +
   linked privacy notice at capture.
2. A concrete retention backstop period.
3. Whether a short privacy line must appear _on the waitlist form itself_
   (currently the form carries none) before go-live.
