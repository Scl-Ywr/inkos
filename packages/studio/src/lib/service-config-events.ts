const SERVICE_CONFIG_CHANGED_EVENT = "inkos:service-config-changed";

export function publishServiceConfigChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SERVICE_CONFIG_CHANGED_EVENT));
}

export function subscribeServiceConfigChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(SERVICE_CONFIG_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SERVICE_CONFIG_CHANGED_EVENT, listener);
}
