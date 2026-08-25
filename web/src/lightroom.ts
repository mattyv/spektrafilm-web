// Adobe Lightroom cloud upload.
//
// Read access to originals is 403-gated by Adobe (partner review); writing
// finished files is not, which is all this needs. Verified end-to-end:
// PUT the asset record, PUT the master bytes, Adobe generates renditions.
//
// ponytail: no SDK, no backend. OAuth PKCE runs in the browser against an
// Adobe "Single-Page App" credential, which has no client secret.

const IMS = "https://ims-na1.adobelogin.com/ims";
const LR = "https://lr.adobe.io/v2";
const SCOPES = "openid,AdobeID,lr_partner_apis,offline_access";

// Lightroom prefixes JSON bodies with `while (1) {}` against JSON hijacking.
const lrJson = (text: string) => JSON.parse(text.replace(/^while\s*\(1\)\s*\{\}\s*/, ""));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const uuid32 = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type Album = { id: string; name: string };

const clientId = (import.meta.env.VITE_ADOBE_CLIENT_ID as string | undefined) ?? "";
export const lightroomConfigured = () => clientId.length > 0;

// Access tokens live in sessionStorage only: they expire in an hour and die
// with the tab. The refresh token is deliberately discarded — a long-lived
// credential sitting in web storage is not worth the convenience.
const TOKEN_KEY = "lr_access_token";
const VERIFIER_KEY = "lr_pkce_verifier";

export const signedIn = () => Boolean(sessionStorage.getItem(TOKEN_KEY));
export const signOut = () => sessionStorage.removeItem(TOKEN_KEY);

const token = () => {
  const value = sessionStorage.getItem(TOKEN_KEY);
  if (!value) throw new Error("Not signed in to Lightroom");
  return value;
};

const headers = () => ({ Authorization: `Bearer ${token()}`, "X-API-Key": clientId });

const redirectUri = () => `${location.origin}/`;

export async function beginSignIn() {
  if (!clientId) throw new Error("Lightroom is not configured (VITE_ADOBE_CLIENT_ID unset)");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)).buffer);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const url = new URL(`${IMS}/authorize/v2`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  location.href = url.toString();
}

/**
 * Completes sign-in if the page was loaded from an OAuth redirect.
 * Returns true if a token was obtained. Always strips the code from the URL —
 * authorization codes are single-use, so a reload must not resubmit one.
 */
export async function completeSignIn(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return false;

  const verifier = sessionStorage.getItem(VERIFIER_KEY) ?? "";
  sessionStorage.removeItem(VERIFIER_KEY);
  history.replaceState(null, "", location.pathname);
  if (!verifier) throw new Error("Sign-in could not be completed (missing verifier)");

  const res = await fetch(`${IMS}/token/v3`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
    }),
  }).catch(() => {
    // IMS omits CORS headers on error responses, so any failed exchange arrives
    // as an opaque TypeError with no status to report. Two causes are possible
    // and the browser cannot tell them apart: this origin is not a registered
    // redirect URI, or IMS declined the browser origin outright (in which case
    // the exchange needs a same-origin proxy — see the notes in .env.example).
    throw new Error(
      "Lightroom sign-in failed at the token step. Check this origin is a registered redirect URI in the Adobe console.",
    );
  });

  if (!res.ok) throw new Error(`Lightroom sign-in failed (HTTP ${res.status})`);
  const data = await res.json();
  if (!data.access_token) throw new Error("Lightroom sign-in returned no token");
  sessionStorage.setItem(TOKEN_KEY, data.access_token);
  return true;
}

async function lrFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${LR}${path}`, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  if (res.status === 401) {
    signOut();
    throw new Error("Lightroom session expired — sign in again");
  }
  return res;
}

let catalogId: string | undefined;
let accountId: string | undefined;

async function identity() {
  if (!catalogId || !accountId) {
    const [cat, acct] = await Promise.all([
      lrFetch("/catalog").then(async (r) => lrJson(await r.text())),
      lrFetch("/account").then(async (r) => lrJson(await r.text())),
    ]);
    catalogId = cat.id;
    accountId = acct.id;
  }
  return { catalogId: catalogId!, accountId: accountId! };
}

export async function listAlbums(): Promise<Album[]> {
  const { catalogId } = await identity();
  const res = await lrFetch(`/catalogs/${catalogId}/albums?subtype=collection`);
  if (!res.ok) throw new Error(`Could not list albums (HTTP ${res.status})`);
  const data = lrJson(await res.text());
  return (data.resources ?? [])
    .map((r: any) => ({ id: r.id, name: r.payload?.name ?? "(untitled)" }))
    .filter((a: Album) => a.id)
    .sort((a: Album, b: Album) => a.name.localeCompare(b.name));
}

export async function createAlbum(name: string): Promise<Album> {
  const { catalogId } = await identity();
  const id = uuid32();
  const res = await lrFetch(`/catalogs/${catalogId}/albums/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subtype: "collection",
      serviceId: "",
      payload: { name, userCreated: new Date().toISOString(), userUpdated: new Date().toISOString() },
    }),
  });
  if (!res.ok) throw new Error(`Could not create album (HTTP ${res.status}) ${(await res.text()).slice(0, 200)}`);
  return { id, name };
}

/** Uploads one finished file. Returns the new asset id. */
export async function uploadAsset(file: File, albumId?: string): Promise<string> {
  const { catalogId, accountId } = await identity();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const assetId = uuid32();
  const now = new Date().toISOString();

  const create = await lrFetch(`/catalogs/${catalogId}/assets/${assetId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subtype: "image",
      payload: {
        captureDate: "0000-00-00T00:00:00",
        userCreated: now,
        userUpdated: now,
        importSource: {
          fileName: file.name,
          importedBy: accountId,
          importedOnDevice: "Spektra Mobile",
          importTimestamp: now,
          contentType: file.type || "image/jpeg",
          sha256,
          fileSize: bytes.length,
        },
      },
    }),
  });
  if (!create.ok) {
    throw new Error(`Lightroom rejected the photo record (HTTP ${create.status}) ${(await create.text()).slice(0, 200)}`);
  }

  const upload = await lrFetch(`/catalogs/${catalogId}/assets/${assetId}/master`, {
    method: "PUT",
    headers: { "Content-Type": file.type || "image/jpeg" },
    body: bytes,
  });
  if (!upload.ok) throw new Error(`Lightroom rejected the upload (HTTP ${upload.status})`);

  if (albumId) await addToAlbum(albumId, assetId);
  return assetId;
}

async function addToAlbum(albumId: string, assetId: string) {
  const { catalogId } = await identity();
  const res = await lrFetch(`/catalogs/${catalogId}/albums/${albumId}/assets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resources: [{ id: assetId, payload: { order: "", userCreated: new Date().toISOString() } }] }),
  });
  // The photo is already safely in the catalog at this point; failing to file
  // it into an album is worth surfacing but must not read as a lost upload.
  if (!res.ok) throw new Error(`Uploaded, but could not add it to the album (HTTP ${res.status})`);
}
