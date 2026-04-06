# Backend Features Awaiting Frontend Controls

29 backend endpoints across 10 feature areas have no corresponding frontend UI.

---

## 1. Direct Messages (6 endpoints)

Full NIP-17 E2E encrypted messaging backend with zero frontend.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/conversations` | Create conversation |
| POST | `/conversations/:id/members` | Add members |
| GET | `/messages` | Inbox listing |
| GET | `/messages/:conversationId` | Load messages (paginated) |
| POST | `/messages/:conversationId` | Send DM |
| POST | `/messages/:messageId/read` | Mark read |

Notifications reference `new_message` type but clicking leads nowhere. No `/messages` page, inbox component, or conversation UI exists.

---

## 2. Pledge Drives / Commissions (11 endpoints)

Complete crowdfunding and commission system with zero frontend.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/drives` | Create drive (crowdfund or commission) |
| GET | `/drives/:id` | View drive + progress |
| PUT | `/drives/:id` | Update drive |
| DELETE | `/drives/:id` | Cancel drive |
| POST | `/drives/:id/pledge` | Pledge money |
| DELETE | `/drives/:id/pledge` | Withdraw pledge |
| POST | `/drives/:id/accept` | Accept commission |
| POST | `/drives/:id/decline` | Decline commission |
| POST | `/drives/:id/pin` | Pin/unpin on profile |
| GET | `/drives/by-user/:userId` | User's drives |
| GET | `/my/pledges` | My active pledges |

Notifications reference `commission_request`, `drive_funded`, and `pledge_fulfilled` but there is no UI to create, view, manage, or pledge to drives.

---

## 3. Free Pass Management (3 endpoints)

Writers can grant free access to paywalled articles but have no UI to do so.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/articles/:articleId/free-pass` | Grant free access to a user |
| DELETE | `/articles/:articleId/free-pass/:userId` | Revoke access |
| GET | `/articles/:articleId/free-passes` | List grants (author view) |

The paywall gate component handles the reader-side free pass flow, but writers have no controls to grant or manage passes on their articles.

---

## 4. Admin / Moderation Dashboard (3 endpoints)

Users can submit reports via `ReportButton.tsx`, but there is no admin panel.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/reports` | List all content reports |
| PATCH | `/admin/reports/:reportId` | Resolve report (remove/suspend/no-action) |
| POST | `/admin/suspend/:accountId` | Suspend account |

---

## 5. Subscription Price Setting (1 endpoint)

| Method | Endpoint | Description |
|--------|----------|-------------|
| PATCH | `/settings/subscription-price` | Set writer's monthly subscription price |

Writer profiles display the subscription price and the subscribe button uses it, but there is no settings control for a writer to set or change their price.

---

## 6. My Active Subscriptions (1 endpoint)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/subscriptions/mine` | List reader's active subscriptions |

The frontend can check, create, and cancel individual subscriptions inline, but there is no page showing all active subscriptions in one place.

---

## 7. Portable Receipt Export (2 endpoints)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/platform-pubkey` | Platform Nostr service pubkey |
| GET | `/receipts/export` | Export all portable receipt tokens |

No UI for readers to download their receipt tokens for cross-platform content portability.

---

## 8. Account / Migration Export (1 endpoint)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/account/export` | Full writer migration bundle (keys, receipts, articles) |

No settings or dashboard control for writers to export their data and leave the platform.

---

## 9. Reader Tab Overview (1 endpoint)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/my/tab` | Tab balance, free allowance remaining, recent reads |

The `AllowanceExhaustedModal` references the free allowance concept, but there is no dedicated UI showing the reader's current tab balance and reading costs.

---

## 10. DM Pricing / Anti-Spam Settings (0 endpoints, schema only)

The `dm_pricing` table and enforcement logic exist in the send-message flow (returns 402 if pricing is set), but there is no API endpoint to configure pricing and no frontend settings for it.

---

## Priority Notes

The two largest gaps are **Direct Messages** (complete backend, zero frontend) and **Pledge Drives** (11 endpoints, zero frontend). Both features already generate notification types that appear in the notification bell but lead nowhere when clicked.
