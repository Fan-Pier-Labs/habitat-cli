// Thin wrapper around the Habitat / Computime / Salus REST API endpoints
// (AWS API Gateway in us-west-2). All endpoints use Cognito JWT bearer auth
// — pass `session.idToken` as the bearer.

import type { Session } from "./auth.ts";

interface RestOptions {
  headers?: Record<string, string>;
}

async function callRest<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  session: Session,
  body?: unknown,
  options: RestOptions = {},
): Promise<T> {
  // The app sends the Cognito ACCESS token (not id token) as the Bearer.
  // Discovered via `token: t.accessToken.jwtToken` in the app JS.
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${url}: ${text.slice(0, 200)}`);
  }
  try {
    return text ? (JSON.parse(text) as T) : (undefined as T);
  } catch {
    return text as unknown as T;
  }
}

// ---------- Device sharing ----------

const SHARE_BASE = "https://lk295wiw9k.execute-api.us-west-2.amazonaws.com/V1/share-users";

export interface ShareCheckResult {
  // The endpoint returns a structure indicating whether the email is registered.
  // Shape is loose; the app just checks for a truthy `is_registered`.
  [k: string]: unknown;
}

export function shareCheckRegistered(session: Session, email: string) {
  return callRest<ShareCheckResult>("POST", `${SHARE_BASE}/check-registered-status`, session, {
    email,
  });
}

export function shareInvite(
  session: Session,
  opts: {
    recipientEmail: string;
    identityId: string;
    gatewayId: string;
    thermControlSettings?: unknown;
    thermAlertsSettings?: unknown;
    sensorAlertsSettings?: unknown;
  },
) {
  return callRest("POST", `${SHARE_BASE}/invite-recipient`, session, {
    email: opts.recipientEmail,
    userid: opts.identityId,
    gatewayid: opts.gatewayId,
    therm_control_settings: opts.thermControlSettings ?? {},
    therm_alerts_settings: opts.thermAlertsSettings ?? {},
    sensor_alerts_settings: opts.sensorAlertsSettings ?? {},
  });
}

export function shareDelete(
  session: Session,
  opts: { sharerEmail: string; identityId: string; gatewayId: string },
) {
  return callRest("POST", `${SHARE_BASE}/delete`, session, {
    email: opts.sharerEmail,
    userid: opts.identityId,
    gatewayid: opts.gatewayId,
  });
}

// ---------- Alerts ----------

const ALERTS_BASE = "https://oi8bbws0zl.execute-api.us-west-2.amazonaws.com/v1";

export function getCurrentAlerts(
  session: Session,
  params: { gatewayId: string; identityId: string },
) {
  const qs = new URLSearchParams({
    user_id: params.identityId,
    username: session.email,
    gateway_id: params.gatewayId,
  }).toString();
  return callRest("GET", `${ALERTS_BASE}/devicesalerts?${qs}`, session);
}

export function getAlertLog(
  session: Session,
  params: { gatewayId: string; identityId: string },
) {
  const qs = new URLSearchParams({
    user_id: params.identityId,
    username: session.email,
    gateway_id: params.gatewayId,
  }).toString();
  return callRest("GET", `${ALERTS_BASE}/devicealertslogs?${qs}`, session);
}

// ---------- Geofence / location ----------

const LOCATION_URL =
  "https://vpb9jtlx72.execute-api.us-west-2.amazonaws.com/V1/location";

export function updateLocation(
  session: Session,
  opts: { lat: number; lng: number; userId: string; uuid: string },
) {
  // The app's call DIDN'T include Authorization here, but pass it defensively.
  return callRest("POST", LOCATION_URL, session, {
    lat: opts.lat,
    lng: opts.lng,
    user_id: opts.userId,
    uuid: opts.uuid,
  });
}
