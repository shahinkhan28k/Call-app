/* Service Worker helper for background Claro incoming call notifications */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const callId =
    (event.notification && event.notification.data && event.notification.data.callId) || '';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            client.focus();
            if (callId) {
              client.postMessage({ type: 'CLARO_FOCUS_CALL', callId });
            }
            return client;
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(callId ? `/?callId=${encodeURIComponent(callId)}` : '/');
        }
        return undefined;
      })
  );
});
