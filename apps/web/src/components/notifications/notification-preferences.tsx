"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api-client";
import {
  subscribeToPush,
  unsubscribeFromPush,
  getSubscriptionState,
} from "@/lib/push-subscription";
import { toast } from "sonner";
import { Bell, BellOff, Loader2, Trash2, Send } from "lucide-react";

const EVENT_LABELS: Record<string, { title: string; description: string }> = {
  "task.pr_opened": {
    title: "PR opened",
    description: "When a task you created opens a pull request",
  },
  "task.completed": {
    title: "Task completed",
    description: "When your task merges successfully",
  },
  "task.failed": {
    title: "Task failed",
    description: "When your task fails",
  },
  "task.needs_attention": {
    title: "Needs attention",
    description: "When a task needs your input (review changes, CI failing, etc.)",
  },
  "task.stalled": {
    title: "Task stalled",
    description: "When a task appears to be stuck",
  },
  "task.review_requested": {
    title: "Review requested",
    description: "When someone requests a review on your PR",
  },
  "task.commented": {
    title: "New comment",
    description: "When someone comments on your task",
  },
};

export function NotificationPreferences() {
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [vapidLoading, setVapidLoading] = useState(true);
  const [permissionState, setPermissionState] = useState(getSubscriptionState);
  const [subscriptions, setSubscriptions] = useState<any[]>([]);
  const [preferences, setPreferences] = useState<Record<string, { push: boolean }>>({});
  const [subscribing, setSubscribing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingPrefs, setLoadingPrefs] = useState(true);

  // Fetch VAPID key + subscriptions + preferences on mount
  useEffect(() => {
    api
      .getVapidPublicKey()
      .then((res) => setVapidKey(res.publicKey))
      .catch(() => setVapidKey(null))
      .finally(() => setVapidLoading(false));

    api
      .listPushSubscriptions()
      .then((res) => setSubscriptions(res.subscriptions))
      .catch(() => {});

    api
      .getNotificationPreferences()
      .then((res) => setPreferences(res.preferences))
      .catch(() => {})
      .finally(() => setLoadingPrefs(false));
  }, []);

  // Re-check permission state after subscribing
  useEffect(() => {
    setPermissionState(getSubscriptionState());
  }, [subscriptions]);

  const handleEnable = async () => {
    if (!vapidKey) return;
    setSubscribing(true);
    try {
      const result = await subscribeToPush(vapidKey);
      if (result.success) {
        toast.success("Push notifications enabled");
        setPermissionState("granted");
        // Refresh subscription list
        const res = await api.listPushSubscriptions();
        setSubscriptions(res.subscriptions);
      } else {
        toast.error(result.error ?? "Failed to enable notifications");
      }
    } catch {
      toast.error("Failed to enable notifications");
    } finally {
      setSubscribing(false);
    }
  };

  const handleUnsubscribe = async (id: string) => {
    try {
      // Find the subscription to get its endpoint (we need to unsubscribe browser-side too)
      await unsubscribeFromPush();
      setSubscriptions((prev) => prev.filter((s) => s.id !== id));
      toast.success("Subscription removed");
    } catch {
      toast.error("Failed to remove subscription");
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await api.testPushNotification();
      if (res.sent > 0) {
        toast.success(`Test notification sent to ${res.sent} device(s)`);
      } else {
        toast.info("No active subscriptions to send to");
      }
    } catch {
      toast.error("Failed to send test notification");
    } finally {
      setTesting(false);
    }
  };

  const handlePrefToggle = async (eventType: string, enabled: boolean) => {
    const newPrefs = { [eventType]: { push: enabled } };
    // Optimistic update
    setPreferences((prev) => ({ ...prev, ...newPrefs }));
    try {
      const res = await api.updateNotificationPreferences(newPrefs);
      setPreferences(res.preferences);
    } catch {
      // Revert on error
      setPreferences((prev) => ({ ...prev, [eventType]: { push: !enabled } }));
      toast.error("Failed to update preference");
    }
  };

  // VAPID not configured — hide the entire section
  if (!vapidLoading && !vapidKey) {
    return null;
  }

  if (vapidLoading) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Permission / Enable */}
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bell className="w-5 h-5 text-text-muted" />
            <div>
              <p className="text-sm">Browser Push Notifications</p>
              <p className="text-xs text-text-muted">
                Get OS-level notifications even when the Optio tab is closed
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {permissionState === "granted" && subscriptions.length > 0 && (
              <button
                onClick={handleTest}
                disabled={testing}
                className="px-3 py-1.5 rounded-md text-xs bg-bg-hover text-text-muted hover:text-text transition-colors"
              >
                {testing ? (
                  <Loader2 className="w-3 h-3 animate-spin inline" />
                ) : (
                  <Send className="w-3 h-3 inline mr-1" />
                )}
                Test
              </button>
            )}
            {permissionState === "denied" ? (
              <div className="flex items-center gap-1.5 text-xs text-warning">
                <BellOff className="w-3.5 h-3.5" />
                Blocked in browser
              </div>
            ) : permissionState === "granted" && subscriptions.length > 0 ? (
              <span className="px-3 py-1.5 rounded-md text-xs bg-success/10 text-success">
                Enabled
              </span>
            ) : (
              <button
                onClick={handleEnable}
                disabled={subscribing}
                className="px-3 py-1.5 rounded-md text-xs bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {subscribing ? <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> : null}
                Enable
              </button>
            )}
          </div>
        </div>

        {permissionState === "denied" && (
          <p className="text-xs text-text-muted mt-2">
            Notifications are blocked. To re-enable, open your browser&apos;s site settings and
            allow notifications for this site.
          </p>
        )}
      </div>

      {/* Registered devices */}
      {subscriptions.length > 0 && (
        <div className="p-5 rounded-xl border border-border/50 bg-bg-card">
          <p className="text-xs text-text-muted mb-3">Registered devices</p>
          <div className="space-y-2">
            {subscriptions.map((sub) => (
              <div key={sub.id} className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-text">{parseUserAgent(sub.userAgent)}</span>
                  <span className="text-text-muted text-xs ml-2">
                    {sub.lastUsedAt
                      ? `Last used ${new Date(sub.lastUsedAt).toLocaleDateString()}`
                      : `Added ${new Date(sub.createdAt).toLocaleDateString()}`}
                  </span>
                </div>
                <button
                  onClick={() => handleUnsubscribe(sub.id)}
                  className="p-1 text-text-muted hover:text-error transition-colors"
                  title="Remove subscription"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Event preferences */}
      {permissionState === "granted" && subscriptions.length > 0 && !loadingPrefs && (
        <div className="p-5 rounded-xl border border-border/50 bg-bg-card">
          <p className="text-xs text-text-muted mb-3">Notification events</p>
          <div className="space-y-3">
            {Object.entries(EVENT_LABELS).map(([eventType, { title, description }]) => {
              const pref = preferences[eventType];
              const enabled = pref?.push ?? false;
              return (
                <label key={eventType} className="flex items-center justify-between cursor-pointer">
                  <div>
                    <p className="text-sm">{title}</p>
                    <p className="text-xs text-text-muted">{description}</p>
                  </div>
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${
                      enabled ? "bg-primary" : "bg-bg-hover"
                    }`}
                    onClick={() => handlePrefToggle(eventType, !enabled)}
                  >
                    <div
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        enabled ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function parseUserAgent(ua?: string | null): string {
  if (!ua) return "Unknown device";
  if (ua.includes("Chrome") && !ua.includes("Edg")) return "Chrome";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
  if (ua.includes("Edg")) return "Edge";
  return "Browser";
}
