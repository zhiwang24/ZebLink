const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

type RawIceServer = {
  credential?: unknown;
  urls?: unknown;
  username?: unknown;
};

function normalizeIceServer(rawServer: RawIceServer): RTCIceServer | null {
  if (!rawServer || !rawServer.urls) {
    return null;
  }

  const urls =
    typeof rawServer.urls === "string" ||
    (Array.isArray(rawServer.urls) && rawServer.urls.every((value) => typeof value === "string"))
      ? rawServer.urls
      : null;

  if (!urls) {
    return null;
  }

  const normalized: RTCIceServer = { urls };

  if (typeof rawServer.username === "string") {
    normalized.username = rawServer.username;
  }

  if (typeof rawServer.credential === "string") {
    normalized.credential = rawServer.credential;
  }

  return normalized;
}

export function getIceServersFromEnv(): RTCIceServer[] {
  const jsonValue = process.env.ICE_SERVERS_JSON;
  if (jsonValue) {
    try {
      const parsed = JSON.parse(jsonValue);
      if (Array.isArray(parsed)) {
        const normalized = parsed
          .map((entry) => normalizeIceServer(entry as RawIceServer))
          .filter((entry): entry is RTCIceServer => entry !== null);

        if (normalized.length > 0) {
          return normalized;
        }
      }
    } catch {
      console.warn("Ignoring invalid ICE_SERVERS_JSON value");
    }
  }

  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (turnUrl && turnUsername && turnCredential) {
    return [
      ...DEFAULT_ICE_SERVERS,
      {
        urls: turnUrl,
        username: turnUsername,
        credential: turnCredential,
      },
    ];
  }

  return DEFAULT_ICE_SERVERS;
}
