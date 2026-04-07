import { api } from "./api-client";

/**
 * Register the service worker for push notifications.
 * Safe to call multiple times — idempotent.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined") return null;
  if (!("serviceWorker" in navigator)) return null;

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });
    return registration;
  } catch (err) {
    console.warn("Service worker registration failed:", err);
    return null;
  }
}

/**
 * Get the current push subscription state.
 */
export function getSubscriptionState(): "unsupported" | "denied" | "granted" | "default" {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Subscribe to push notifications.
 * Must be called from a user gesture handler.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Request permission (must be in user gesture context)
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { success: false, error: "Permission denied" };
    }

    const registration = await registerServiceWorker();
    if (!registration) {
      return { success: false, error: "Service worker not supported" };
    }

    // Convert VAPID key from URL-safe base64 to Uint8Array
    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
    });

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { success: false, error: "Invalid subscription" };
    }

    // Send subscription to our API
    await api.subscribePush({
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
      userAgent: navigator.userAgent,
    });

    return { success: true };
  } catch (err) {
    console.error("Push subscription failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Unsubscribe from push notifications for the current browser.
 */
export async function unsubscribeFromPush(): Promise<{ success: boolean; error?: string }> {
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (!registration) {
      return { success: false, error: "No service worker" };
    }

    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      return { success: true }; // Already unsubscribed
    }

    // Unsubscribe from browser
    await subscription.unsubscribe();

    // Remove from our API
    await api.unsubscribePush({ endpoint: subscription.endpoint });

    return { success: true };
  } catch (err) {
    console.error("Push unsubscription failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Convert a URL-safe base64 string to a Uint8Array.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
