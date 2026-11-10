// Drag-to-edit for timed events in Google Calendar's day/week views (added in this fork)
//
// - Drag an event's TOP edge to change its start time (Google only lets you drag the bottom edge).
// - Hold Alt (Option on a Mac) while dragging to move in 5-minute steps instead of 15.
//   Press or release Alt at any point during the drag to switch between the two.
// - Hold Shift while dragging to move in 30-minute steps (Alt wins if both are held).
// - Start a drag on empty space with Alt or Shift held to create an event in 5- or 30-minute
//   steps; on release Google's full event editor opens with those times filled in. (Plain drags
//   on empty space are left to Google, so normal event creation is unchanged.)
//
// Google Calendar's own drag code only snaps to 15 minutes and has no start-time handle, so while
// this feature is on the extension runs the whole drag itself (move, top edge, bottom edge) and
// saves the result through the Google Calendar API (see background.js). Clicks without a drag are
// handed back to Google untouched, so opening an event still works as before.
//
// This script runs at document_start so its listeners are registered before Google's: that way
// Google never sees a drag this script handles (otherwise Google would run its own drag too, e.g.
// Alt+drag would also make Google duplicate the event).
//
// While dragging, the event element itself is moved/resized and the times shown in it are updated,
// so the preview looks exactly like Google's own.
//
// The feature only switches on once a Google API client id is set in the popup. Without one,
// Google's own dragging is left alone.

;(() => {
    "use strict"

    const STEP = 15 // minutes, like Google Calendar
    const FINE_STEP = 5 // minutes, while Alt is held
    const COARSE_STEP = 30 // minutes, while Shift is held
    const stepFor = p => (p.alt ? FINE_STEP : p.shift ? COARSE_STEP : STEP)
    const DRAG_THRESHOLD = 4 // px of movement before a press becomes a drag
    const MIN_COLUMN_HEIGHT = 300 // px; day/week time-grid columns are much taller than month cells
    const HANDLE_BELOW = 8 // px below an event's bottom edge that still count as its resize handle
    const MINUTE = 60 * 1000
    const DAY = 24 * 60 * MINUTE

    let debugEnabled = false
    try {
        debugEnabled = window.localStorage.getItem("calmerge-debug") === "1"
    } catch (e) {}
    const debug = (...args) => debugEnabled && console.log("[Calendar Additions drag]", ...args)

    // ---- settings -------------------------------------------------------------------------

    const settings = { dragEdit: true, oauthClientId: "", detectedEmail: "" }
    const isEnabled = () => settings.dragEdit !== false && !!(settings.oauthClientId || "").trim()

    // After the extension is reloaded or updated, this copy of the script (still running in an
    // already-open tab) is cut off from Chrome and can't save anything, so it must stand aside and
    // leave dragging to Google until the page is reloaded.
    const extensionAlive = () => {
        try {
            return !!(chrome.runtime && chrome.runtime.id)
        } catch (e) {
            return false
        }
    }
    const isActive = () => isEnabled() && extensionAlive()
    const STALE_MESSAGE = "Calendar Additions was updated. Reload this page to keep using it."

    try {
        chrome.storage.local.get(["dragEdit", "oauthClientId", "detectedEmail"], s => Object.assign(settings, s || {}))
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            Object.keys(settings).forEach(k => {
                if (changes[k]) settings[k] = changes[k].newValue
            })
        })
    } catch (e) {
        return // not running as an extension (e.g. Greasemonkey): nothing to do
    }

    // ---- Calendar API (through background.js) ------------------------------------------

    const findAccountEmail = () => {
        if (settings.detectedEmail) return settings.detectedEmail
        const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
        for (const el of document.querySelectorAll('[data-email], a[aria-label*="@"], [aria-label*="@"][role="button"]')) {
            const m = (el.getAttribute("data-email") || el.getAttribute("aria-label") || "").match(emailRe)
            if (m) return (settings.detectedEmail = m[0].toLowerCase())
        }
        return undefined
    }

    const api = (method, path, { query, body } = {}) =>
        new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: "calmerge-api", method, path, query, body, loginHint: findAccountEmail() }, res => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
                if (!res || !res.ok) {
                    const err = new Error((res && res.error) || "Request failed")
                    err.status = res && res.status
                    return reject(err)
                }
                resolve(res.data)
            })
        })

    const eventPath = (calendarId, eventId) =>
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`

    let timezonePromise = null
    const getCalendarTimezone = () => {
        const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (!timezonePromise) {
            timezonePromise = api("GET", "/users/me/settings/timezone")
                .then(s => (s && s.value) || fallback)
                .catch(() => fallback)
        }
        return timezonePromise
    }

    // Google abbreviates calendar ids inside data-eventid, e.g. "jane@m" = jane@gmail.com
    const CAL_SUFFIXES = {
        m: "gmail.com",
        g: "group.calendar.google.com",
        v: "group.v.calendar.google.com",
        i: "import.calendar.google.com"
    }

    // data-eventid is base64("<eventId> <calendarId>")
    const decodeEventId = raw => {
        try {
            let b64 = raw.replace(/-/g, "+").replace(/_/g, "/")
            while (b64.length % 4) b64 += "="
            const parts = atob(b64).trim().split(/\s+/)
            if (parts.length < 2) return null
            let calendarId = parts[parts.length - 1]
            const short = calendarId.match(/^(.*)@([a-z])$/)
            if (short && CAL_SUFFIXES[short[2]]) calendarId = `${short[1]}@${CAL_SUFFIXES[short[2]]}`
            return { eventId: parts[0], calendarId }
        } catch (e) {
            return null
        }
    }

    // ---- time helpers (all in the calendar's display time zone) -------------------------

    const formatters = {}
    const partsIn = (date, tz) => {
        const f = (formatters[tz] =
            formatters[tz] ||
            new Intl.DateTimeFormat("en-US", {
                timeZone: tz,
                hourCycle: "h23",
                year: "numeric",
                month: "numeric",
                day: "numeric",
                hour: "numeric",
                minute: "numeric",
                second: "numeric"
            }))
        const p = {}
        f.formatToParts(date).forEach(({ type, value }) => (p[type] = Number(value)))
        p.hour = p.hour % 24
        return p
    }
    const minutesOfDay = (date, tz) => {
        const p = partsIn(date, tz)
        return p.hour * 60 + p.minute + p.second / 60
    }
    const offsetMinutes = (date, tz) => {
        const p = partsIn(date, tz)
        const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
        return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / MINUTE)
    }
    const dayKey = (date, tz) => {
        const p = partsIn(date, tz)
        return `${p.year}-${p.month}-${p.day}`
    }
    const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * MINUTE)
    const startOfDay = (date, tz) => new Date(date.getTime() - minutesOfDay(date, tz) * MINUTE)
    const snapTo = (date, step, tz) => {
        const m = minutesOfDay(date, tz)
        return addMinutes(date, Math.round(m / step) * step - m)
    }
    // Same wall-clock time, `days` days later (keeps 10:00 at 10:00 across a DST change)
    const shiftDays = (date, days, tz) => {
        if (!days) return date
        const moved = new Date(date.getTime() + days * DAY)
        return addMinutes(moved, offsetMinutes(date, tz) - offsetMinutes(moved, tz))
    }
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
    const clampDate = (date, min, max) => new Date(clamp(date.getTime(), min.getTime(), max.getTime()))

    // ---- the times written inside an event chip -------------------------------------------
    // Google writes e.g. "10 – 11am", "10:30am – 12pm", "14:00 – 15:00" or "Standup, 10am".
    // While dragging, those are rewritten in the same style so the chip shows the new times.

    const T = "\\d{1,2}(?::\\d{2})?(?:\\s?[ap]\\.?m\\.?)?"
    const RANGE_RE = new RegExp(`(${T})(\\s*[–—-]\\s*)(${T})`, "i")
    const SINGLE_RE = /\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?|\d{1,2}\s?[ap]\.?m\.?/i
    const SUFFIX_RE = /\s?[ap]\.?m\.?$/i
    const looksLikeTime = s => /:\d{2}|[ap]\.?m/i.test(s)
    const pad = n => String(n).padStart(2, "0")

    // Same am/pm spelling as the sample ("am", " AM", "a.m."), for the given half of the day
    const suffixLike = (sample, pm) =>
        sample.replace(/[ap]/i, ch => (ch === ch.toUpperCase() ? (pm ? "P" : "A") : pm ? "p" : "a"))

    const clockLike = (date, tz, style) => {
        const { hour, minute } = partsIn(date, tz)
        if (style.twelve) {
            const h = hour % 12 || 12
            return minute || style.zeroMinutes ? `${h}:${pad(minute)}` : `${h}`
        }
        return `${style.padHour ? pad(hour) : hour}:${pad(minute)}`
    }

    const rewriteRange = (m, start, end, tz) => {
        const [, a, sep, b] = m
        const sampleSuffix = (b.match(SUFFIX_RE) || a.match(SUFFIX_RE) || [""])[0]
        const style = { twelve: !!sampleSuffix, zeroMinutes: /:00/.test(a + b), padHour: /^0\d/.test(a) }
        const startPm = partsIn(start, tz).hour >= 12
        const endPm = partsIn(end, tz).hour >= 12
        let s = clockLike(start, tz, style)
        let e = clockLike(end, tz, style)
        if (style.twelve) {
            if (SUFFIX_RE.test(a) || startPm !== endPm) s += suffixLike(sampleSuffix, startPm)
            e += suffixLike(sampleSuffix, endPm)
        }
        return `${s}${sep}${e}`
    }

    const rewriteSingle = (token, start, tz) => {
        const sampleSuffix = (token.match(SUFFIX_RE) || [""])[0]
        const style = { twelve: !!sampleSuffix, zeroMinutes: /:/.test(token), padHour: /^0\d/.test(token) }
        const text = clockLike(start, tz, style)
        return style.twelve ? text + suffixLike(sampleSuffix, partsIn(start, tz).hour >= 12) : text
    }

    // The visible text nodes in the chip that contain times
    const collectTimeTexts = box => {
        const out = []
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.parentElement || !node.parentElement.closest('[aria-hidden="true"]')) continue
            const text = node.nodeValue
            const range = text.match(RANGE_RE)
            if (range && looksLikeTime(range[1] + range[3])) out.push({ node, original: text, range })
            else {
                const single = text.match(SINGLE_RE)
                if (single) out.push({ node, original: text, single: single[0] })
            }
        }
        return out
    }

    const writeTimes = (texts, start, end, tz) =>
        texts.forEach(t => {
            if (!t.node.isConnected) return
            const value = t.range
                ? t.original.replace(t.range[0], rewriteRange(t.range, start, end, tz))
                : t.original.replace(t.single, rewriteSingle(t.single, start, tz))
            if (t.node.nodeValue !== value) t.node.nodeValue = value
        })

    const restoreTimes = texts =>
        texts.forEach(t => {
            if (t.node.isConnected && t.node.nodeValue !== t.original) t.node.nodeValue = t.original
        })

    // ---- DOM helpers -------------------------------------------------------------------------

    // A timed event in the day/week time grid: has data-eventid, an inline height, and sits in a
    // tall gridcell column.
    const findTimedEvent = target => {
        if (!(target instanceof Element)) return null
        const holder = target.closest("[data-eventid]")
        if (!holder) return null
        const button = target.closest('[role="button"]')
        const candidates = [
            button && (button === holder || holder.contains(button)) ? button : null,
            holder,
            holder.querySelector('[role="button"]')
        ]
        const box = candidates.find(c => c && c.style.height)
        if (!box) return null
        const column = holder.closest('[role="gridcell"]')
        if (!column || column.getBoundingClientRect().height < MIN_COLUMN_HEIGHT) return null
        const ids = decodeEventId(holder.dataset.eventid || "")
        if (!ids) return null
        return { holder, box, column, ...ids }
    }

    // Like findTimedEvent, but also finds the event when the pointer is on something drawn over it,
    // such as Google's bottom resize handle (which isn't always inside the event element).
    const findTimedEventAt = e => {
        const direct = findTimedEvent(e.target)
        if (direct) return direct
        const stack = document.elementsFromPoint(e.clientX, e.clientY)
        for (const el of stack) {
            const found = findTimedEvent(el)
            if (found) return found
        }
        // Just below an event's bottom edge: the handle can hang slightly below the event
        const column = stack.map(el => el.closest && el.closest('[role="gridcell"]')).find(Boolean)
        if (!column) return null
        for (const holder of column.querySelectorAll("[data-eventid]")) {
            const found = findTimedEvent(holder)
            if (!found) continue
            const r = found.box.getBoundingClientRect()
            if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.bottom - 2 && e.clientY <= r.bottom + HANDLE_BELOW) {
                return found
            }
        }
        return null
    }

    // All day columns of the time grid, left to right
    const findColumns = column => {
        const ref = column.getBoundingClientRect()
        return Array.from(document.querySelectorAll('[role="gridcell"]'))
            .filter(c => {
                const r = c.getBoundingClientRect()
                return Math.abs(r.top - ref.top) < 3 && Math.abs(r.height - ref.height) < 3 && r.width > 0
            })
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    }

    // Google's data-datekey packs a date as ((year - 1970) << 9) | (month << 5) | day
    const columnDate = column => {
        const key = parseInt(column.getAttribute("data-datekey"), 10)
        if (!(key > 0)) return null
        const year = (key >> 9) + 1970
        const month = (key >> 5) & 15
        const day = key & 31
        if (month < 1 || month > 12 || day < 1) return null
        return Date.UTC(year, month - 1, day)
    }

    const dayDifference = (columns, from, to) => {
        const a = columnDate(from)
        const b = columnDate(to)
        if (a !== null && b !== null) return Math.round((b - a) / DAY)
        return columns.indexOf(to) - columns.indexOf(from)
    }

    const findScroller = el => {
        for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
            const oy = getComputedStyle(node).overflowY
            if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1) return node
        }
        return null
    }

    // ---- UI: styles, toast, guest dialog ------------------------------------------------------

    const injectStyles = () => {
        if (document.getElementById("calmerge-drag-style")) return
        const style = document.createElement("style")
        style.id = "calmerge-drag-style"
        style.textContent = `
            .calmerge-top-hover, .calmerge-top-hover * { cursor: ns-resize !important; }
            html.calmerge-dragging-ns, html.calmerge-dragging-ns * { cursor: ns-resize !important; }
            html.calmerge-dragging-move, html.calmerge-dragging-move * { cursor: grabbing !important; }
            html.calmerge-dragging, html.calmerge-dragging * { user-select: none !important; }
            .calmerge-create-ghost {
                position: fixed; z-index: 2147483000; pointer-events: none; box-sizing: border-box;
                border-radius: 4px; padding: 2px 8px; overflow: hidden;
                background: rgb(3, 155, 229); color: #fff; font: 12px/16px "Google Sans", Roboto, Arial, sans-serif;
                box-shadow: 0 6px 10px rgba(0,0,0,.14), 0 1px 18px rgba(0,0,0,.12), 0 3px 5px rgba(0,0,0,.2);
            }
            .calmerge-create-ghost div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .calmerge-toast {
                position: fixed; left: 24px; bottom: 24px; z-index: 2147483001; display: flex; gap: 16px;
                align-items: center; max-width: 520px; padding: 14px 16px; border-radius: 4px;
                background: #323232; color: #fff; font: 14px/20px Roboto, Arial, sans-serif;
                box-shadow: 0 3px 5px -1px rgba(0,0,0,.2), 0 6px 10px rgba(0,0,0,.14);
            }
            .calmerge-toast button, .calmerge-dialog button {
                background: none; border: 0; cursor: pointer; font: 500 14px Roboto, Arial, sans-serif;
                padding: 6px 8px; border-radius: 4px;
            }
            .calmerge-toast button { color: #8ab4f8; }
            .calmerge-dialog-backdrop {
                position: fixed; inset: 0; z-index: 2147483002; background: rgba(0,0,0,.4);
                display: flex; align-items: center; justify-content: center;
            }
            .calmerge-dialog {
                background: #fff; color: #202124; border-radius: 8px; padding: 24px; max-width: 420px;
                font: 14px/20px Roboto, Arial, sans-serif; box-shadow: 0 24px 38px rgba(0,0,0,.14);
            }
            .calmerge-dialog p { margin: 0 0 20px; }
            .calmerge-dialog .calmerge-actions { display: flex; justify-content: flex-end; gap: 8px; }
            .calmerge-dialog button { color: #1a73e8; }
        `
        ;(document.head || document.documentElement).appendChild(style)
    }

    let toastEl = null
    let toastTimer = null
    const toast = (message, action) => {
        injectStyles()
        if (toastEl) toastEl.remove()
        clearTimeout(toastTimer)
        toastEl = document.createElement("div")
        toastEl.className = "calmerge-toast"
        toastEl.setAttribute("role", "status")
        const text = document.createElement("span")
        text.textContent = message
        toastEl.appendChild(text)
        if (action) {
            const button = document.createElement("button")
            button.textContent = action.label
            button.onclick = () => {
                toastEl && toastEl.remove()
                action.run()
            }
            toastEl.appendChild(button)
        }
        document.body.appendChild(toastEl)
        const el = toastEl
        toastTimer = setTimeout(() => el.remove(), action ? 10000 : 6000)
    }

    // Google asks this when you move an event that has guests
    const askSendUpdates = () =>
        new Promise(resolve => {
            injectStyles()
            const backdrop = document.createElement("div")
            backdrop.className = "calmerge-dialog-backdrop"
            backdrop.innerHTML = `
                <div class="calmerge-dialog" role="dialog" aria-modal="true">
                    <p>Would you like to send update emails to existing Google Calendar guests?</p>
                    <div class="calmerge-actions">
                        <button data-choice="cancel">Back</button>
                        <button data-choice="none">Don't send</button>
                        <button data-choice="all">Send</button>
                    </div>
                </div>`
            const done = choice => {
                backdrop.remove()
                document.removeEventListener("keydown", onKey, true)
                resolve(choice === "cancel" ? null : choice)
            }
            const onKey = e => {
                if (e.key === "Escape") {
                    e.stopImmediatePropagation()
                    done("cancel")
                }
            }
            backdrop.addEventListener("click", e => {
                const choice = e.target.closest("[data-choice]")
                if (choice) done(choice.dataset.choice)
                else if (e.target === backdrop) done("cancel")
            })
            document.addEventListener("keydown", onKey, true)
            document.body.appendChild(backdrop)
            backdrop.querySelector('[data-choice="all"]').focus()
        })

    // ---- the preview: the event element itself, moved and resized ----------------------------

    const PREVIEW_STYLES = ["transform", "height", "zIndex", "boxShadow", "transition"]

    const startPreview = p => {
        const box = p.found.box
        p.savedStyle = {}
        PREVIEW_STYLES.forEach(k => (p.savedStyle[k] = box.style[k]))
        p.boxHeight = box.getBoundingClientRect().height
        p.timeTexts = collectTimeTexts(box)
        box.style.transition = "none"
        box.style.zIndex = "1000"
        if (p.kind === "move") box.style.boxShadow = "0 6px 10px rgba(0,0,0,.14), 0 1px 18px rgba(0,0,0,.12), 0 3px 5px rgba(0,0,0,.2)"
    }

    const showPreview = (p, { dStartPx, dEndPx, dx }) => {
        const box = p.found.box
        box.style.transform =
            dx || dStartPx ? `${p.savedStyle.transform || ""} translate(${dx}px, ${dStartPx}px)`.trim() : p.savedStyle.transform
        box.style.height = `${Math.max(p.boxHeight + dEndPx - dStartPx, 4)}px`
    }

    // Put the event back exactly as Google drew it
    const restorePreview = p => {
        if (!p.savedStyle) return
        const box = p.found.box
        if (box.isConnected) PREVIEW_STYLES.forEach(k => (box.style[k] = p.savedStyle[k]))
        restoreTimes(p.timeTexts || [])
    }

    // After saving: keep the event at its new place until Google Calendar redraws it itself
    const keepPreview = p => {
        const box = p.found.box
        ;["zIndex", "boxShadow", "transition"].forEach(k => (box.style[k] = p.savedStyle[k]))
        const ours = { top: box.style.top, height: box.style.height, transform: box.style.transform }
        const observer = new MutationObserver(() => {
            if (!box.isConnected) return observer.disconnect()
            // Google redrew the event in place (new top/height): drop our offset so it isn't applied twice
            if (box.style.top !== ours.top || (box.style.height !== ours.height && box.style.transform === ours.transform)) {
                if (box.style.transform === ours.transform) box.style.transform = p.savedStyle.transform
                observer.disconnect()
            }
        })
        observer.observe(box, { attributes: true, attributeFilter: ["style"] })
        p.stopKeeping = () => observer.disconnect()
    }

    // ---- drag state machine ----------------------------------------------------------------------

    let press = null // pointer is down on an event; becomes a drag once it moves
    let swallowUntilUp = false // after Esc: eat the rest of this press so Google doesn't see a click
    let suppressClickUntil = 0
    let swallowAltKeyUp = false
    let hovered = null

    const zoneFor = (found, e) => {
        const rect = found.box.getBoundingClientRect()
        const y = e.clientY - rect.top
        const edge = Math.max(3, Math.min(8, rect.height * 0.25))
        if (y <= edge) return "start"
        if (y >= rect.height - edge) return "end"
        // Google's own bottom resize handle, drawn over the event
        const onHandle =
            e.target instanceof Element &&
            !found.box.contains(e.target) &&
            /resize/.test(getComputedStyle(e.target).cursor)
        if (onHandle && y > rect.height / 2) return "end"
        return "move"
    }

    const setHover = el => {
        if (hovered === el) return
        if (hovered) hovered.classList.remove("calmerge-top-hover")
        hovered = el
        if (hovered) {
            injectStyles()
            hovered.classList.add("calmerge-top-hover")
        }
    }

    let warnedStale = false

    // What's needed to hand a press back to Google unchanged
    const downInitFrom = e => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        button: e.button,
        buttons: e.buttons,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        isPrimary: e.isPrimary
    })

    const pressBase = (e, column) => {
        const colRect = column.getBoundingClientRect()
        if (e.altKey) swallowAltKeyUp = true // releasing it later mustn't focus the browser menu (Windows)
        return {
            target: e.target,
            pointerId: e.pointerId,
            downInit: downInitFrom(e),
            startX: e.clientX,
            startY: e.clientY,
            startYInCol: e.clientY - colRect.top,
            pxPerMin: colRect.height / (24 * 60),
            alt: e.altKey,
            shift: e.shiftKey,
            lastX: e.clientX,
            lastY: e.clientY,
            dragging: false
        }
    }

    const beginPress = e => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || settings.dragEdit === false) return false
        const found = findTimedEventAt(e)
        if (!found) return beginCreatePress(e)
        if (!isEnabled()) return false
        if (!extensionAlive()) {
            if (!warnedStale) {
                warnedStale = true
                toast(STALE_MESSAGE, { label: "Reload", run: () => window.location.reload() })
            }
            return false
        }
        const kind = zoneFor(found, e)
        debug("press", kind, found.eventId, found.calendarId, e.target)
        press = { found, kind, ...pressBase(e, found.column) }
        return true
    }

    // ---- creating an event: Alt/Shift + drag on empty space -------------------------------------

    const columnAt = e => {
        for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
            const column = el.closest && el.closest('[role="gridcell"]')
            if (column && column.getBoundingClientRect().height >= MIN_COLUMN_HEIGHT) return column
        }
        return null
    }

    // Only with Alt or Shift held at the start: plain drags on empty space stay Google's own
    const beginCreatePress = e => {
        if (!(e.altKey || e.shiftKey) || !extensionAlive()) return false
        if (e.target instanceof Element && e.target.closest('[data-eventid], [role="dialog"]')) return false
        const column = columnAt(e)
        if (!column) return false
        const date = columnDate(column)
        if (date === null) {
            debug("can't tell this column's date (no data-datekey)", column)
            return false
        }
        debug("create press", new Date(date).toISOString().slice(0, 10))
        press = { kind: "create", column, date, ...pressBase(e, column) }
        return true
    }

    // Minutes after midnight covered by the new event: from the slot where the drag started to the
    // slot under the pointer, in either direction, at least one step long (like Google)
    const createRange = p => {
        const step = stepFor(p)
        const colTop = p.column.getBoundingClientRect().top
        const a = p.startYInCol / p.pxPerMin
        const b = (p.lastY - colTop) / p.pxPerMin
        const start = Math.floor(clamp(Math.min(a, b), 0, 24 * 60 - step) / step) * step
        let end = Math.ceil(clamp(Math.max(a, b), 0, 24 * 60) / step) * step
        if (end - start < step) end = start + step
        return { start, end: Math.min(end, 24 * 60) }
    }

    // Write the times like the event chips on the page do (e.g. "10:05 – 11:20am" or "10:05 – 11:20")
    const timeSample = () => {
        for (const el of document.querySelectorAll('[data-eventid] [aria-hidden="true"]')) {
            const m = el.textContent.match(RANGE_RE)
            if (m && looksLikeTime(m[1] + m[3])) return m
        }
        const twelveHour = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12
        return (twelveHour ? "9 – 10am" : "09:00 – 10:00").match(RANGE_RE)
    }

    const startCreateDrag = p => {
        const ghost = document.createElement("div")
        ghost.className = "calmerge-create-ghost"
        const title = document.createElement("div")
        title.textContent = "(No title)"
        const time = document.createElement("div")
        ghost.append(title, time)
        document.body.appendChild(ghost)
        p.ghost = ghost
        p.ghostTime = time
        p.sample = timeSample()
    }

    const renderCreate = p => {
        const { start, end } = createRange(p)
        const col = p.column.getBoundingClientRect()
        p.ghost.style.top = `${col.top + start * p.pxPerMin}px`
        p.ghost.style.height = `${Math.max((end - start) * p.pxPerMin - 1, 8)}px`
        p.ghost.style.left = `${col.left}px`
        p.ghost.style.width = `${Math.max(col.width - 10, 24)}px`
        // The column's date at midnight UTC plus the minutes, read back in UTC = the wall-clock time
        p.ghostTime.textContent = rewriteRange(p.sample, new Date(p.date + start * MINUTE), new Date(p.date + end * MINUTE), "UTC")
    }

    // Google's full event editor, with the dates filled in (wall-clock times in the calendar's zone)
    const eventEditUrl = (date, start, end) => {
        const stamp = minutes => {
            const d = new Date(date + minutes * MINUTE)
            return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`
        }
        const base = (window.location.pathname.match(/^\/calendar\/u\/\d+/) || ["/calendar"])[0]
        return `${window.location.origin}${base}/r/eventedit?dates=${stamp(start)}/${stamp(end)}`
    }

    const finishCreate = p => {
        const { start, end } = createRange(p)
        renderCreate(p)
        const url = eventEditUrl(p.date, start, end)
        debug("create", url)
        window.location.assign(url)
    }

    // Google never saw the press, so give it the press now and let the real release through
    const replayPress = p => {
        const { target, downInit } = p
        if (!target.isConnected) return
        try {
            target.dispatchEvent(new PointerEvent("pointerdown", downInit))
        } catch (err) {}
        target.dispatchEvent(new MouseEvent("mousedown", downInit))
    }

    // Scroll the grid while the pointer is near its top or bottom edge
    const startAutoScroll = p => {
        p.scroller = findScroller(p.column || p.found.column)
        if (!p.scroller) return
        const tick = () => {
            if (press !== p || !p.dragging) return
            const r = p.scroller.getBoundingClientRect()
            const edge = 40
            let speed = 0
            if (p.lastY < r.top + edge) speed = -Math.ceil((r.top + edge - p.lastY) / 4)
            else if (p.lastY > r.bottom - edge) speed = Math.ceil((p.lastY - (r.bottom - edge)) / 4)
            if (speed) {
                p.scroller.scrollTop += clamp(speed, -20, 20)
                render()
            }
            p.raf = requestAnimationFrame(tick)
        }
        p.raf = requestAnimationFrame(tick)
    }

    const startDrag = () => {
        const p = press
        p.dragging = true
        if (p.kind === "create") {
            injectStyles()
            document.documentElement.classList.add("calmerge-dragging", "calmerge-dragging-ns")
            try {
                p.target.setPointerCapture(p.pointerId)
            } catch (err) {}
            startCreateDrag(p)
            startAutoScroll(p)
            return
        }
        p.columns = p.kind === "move" ? findColumns(p.found.column) : [p.found.column]
        if (!p.columns.includes(p.found.column)) p.columns.push(p.found.column)
        startPreview(p)
        document.documentElement.classList.add("calmerge-dragging", p.kind === "move" ? "calmerge-dragging-move" : "calmerge-dragging-ns")
        injectStyles()
        setHover(null)
        try {
            p.target.setPointerCapture(p.pointerId)
        } catch (err) {}

        const { eventId, calendarId } = p.found
        p.dataPromise = Promise.all([api("GET", eventPath(calendarId, eventId)), getCalendarTimezone()]).then(
            ([event, tz]) => (p.data = { event, tz })
        )
        p.dataPromise.then(() => press === p && render(), () => {})
        p.dataPromise.catch(() => {}) // errors are reported when the drag ends

        startAutoScroll(p)
    }

    // Where the pointer has dragged things, in minutes and days, before snapping
    const rawMovement = p => {
        let column = p.found.column
        if (p.kind === "move") {
            column =
                p.columns.find(c => {
                    const r = c.getBoundingClientRect()
                    return p.lastX >= r.left && p.lastX < r.right
                }) ||
                p.columns.reduce((best, c) => {
                    const r = c.getBoundingClientRect()
                    const d = Math.abs(p.lastX - (r.left + r.width / 2))
                    return !best || d < best.d ? { c, d } : best
                }, null).c
        }
        const colTop = p.found.column.getBoundingClientRect().top
        const minutes = (p.lastY - colTop - p.startYInCol) / p.pxPerMin
        const days = p.kind === "move" ? dayDifference(p.columns, p.found.column, column) : 0
        return { minutes, days, column }
    }

    const hasTimes = data => data && data.event.start && data.event.start.dateTime && data.event.end && data.event.end.dateTime

    // New start/end for the current pointer position
    const computeTimes = (p, { minutes, days }) => {
        const step = stepFor(p)
        const { event, tz } = p.data
        const s0 = new Date(event.start.dateTime)
        const e0 = new Date(event.end.dateTime)
        const dayStart = startOfDay(s0, tz)
        const dayEnd = addMinutes(dayStart, 24 * 60)
        let start = s0
        let end = e0
        if (p.kind === "end") {
            end = clampDate(snapTo(addMinutes(e0, minutes), step, tz), addMinutes(s0, step), dayEnd)
        } else if (p.kind === "start") {
            start = clampDate(snapTo(addMinutes(s0, minutes), step, tz), dayStart, addMinutes(e0, -step))
        } else {
            const duration = e0 - s0
            const latest = new Date(Math.max(dayEnd - duration, dayStart.getTime()))
            start = clampDate(snapTo(clampDate(addMinutes(s0, minutes), dayStart, latest), step, tz), dayStart, latest)
            start = shiftDays(start, days, tz)
            end = new Date(start.getTime() + duration)
        }
        return { start, end, s0, e0, step }
    }

    const render = () => {
        const p = press
        if (!p || !p.dragging) return
        if (p.kind === "create") return renderCreate(p)
        const move = rawMovement(p)
        const step = stepFor(p)
        let dStart = 0
        let dEnd = 0
        if (hasTimes(p.data)) {
            const t = computeTimes(p, move)
            const dayShift = move.days * 24 * 60
            dStart = (t.start - t.s0) / MINUTE - dayShift
            dEnd = (t.end - t.e0) / MINUTE - dayShift
            writeTimes(p.timeTexts, t.start, t.end, p.data.tz)
        } else {
            // Event details still loading: move in whole steps for now
            const d = Math.round(move.minutes / step) * step
            if (p.kind !== "end") dStart = d
            if (p.kind !== "start") dEnd = d
        }
        const dx = move.column.getBoundingClientRect().left - p.found.column.getBoundingClientRect().left
        showPreview(p, { dStartPx: dStart * p.pxPerMin, dEndPx: dEnd * p.pxPerMin, dx })
    }

    const endDragVisuals = p => {
        document.documentElement.classList.remove("calmerge-dragging", "calmerge-dragging-move", "calmerge-dragging-ns")
        cancelAnimationFrame(p.raf)
        try {
            p.target.releasePointerCapture(p.pointerId)
        } catch (err) {}
    }

    const cancelDrag = () => {
        const p = press
        press = null
        if (!p) return
        if (p.dragging) {
            endDragVisuals(p)
            restorePreview(p)
            if (p.ghost) p.ghost.remove()
            swallowUntilUp = true
        }
    }

    const describeError = err => {
        if (err && /context invalidated/i.test(err.message || "")) return STALE_MESSAGE
        if (err && err.status === 403) return "You don't have permission to change this event."
        if (err && err.status === 404) return "Couldn't find this event through the Google Calendar API."
        return (err && err.message) || "Something went wrong."
    }

    const finishDrag = async () => {
        const p = press
        press = null
        endDragVisuals(p)
        if (p.kind === "create") return finishCreate(p)
        try {
            await p.dataPromise
            const { event, tz } = p.data
            if (!hasTimes(p.data)) throw new Error("All-day events can't be dragged this way.")
            if (event.organizer && event.organizer.self === false && !event.guestsCanModify) {
                throw new Error("Only the organizer can change this event's time.")
            }
            if (dayKey(new Date(event.start.dateTime), tz) !== dayKey(new Date(new Date(event.end.dateTime) - 1), tz)) {
                throw new Error("Events that run past midnight can't be dragged this way yet.")
            }

            const move = rawMovement(p)
            const { start, end, s0, e0 } = computeTimes(p, move)
            const dayShift = move.days * 24 * 60
            const dx = move.column.getBoundingClientRect().left - p.found.column.getBoundingClientRect().left
            showPreview(p, {
                dStartPx: ((start - s0) / MINUTE - dayShift) * p.pxPerMin,
                dEndPx: ((end - e0) / MINUTE - dayShift) * p.pxPerMin,
                dx
            })
            writeTimes(p.timeTexts, start, end, tz)
            if (start.getTime() === s0.getTime() && end.getTime() === e0.getTime()) return restorePreview(p)

            const guests = (event.attendees || []).filter(a => !a.self && !a.resource)
            let sendUpdates = "none"
            if (guests.length) {
                sendUpdates = await askSendUpdates()
                if (!sendUpdates) return restorePreview(p)
            }

            const timeField = (date, original) => {
                const field = { dateTime: date.toISOString() }
                if (original.timeZone) field.timeZone = original.timeZone
                return field
            }
            keepPreview(p)
            const path = eventPath(p.found.calendarId, event.id || p.found.eventId)
            await api("PATCH", path, {
                query: { sendUpdates },
                body: { start: timeField(start, event.start), end: timeField(end, event.end) }
            })
            const undo = () => {
                p.stopKeeping()
                restorePreview(p)
                api("PATCH", path, { query: { sendUpdates }, body: { start: event.start, end: event.end } }).then(
                    () => toast("Change undone."),
                    err => toast(`Couldn't undo: ${describeError(err)}`)
                )
            }
            toast(event.recurringEventId ? "Event updated (only this occurrence)" : "Event updated", {
                label: "Undo",
                run: undo
            })
        } catch (err) {
            if (p.stopKeeping) p.stopKeeping()
            restorePreview(p)
            toast(describeError(err))
        }
    }

    // ---- event listeners (capture phase on window, registered before Google's) ----------------

    const on = (type, fn) => window.addEventListener(type, e => e.isTrusted && fn(e), true)

    on("pointerdown", e => {
        swallowUntilUp = false
        if (press) cancelDrag()
        if (beginPress(e)) e.stopImmediatePropagation()
    })

    on("mousedown", e => {
        if (press || swallowUntilUp) {
            e.stopImmediatePropagation()
            e.preventDefault()
        }
    })

    // Google's own drag-and-drop must never start on an event we're handling
    on("dragstart", e => {
        if (press || swallowUntilUp) {
            e.stopImmediatePropagation()
            e.preventDefault()
        }
    })

    on("pointermove", e => {
        if (!press) {
            if (!isActive() || e.buttons) return setHover(null)
            const found = findTimedEvent(e.target)
            return setHover(found && zoneFor(found, e) === "start" ? found.box : null)
        }
        if (e.pointerId !== press.pointerId) return
        press.lastX = e.clientX
        press.lastY = e.clientY
        e.stopImmediatePropagation()
        if (!press.dragging) {
            if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < DRAG_THRESHOLD) return
            startDrag()
        }
        if (press.alt !== e.altKey) {
            press.alt = e.altKey
            if (e.altKey) swallowAltKeyUp = true
        }
        press.shift = e.shiftKey
        render()
    })

    on("mousemove", e => {
        if (press || swallowUntilUp) e.stopImmediatePropagation()
    })

    on("pointerup", e => {
        if (swallowUntilUp) {
            e.stopImmediatePropagation()
            suppressClickUntil = Date.now() + 500
            return
        }
        if (!press || e.pointerId !== press.pointerId) return
        if (!press.dragging) {
            const p = press
            press = null
            replayPress(p) // a plain click: hand it back to Google
            return
        }
        e.stopImmediatePropagation()
        e.preventDefault()
        suppressClickUntil = Date.now() + 500
        press.lastX = e.clientX
        press.lastY = e.clientY
        press.alt = e.altKey
        press.shift = e.shiftKey
        finishDrag()
    })

    on("mouseup", e => {
        if (swallowUntilUp || Date.now() < suppressClickUntil) {
            e.stopImmediatePropagation()
            e.preventDefault()
        }
    })

    on("click", e => {
        if (swallowUntilUp || Date.now() < suppressClickUntil) {
            swallowUntilUp = false
            suppressClickUntil = 0
            e.stopImmediatePropagation()
            e.preventDefault()
        }
    })

    on("pointercancel", () => cancelDrag())
    window.addEventListener("blur", () => {
        const waitingForEvent = press && press.dragging && press.kind !== "create" && !press.data
        cancelDrag()
        // Most likely the Google sign-in window opened and took focus
        if (waitingForEvent) toast("Drag cancelled. If a Google sign-in window opened, finish signing in, then drag again.")
    })

    // Alt switches between 15- and 5-minute steps; Google must not see Alt during our drag
    // (it would otherwise treat the drag as "duplicate"), and Windows must not focus the browser
    // menu when Alt is released.
    on("keydown", e => {
        if (!press) return
        if (e.key === "Escape" && press.dragging) {
            e.stopImmediatePropagation()
            e.preventDefault()
            cancelDrag()
        } else if (e.key === "Alt") {
            e.stopImmediatePropagation()
            e.preventDefault()
            swallowAltKeyUp = true
            if (!press.alt) {
                press.alt = true
                render()
            }
        } else if (e.key === "Shift") {
            // Shift switches to 30-minute steps
            e.stopImmediatePropagation()
            if (!press.shift) {
                press.shift = true
                render()
            }
        }
    })

    on("keyup", e => {
        if (e.key === "Shift") {
            if (!press) return
            e.stopImmediatePropagation()
            if (press.shift) {
                press.shift = false
                render()
            }
            return
        }
        if (e.key !== "Alt") return
        if (swallowAltKeyUp || press) {
            e.stopImmediatePropagation()
            e.preventDefault()
            if (!press) swallowAltKeyUp = false
        }
        if (press && press.alt) {
            press.alt = false
            render()
        }
    })

    // Keep the preview aligned with the grid while it scrolls
    window.addEventListener("scroll", () => press && press.dragging && render(), true)
})()
