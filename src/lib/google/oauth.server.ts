import { getCookie, setCookie } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import {
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
  publicOriginFromRequest,
  requestIsHttps,
} from "./env.server";

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const STATE_COOKIE = "rc_oauth_state";

type TokenRow = {
  email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | Date | null;
  scope: string | null;
};

export function oauthConfigured(): { clientId: boolean; clientSecret: boolean } {
  return {
    clientId: Boolean(googleClientId()),
    clientSecret: Boolean(googleClientSecret()),
  };
}

export async function getConnectedAccount(): Promise<{
  email: string | null;
  connected: boolean;
}> {
  const sql = await getSql();
  const rows = await sql<TokenRow>`
    select email, access_token, refresh_token, token_expiry, scope
    from google_account where id = 'default'
  `;
  const row = rows[0];
  if (!row?.refresh_token && !row?.access_token) {
    return { email: row?.email ?? null, connected: false };
  }
  return { email: row.email, connected: true };
}

export async function buildAuthUrl(): Promise<string> {
  const clientId = googleClientId();
  const secret = googleClientSecret();
  if (!clientId || !secret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.");
  }
  const state = crypto.randomUUID();
  const sql = await getSql();
  await sql`insert into oauth_state (state) values (${state})`;
  setCookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
    secure: requestIsHttps(),
  });
  const redirectUri = googleRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function handleOAuthCallback(request: Request): Promise<string> {
  const url = new URL(request.url);
  const origin = publicOriginFromRequest(request);
  const err = url.searchParams.get("error");
  if (err) {
    return `${origin}/?oauth=error&reason=${encodeURIComponent(err)}`;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = getCookie(STATE_COOKIE);
  if (!code || !state || !cookieState || state !== cookieState) {
    return `${origin}/?oauth=error&reason=invalid_state`;
  }
  const sql = await getSql();
  const states = await sql<{ state: string }>`
    select state from oauth_state where state = ${state}
  `;
  if (!states[0]) return `${origin}/?oauth=error&reason=expired_state`;
  await sql`delete from oauth_state where state = ${state}`;
  setCookie(STATE_COOKIE, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
    secure: requestIsHttps(),
  });

  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) {
    return `${origin}/?oauth=error&reason=missing_credentials`;
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleRedirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    const reason = tokenJson.error_description || tokenJson.error || "token_exchange";
    return `${origin}/?oauth=error&reason=${encodeURIComponent(reason)}`;
  }

  const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  const info = (await infoRes.json()) as { email?: string };

  const expiry = new Date(Date.now() + (tokenJson.expires_in ?? 3600) * 1000).toISOString();
  const existing = await sql<TokenRow>`
    select refresh_token from google_account where id = 'default'
  `;
  const refresh =
    tokenJson.refresh_token || existing[0]?.refresh_token || null;

  await sql`
    insert into google_account (id, email, access_token, refresh_token, token_expiry, scope, connected_at, updated_at)
    values (
      'default',
      ${info.email ?? null},
      ${tokenJson.access_token},
      ${refresh},
      ${expiry},
      ${tokenJson.scope ?? SCOPES},
      now(),
      now()
    )
    on conflict (id) do update set
      email = excluded.email,
      access_token = excluded.access_token,
      refresh_token = coalesce(excluded.refresh_token, google_account.refresh_token),
      token_expiry = excluded.token_expiry,
      scope = excluded.scope,
      updated_at = now()
  `;

  return `${origin}/?oauth=connected`;
}

export async function disconnectGoogle(): Promise<void> {
  const sql = await getSql();
  const rows = await sql<TokenRow>`
    select access_token, refresh_token from google_account where id = 'default'
  `;
  const token = rows[0]?.access_token || rows[0]?.refresh_token;
  if (token) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    } catch {
      // ignore revoke failures — local row is still cleared
    }
  }
  await sql`delete from google_account where id = 'default'`;
}

export async function getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  const sql = await getSql();
  const rows = await sql<TokenRow>`
    select access_token, refresh_token, token_expiry from google_account where id = 'default'
  `;
  const row = rows[0];
  if (!row) throw new Error("Google Drive is not connected.");
  const expiry = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
  if (
    !opts?.forceRefresh &&
    row.access_token &&
    expiry - 60_000 > Date.now()
  ) {
    return row.access_token;
  }
  if (!row.refresh_token) throw new Error("Missing Google refresh token. Reconnect Drive.");
  return refreshAccessToken(row.refresh_token);
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.");
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(
      tokenJson.error_description || tokenJson.error || "Failed to refresh Google token.",
    );
  }
  const expiry = new Date(Date.now() + (tokenJson.expires_in ?? 3600) * 1000).toISOString();
  const sql = await getSql();
  await sql`
    update google_account
    set access_token = ${tokenJson.access_token},
        token_expiry = ${expiry},
        updated_at = now()
    where id = 'default'
  `;
  return tokenJson.access_token;
}
