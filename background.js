// Background service worker: signs in to Google and calls the Calendar API on
// behalf of the content script (drag-edit.js) and the popup.
//
// Sign-in uses chrome.identity.launchWebAuthFlow with the OAuth client id the
// user pastes into the popup, so it works in Chrome, Edge, Brave and Arc.

const API_BASE = "https://www.googleapis.com/calendar/v3"
const SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.settings.readonly"
].join(" ")

class ApiError extends Error {
    constructor(message, status, code) {
        super(message)
        this.status = status
        this.code = code
    }
}

let pendingAuth = null

const readCachedToken = async () => {
    const { auth } = await chrome.storage.session.get("auth")
    return auth && auth.expiry > Date.now() + 60 * 1000 ? auth.token : null
}

const authorize = async ({ interactive, loginHint }) => {
    const { oauthClientId } = await chrome.storage.local.get("oauthClientId")
    if (!oauthClientId) {
        throw new ApiError("Add your Google API client id in the Calendar Additions popup first.", 0, "NO_CLIENT_ID")
    }
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
    url.searchParams.set("client_id", oauthClientId.trim())
    url.searchParams.set("response_type", "token")
    url.searchParams.set("redirect_uri", chrome.identity.getRedirectURL())
    url.searchParams.set("scope", SCOPES)
    url.searchParams.set("include_granted_scopes", "true")
    if (loginHint) url.searchParams.set("login_hint", loginHint)
    if (!interactive) url.searchParams.set("prompt", "none")

    const options = { url: url.toString(), interactive }
    if (!interactive) {
        options.abortOnLoadForNonInteractive = false
        options.timeoutMsForNonInteractive = 5000
    }
    const redirect = await chrome.identity.launchWebAuthFlow(options)
    const params = new URLSearchParams(new URL(redirect).hash.slice(1))
    const token = params.get("access_token")
    if (!token) {
        throw new ApiError(params.get("error_description") || params.get("error") || "Sign-in failed", 0, "AUTH_FAILED")
    }
    const expiry = Date.now() + Number(params.get("expires_in") || 3600) * 1000
    await chrome.storage.session.set({ auth: { token, expiry } })
    return token
}

// Returns a valid access token: cached, then silent sign-in, then (if allowed) the sign-in window
const getToken = async ({ interactive = true, loginHint, fresh = false } = {}) => {
    if (fresh) await chrome.storage.session.remove("auth")
    const cached = await readCachedToken()
    if (cached) return cached
    if (pendingAuth) return pendingAuth
    pendingAuth = (async () => {
        try {
            return await authorize({ interactive: false, loginHint })
        } catch (silentError) {
            if (!interactive) throw silentError
            return await authorize({ interactive: true, loginHint })
        }
    })()
    try {
        return await pendingAuth
    } finally {
        pendingAuth = null
    }
}

const callApi = async ({ method = "GET", path, query, body, loginHint }) => {
    const url = new URL(API_BASE + path)
    Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, v))

    const send = token =>
        fetch(url.toString(), {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body ? { "Content-Type": "application/json" } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        })

    let res = await send(await getToken({ loginHint }))
    if (res.status === 401) res = await send(await getToken({ loginHint, fresh: true }))

    if (!res.ok) {
        let message = `Google Calendar API error ${res.status}`
        try {
            const json = await res.json()
            if (json.error && json.error.message) message = json.error.message
        } catch (e) {}
        throw new ApiError(message, res.status, "API_ERROR")
    }
    return res.status === 204 ? null : res.json()
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const run = async () => {
        if (msg.type === "calmerge-api") return callApi(msg)
        if (msg.type === "calmerge-connect") {
            await getToken({ interactive: true, loginHint: msg.loginHint, fresh: true })
            const primary = await callApi({ path: "/calendars/primary" })
            await chrome.storage.local.set({ connectedAccount: primary.id })
            return { account: primary.id }
        }
        if (msg.type === "calmerge-redirect-uri") return { redirectUri: chrome.identity.getRedirectURL() }
        throw new ApiError(`Unknown message ${msg.type}`, 0, "BAD_MESSAGE")
    }
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("calmerge-")) return false
    run().then(
        data => sendResponse({ ok: true, data }),
        error => sendResponse({ ok: false, error: error.message, status: error.status || 0, code: error.code || "ERROR" })
    )
    return true
})

// A new client id means the old token belongs to a different OAuth client
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.oauthClientId) {
        chrome.storage.session.remove("auth")
        chrome.storage.local.remove("connectedAccount")
    }
})
