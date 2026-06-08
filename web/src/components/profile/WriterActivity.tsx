"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "../../stores/auth";
import {
  messages as messagesApi,
  trust as trustApi,
  type TrustProfileResponse,
  type WriterProfile,
} from "../../lib/api";
import { useCompose } from "../../stores/compose";
import { WorkTab } from "./WorkTab";
import { SocialTab } from "./SocialTab";
import { FollowersTab } from "./FollowersTab";
import { FollowingTab } from "./FollowingTab";
import { TrustProfile } from "../trust/TrustProfile";
import { VouchModal } from "../trust/VouchModal";
import type { QuoteTarget } from "../../lib/publishNote";

type ProfileTab = "work" | "social" | "followers" | "following";

const ALL_TABS: ProfileTab[] = ["work", "social", "followers", "following"];

interface SubStatus {
  subscribed: boolean;
  ownContent?: boolean;
  status?: string;
  pricePence?: number;
  currentPeriodEnd?: string;
}

interface WriterActivityProps {
  username: string;
  writer: WriterProfile;
  // Hosted inside the profile overlay (NativeProfilePanel). The overlay's pushed
  // URL is /<username>, so we ignore the ambient ?tab the workspace URL may carry
  // and drive tab state internally (switchTab still reflects it onto the URL).
  inOverlay?: boolean;
}

export function WriterActivity({ username, writer, inOverlay = false }: WriterActivityProps) {
  const { user, loading: authLoading } = useAuth();
  const searchParams = useSearchParams();

  // Only show Work tab if the writer has published at least one article
  const tabs =
    writer.articleCount > 0 ? ALL_TABS : ALL_TABS.filter((t) => t !== "work");

  const rawTab = inOverlay ? null : searchParams.get("tab");
  const defaultTab = tabs[0];
  const initialTab: ProfileTab =
    rawTab && tabs.includes(rawTab as ProfileTab)
      ? (rawTab as ProfileTab)
      : defaultTab;

  const [activeTab, setActiveTab] = useState<ProfileTab>(initialTab);
  const [following, setFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [subStatus, setSubStatus] = useState<SubStatus | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const openCompose = useCompose((s) => s.open);
  const [showVouchModal, setShowVouchModal] = useState(false);
  const [trustData, setTrustData] = useState<TrustProfileResponse | null>(null);
  const [trustKey, setTrustKey] = useState(0);

  // Sync tab from URL changes
  useEffect(() => {
    if (rawTab && tabs.includes(rawTab as ProfileTab)) {
      setActiveTab(rawTab as ProfileTab);
    }
  }, [rawTab, tabs]);

  function switchTab(tab: ProfileTab) {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === "work") {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", tab);
    }
    window.history.replaceState({}, "", url.toString());
  }

  // Check follow/subscription status
  useEffect(() => {
    if (!user || !writer) return;
    async function checkStatus() {
      try {
        const [followRes, subRes] = await Promise.all([
          fetch("/api/v1/follows", { credentials: "include" }),
          fetch(`/api/v1/subscriptions/check/${writer.id}`, {
            credentials: "include",
          }),
        ]);
        if (followRes.ok) {
          const data = await followRes.json();
          setFollowing(
            (data.writers ?? []).some((w: any) => w.id === writer.id),
          );
        }
        if (subRes.ok) {
          setSubStatus(await subRes.json());
        }
      } catch {
        setSubStatus({ subscribed: false });
      }
    }
    void checkStatus();
  }, [user, writer]);

  // Fetch trust data for vouch modal (viewer's existing vouches)
  useEffect(() => {
    if (!writer) return;
    trustApi
      .getProfile(writer.id)
      .then((d) => setTrustData(d))
      .catch(() => {});
  }, [writer, trustKey]);

  async function handleToggleFollow() {
    if (!user || !writer) return;
    setFollowLoading(true);
    try {
      const res = await fetch(`/api/v1/follows/${writer.id}`, {
        method: following ? "DELETE" : "POST",
        credentials: "include",
      });
      if (res.ok) setFollowing(!following);
    } catch (err) {
      console.error("Follow error:", err);
    } finally {
      setFollowLoading(false);
    }
  }

  async function handleSubscribe(period: "monthly" | "annual" = "monthly") {
    if (!user || !writer) return;
    setSubLoading(true);
    try {
      const res = await fetch(`/api/v1/subscriptions/${writer.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      if (res.ok) {
        const data = await res.json();
        setSubStatus({
          subscribed: true,
          status: "active",
          pricePence: data.pricePence,
          currentPeriodEnd: data.currentPeriodEnd,
        });
      }
    } catch (err) {
      console.error("Subscribe error:", err);
    } finally {
      setSubLoading(false);
    }
  }

  async function handleUnsubscribe() {
    if (!user || !writer) return;
    setSubLoading(true);
    try {
      const res = await fetch(`/api/v1/subscriptions/${writer.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setSubStatus({
          subscribed: true,
          status: "cancelled",
          currentPeriodEnd: data.accessUntil,
        });
      }
    } catch (err) {
      console.error("Unsubscribe error:", err);
    } finally {
      setSubLoading(false);
    }
  }

  const handleQuote = useCallback(
    (target: QuoteTarget) => {
      openCompose("reply", target);
    },
    [openCompose],
  );

  const router = useRouter();
  const isOwnProfile = user?.username === username;
  const [msgLoading, setMsgLoading] = useState(false);

  async function handleMessage() {
    if (!user || !writer) return;
    setMsgLoading(true);
    try {
      const result = await messagesApi.createConversation([writer.id]);
      router.push(`/workspace?overlay=messages&conversation=${result.conversationId}`);
    } catch {
      router.push("/workspace?overlay=messages");
    } finally {
      setMsgLoading(false);
    }
  }

  // Show subscription/commission UI only if writer has published a paywalled article
  const hasPaywall =
    writer.hasPaywalledArticle && writer.subscriptionPricePence > 0;

  return (
    <>
      {/* Action buttons — rendered client-side since they need auth state */}
      {user && !isOwnProfile && (
        <div className="flex items-center gap-2 mb-6 -mt-6">
          <button
            onClick={handleToggleFollow}
            disabled={followLoading}
            className={`transition-colors disabled:opacity-50 ${following ? "btn-soft py-1.5 px-4 text-ui-xs" : "btn py-1.5 px-4 text-ui-xs"}`}
          >
            {followLoading ? "..." : following ? "Following" : "Follow"}
          </button>

          <button
            onClick={handleMessage}
            disabled={msgLoading}
            className="btn-ghost py-1.5 px-4 text-ui-xs transition-colors disabled:opacity-50"
          >
            {msgLoading ? "..." : "Message"}
          </button>

          <button
            onClick={() => setShowVouchModal(true)}
            className="btn-ghost py-1.5 px-4 text-ui-xs transition-colors"
          >
            Vouch
          </button>

          {hasPaywall &&
            subStatus &&
            !subStatus.ownContent &&
            (subStatus.subscribed ? (
              <button
                onClick={handleUnsubscribe}
                disabled={subLoading}
                className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
              >
                {subLoading
                  ? "..."
                  : subStatus.status === "cancelled"
                    ? `Access until ${new Date(subStatus.currentPeriodEnd!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
                    : "Subscribed"}
              </button>
            ) : (
              (() => {
                const monthlyPence =
                  subStatus.pricePence ?? writer.subscriptionPricePence ?? 500;
                const discount = writer.annualDiscountPct ?? 15;
                const annualPence = Math.round(
                  monthlyPence * 12 * (1 - discount / 100),
                );
                return (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleSubscribe("monthly")}
                      disabled={subLoading}
                      className="btn-accent py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
                    >
                      {subLoading
                        ? "..."
                        : `Subscribe £${(monthlyPence / 100).toFixed(2)}/mo`}
                    </button>
                    {discount > 0 && (
                      <button
                        onClick={() => handleSubscribe("annual")}
                        disabled={subLoading}
                        className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
                      >
                        {subLoading
                          ? "..."
                          : `£${(annualPence / 100).toFixed(2)}/yr`}
                      </button>
                    )}
                  </div>
                );
              })()
            ))}
        </div>
      )}

      {!user && !authLoading && !isOwnProfile && (
        <div className="mb-6 -mt-6">
          <Link
            href="/auth?mode=login"
            className="text-ui-xs text-grey-600 hover:text-black transition-colors"
          >
            Log in to follow
          </Link>
        </div>
      )}

      {/* Vouch modal */}
      {showVouchModal && writer && (
        <VouchModal
          subjectId={writer.id}
          subjectName={writer.displayName ?? username}
          existingVouches={trustData?.viewerVouches ?? []}
          onClose={() => setShowVouchModal(false)}
          onVouched={() => {
            setShowVouchModal(false);
            setTrustKey((k) => k + 1);
          }}
        />
      )}

      {/* Trust profile section */}
      {writer && (
        <div className="mb-8">
          <TrustProfile userId={writer.id} key={trustKey} compact />
        </div>
      )}

      {/* Tab navigation */}
      <div
        className="flex gap-2 mb-8"
        role="tablist"
        aria-label="Profile sections"
      >
        {tabs.map((tab, i) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`profile-panel-${tab}`}
            id={`profile-tab-${tab}`}
            onClick={() => switchTab(tab)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                switchTab(tabs[(i + 1) % tabs.length]);
                e.preventDefault();
              }
              if (e.key === "ArrowLeft") {
                switchTab(tabs[(i - 1 + tabs.length) % tabs.length]);
                e.preventDefault();
              }
            }}
            tabIndex={activeTab === tab ? 0 : -1}
            className={`tab-pill ${activeTab === tab ? "tab-pill-active" : "tab-pill-inactive"}`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "work" && (
        <div
          role="tabpanel"
          id="profile-panel-work"
          aria-labelledby="profile-tab-work"
        >
          <WorkTab
            username={username}
            writer={writer}
            isOwnProfile={isOwnProfile}
            onQuote={handleQuote}
          />
        </div>
      )}
      {activeTab === "social" && (
        <div
          role="tabpanel"
          id="profile-panel-social"
          aria-labelledby="profile-tab-social"
        >
          <SocialTab
            username={username}
            writer={writer}
            isOwnProfile={isOwnProfile}
            onQuote={handleQuote}
          />
        </div>
      )}
      {activeTab === "followers" && (
        <div
          role="tabpanel"
          id="profile-panel-followers"
          aria-labelledby="profile-tab-followers"
        >
          <FollowersTab username={username} isOwnProfile={isOwnProfile} />
        </div>
      )}
      {activeTab === "following" && (
        <div
          role="tabpanel"
          id="profile-panel-following"
          aria-labelledby="profile-tab-following"
        >
          <FollowingTab username={username} isOwnProfile={isOwnProfile} />
        </div>
      )}
    </>
  );
}
