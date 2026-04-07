/* eslint-disable no-restricted-globals */

/**
 * Optio Service Worker — handles Web Push notifications.
 * No caching / offline behaviour — this is NOT a PWA.
 */

const SW_VERSION = "1";

self.addEventListener("install", () => {
  // Activate immediately without waiting for existing clients to close
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of all clients immediately
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: "Optio",
      body: event.data.text(),
      icon: "/icon.png",
      badge: "/badge.png",
      tag: "optio",
      data: { url: "/" },
    };
  }

  const { title, body, icon, badge, tag, data } = payload;

  event.waitUntil(
    self.registration.showNotification(title || "Optio", {
      body: body || "",
      icon: icon || "/icon.png",
      badge: badge || "/badge.png",
      tag: tag || "optio",
      data: data || {},
      requireInteraction: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Try to focus an existing Optio tab
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // No existing tab — open a new one
      return self.clients.openWindow(url);
    }),
  );
});
