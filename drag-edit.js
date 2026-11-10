// Drag-to-edit for timed events in Google Calendar's day/week views (added in this fork)
//
// - Drag an event's TOP edge to change its start time (Google only lets you drag the bottom edge).
//
// Google Calendar's own drag code has no start-time handle, so while
// this feature is on the extension runs the whole drag itself (move, top edge, bottom edge) and
// saves the result through the Google Calendar API (see background.js). Clicks without a drag are
// handed back to Google untouched, so opening an event still works as before.
//
// The feature only switches on once a Google API client id is set in the popup. Without one,
// Google's own dragging is left alone.

;(() => {
    "use strict"

    const STEP = 15 // minutes, like Google Calendar
    const DRAG_THRESHOLD = 4 // px of movement before a press becomes a drag
    const MIN_COLUMN_HEIGHT = 300 // px; day/week time-grid columns are much taller than month cells
    const PIN_TIMEOUT = 30000 // ms to wait for Google Calendar to redraw a saved event
    const MINUTE = 60 * 1000
    const DAY = 24 * 60 * MINUTE

    // ---- settings -------------------------------------------------------------------------

    const settings = { dragEdit: true, oauthClientId: "", detectedEmail: "" }
    const isActive = () => settings.dragEdit !== false && !!(settings.oauthClientId || "").trim()

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
        return p
    }
    const minutesOfDay = (date, tz) => {
        const p = partsIn(date, tz)
        return (p.hour % 24) * 60 + p.minute + p.second / 60
    }
    const offsetMinutes = (date, tz) => {
        const p = partsIn(date, tz)
        const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
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

    const formatTime = (date, tz) =>
        date.toLocaleTimeString(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" })
    const formatDay = (date, tz) => date.toLocaleDateString(undefined, { timeZone: tz, weekday: "short", day: "numeric" })

    // ---- DOM helpers -------------------------------------------------------------------------

    // A timed event in the day/week time grid: has data-eventid, an inline height, and sits in a
    // tall gridcell column.
    const findTimedEvent = target => {
        if (!(target instanceof Element)) return null
        const holder = target.closest("[data-eventid]")
        if (!holder) return null
        let box = target.closest('[role="button"]')
        if (!box || !(holder === box || holder.contains(box))) box = holder
        if (!box.style.height && holder.style.height) box = holder
        if (!box.style.height) return null
        const column = holder.closest('[role="gridcell"]')
        if (!column || column.getBoundingClientRect().height < MIN_COLUMN_HEIGHT) return null
        const ids = decodeEventId(holder.dataset.eventid || "")
        if (!ids) return null
        return { holder, box, column, ...ids }
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

    const isTransparent = color => !color || color === "transparent" || /rgba\(.*,\s*0\)$/.test(color)

    // ---- UI: styles, ghost, toast, guest dialog -------------------------------------------------

    const injectStyles = () => {
        if (document.getElementById("calmerge-drag-style")) return
        const style = document.createElement("style")
        style.id = "calmerge-drag-style"
        style.textContent = `
            .calmerge-top-hover, .calmerge-top-hover * { cursor: ns-resize !important; }
            html.calmerge-dragging-ns, html.calmerge-dragging-ns * { cursor: ns-resize !important; }
            html.calmerge-dragging-move, html.calmerge-dragging-move * { cursor: grabbing !important; }
            html.calmerge-dragging, html.calmerge-dragging * { user-select: none !important; }
            .calmerge-ghost {
                position: fixed; z-index: 2147483000; pointer-events: none; box-sizing: border-box;
                border-radius: 4px; padding: 2px 6px; overflow: hidden;
                font: 500 12px/16px Roboto, Arial, sans-serif;
                box-shadow: 0 6px 10px rgba(0,0,0,.14), 0 1px 18px rgba(0,0,0,.12), 0 3px 5px rgba(0,0,0,.2);
            }
            .calmerge-ghost .calmerge-ghost-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

    // The floating preview that follows the pointer. Its position is stored relative to a day
    // column, so it stays in place when the grid scrolls.
    const createGhost = found => {
        injectStyles()
        const ghost = document.createElement("div")
        ghost.className = "calmerge-ghost"
        const cs = getComputedStyle(found.box)
        ghost.style.background = !isTransparent(cs.backgroundColor)
            ? cs.backgroundColor
            : !isTransparent(cs.borderTopColor)
            ? cs.borderTopColor
            : "#039be5"
        ghost.style.color = isTransparent(cs.backgroundColor) ? "#fff" : cs.color
        const title = document.createElement("div")
        title.className = "calmerge-ghost-title"
        const titleText = Array.from(found.box.querySelectorAll('[aria-hidden="true"]'))
            .map(el => el.textContent.trim())
            .filter(Boolean)[0]
        title.textContent = titleText || ""
        const time = document.createElement("div")
        ghost.append(title, time)
        document.body.appendChild(ghost)
        return { el: ghost, time, anchor: null }
    }

    const placeGhost = ghost => {
        const a = ghost.anchor
        if (!a || !a.column.isConnected) return
        const col = a.column.getBoundingClientRect()
        const top = col.top + a.topInCol
        ghost.el.style.top = `${top}px`
        ghost.el.style.height = `${Math.max(a.bottomInCol - a.topInCol, 8)}px`
        ghost.el.style.left = `${col.left + a.leftFrac * col.width}px`
        ghost.el.style.width = `${Math.max(a.widthFrac * col.width, 24)}px`
    }

    // ---- drag state machine ----------------------------------------------------------------------

    let press = null // pointer is down on an event; becomes a drag once it moves
    let swallowUntilUp = false // after Esc: eat the rest of this press so Google doesn't see a click
    let suppressClickUntil = 0
    let hovered = null
    const pinned = new Set()

    const zoneFor = (found, e) => {
        const rect = found.box.getBoundingClientRect()
        const y = e.clientY - rect.top
        const edge = Math.max(3, Math.min(8, rect.height * 0.25))
        if (y <= edge) return "start"
        if (y >= rect.height - edge) return "end"
        // Google's own bottom resize handle (if the pointer is on it)
        if (y > rect.height / 2 && e.target !== found.box && /resize/.test(getComputedStyle(e.target).cursor)) return "end"
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

    const beginPress = e => {
        if (!isActive() || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return false
        const found = findTimedEvent(e.target)
        if (!found) return false
        const colRect = found.column.getBoundingClientRect()
        const boxRect = found.box.getBoundingClientRect()
        press = {
            found,
            kind: zoneFor(found, e),
            target: e.target,
            pointerId: e.pointerId,
            downInit: {
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
                pointerId: e.pointerId,
                pointerType: e.pointerType,
                isPrimary: e.isPrimary
            },
            startX: e.clientX,
            startY: e.clientY,
            startYInCol: e.clientY - colRect.top,
            pxPerMin: colRect.height / (24 * 60),
            topInCol: boxRect.top - colRect.top,
            bottomInCol: boxRect.bottom - colRect.top,
            leftFrac: (boxRect.left - colRect.left) / colRect.width,
            widthFrac: boxRect.width / colRect.width,
            lastX: e.clientX,
            lastY: e.clientY,
            dragging: false
        }
        return true
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

    const startDrag = () => {
        const p = press
        p.dragging = true
        p.columns = p.kind === "move" ? findColumns(p.found.column) : [p.found.column]
        if (!p.columns.includes(p.found.column)) p.columns.push(p.found.column)
        p.scroller = findScroller(p.found.column)
        p.ghost = createGhost(p.found)
        p.boxOpacity = p.found.box.style.opacity
        p.found.box.style.opacity = "0.4"
        document.documentElement.classList.add("calmerge-dragging", p.kind === "move" ? "calmerge-dragging-move" : "calmerge-dragging-ns")
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

        if (p.scroller) {
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

    // New start/end for the current pointer position
    const computeTimes = (p, { minutes, days }) => {
        const step = STEP
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
        const move = rawMovement(p)
        const step = STEP
        let dStart = 0
        let dEnd = 0
        let label = ""
        if (p.data && p.data.event.start && p.data.event.start.dateTime) {
            const t = computeTimes(p, move)
            const dayShift = move.days * 24 * 60
            dStart = (t.start - t.s0) / MINUTE - dayShift
            dEnd = (t.end - t.e0) / MINUTE - dayShift
            label = `${formatTime(t.start, p.data.tz)} – ${formatTime(t.end, p.data.tz)}`
            if (move.days) label = `${formatDay(t.start, p.data.tz)}, ${label}`
        } else {
            // Event details still loading: move in whole steps for now
            const d = Math.round(move.minutes / step) * step
            if (p.kind !== "end") dStart = d
            if (p.kind !== "start") dEnd = d
        }
        p.ghost.anchor = {
            column: move.column,
            topInCol: p.topInCol + dStart * p.pxPerMin,
            bottomInCol: p.bottomInCol + dEnd * p.pxPerMin,
            leftFrac: p.leftFrac,
            widthFrac: p.widthFrac
        }
        p.ghost.time.textContent = label
        placeGhost(p.ghost)
    }

    const endDragVisuals = p => {
        document.documentElement.classList.remove("calmerge-dragging", "calmerge-dragging-move", "calmerge-dragging-ns")
        cancelAnimationFrame(p.raf)
        try {
            p.target.releasePointerCapture(p.pointerId)
        } catch (err) {}
    }

    const restore = p => {
        if (p.ghost) p.ghost.el.remove()
        if (p.found.box.isConnected) p.found.box.style.opacity = p.boxOpacity || ""
    }

    const cancelDrag = () => {
        const p = press
        press = null
        if (!p) return
        if (p.dragging) {
            endDragVisuals(p)
            restore(p)
            swallowUntilUp = true
        }
    }

    // Keep the preview on screen at the new time until Google Calendar redraws the event
    const pin = p => {
        const box = p.found.box
        const col0 = p.found.column.getBoundingClientRect()
        const r0 = box.getBoundingClientRect()
        const before = { top: r0.top - col0.top, height: r0.height }
        const entry = { p }
        pinned.add(entry)
        const startedAt = Date.now()
        const check = () => {
            if (!pinned.has(entry)) return
            let redrawn = !box.isConnected || !p.found.column.isConnected
            if (!redrawn) {
                const c = p.found.column.getBoundingClientRect()
                const r = box.getBoundingClientRect()
                redrawn = Math.abs(r.top - c.top - before.top) > 2 || Math.abs(r.height - before.height) > 2
            }
            if (redrawn) return unpin(entry)
            if (Date.now() - startedAt > PIN_TIMEOUT) {
                unpin(entry)
                toast("Saved. Google Calendar hasn't redrawn the event yet, so reload to see the new time.", {
                    label: "Reload",
                    run: () => window.location.reload()
                })
                return
            }
            setTimeout(check, 400)
        }
        setTimeout(check, 400)
        return entry
    }

    const unpin = entry => {
        if (!pinned.delete(entry)) return
        restore(entry.p)
    }

    const describeError = err => {
        if (err && err.status === 403) return "You don't have permission to change this event."
        if (err && err.status === 404) return "Couldn't find this event through the Google Calendar API."
        return (err && err.message) || "Something went wrong."
    }

    const finishDrag = async () => {
        const p = press
        press = null
        endDragVisuals(p)
        let entry = null
        try {
            p.ghost.time.textContent = "Loading…"
            await p.dataPromise
            const { event, tz } = p.data
            if (!event.start || !event.start.dateTime || !event.end || !event.end.dateTime) {
                throw new Error("All-day events can't be dragged this way.")
            }
            if (event.organizer && event.organizer.self === false && !event.guestsCanModify) {
                throw new Error("Only the organizer can change this event's time.")
            }
            if (dayKey(new Date(event.start.dateTime), tz) !== dayKey(new Date(new Date(event.end.dateTime) - 1), tz)) {
                throw new Error("Events that run past midnight can't be dragged this way yet.")
            }

            render()
            const move = rawMovement(p)
            const { start, end, s0, e0 } = computeTimes(p, move)
            if (start.getTime() === s0.getTime() && end.getTime() === e0.getTime()) return restore(p)
            p.ghost.time.textContent = `${formatTime(start, tz)} – ${formatTime(end, tz)}`

            const guests = (event.attendees || []).filter(a => !a.self && !a.resource)
            let sendUpdates = "none"
            if (guests.length) {
                sendUpdates = await askSendUpdates()
                if (!sendUpdates) return restore(p)
            }

            const timeField = (date, original) => {
                const field = { dateTime: date.toISOString() }
                if (original.timeZone) field.timeZone = original.timeZone
                return field
            }
            p.ghost.time.textContent = `${formatTime(start, tz)} – ${formatTime(end, tz)} · Saving…`
            entry = pin(p)
            const path = eventPath(p.found.calendarId, event.id || p.found.eventId)
            await api("PATCH", path, {
                query: { sendUpdates },
                body: { start: timeField(start, event.start), end: timeField(end, event.end) }
            })
            p.ghost.time.textContent = `${formatTime(start, tz)} – ${formatTime(end, tz)}`
            const undo = () =>
                api("PATCH", path, { query: { sendUpdates }, body: { start: event.start, end: event.end } }).then(
                    () => toast("Change undone. Reload Google Calendar if it still shows the new time."),
                    err => toast(`Couldn't undo: ${describeError(err)}`)
                )
            toast(event.recurringEventId ? "Event updated (only this occurrence)" : "Event updated", {
                label: "Undo",
                run: undo
            })
        } catch (err) {
            if (entry) unpin(entry)
            else restore(p)
            toast(describeError(err))
        }
    }

    // ---- event listeners (capture phase on window, so they run before Google's) --------------

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

    on("pointermove", e => {
        if (!press) {
            if (!isActive() || e.buttons) return setHover(null)
            const found = findTimedEvent(e.target)
            return setHover(found && zoneFor(found, e) === "start" ? found.box : null)
        }
        if (e.pointerId !== press.pointerId) return
        press.lastX = e.clientX
        press.lastY = e.clientY
        if (!press.dragging) {
            if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < DRAG_THRESHOLD) return
            startDrag()
        }
        e.stopImmediatePropagation()
        render()
    })

    on("mousemove", e => {
        if ((press && press.dragging) || swallowUntilUp) e.stopImmediatePropagation()
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
        const waitingForEvent = press && press.dragging && !press.data
        cancelDrag()
        // Most likely the Google sign-in window opened and took focus
        if (waitingForEvent) toast("Drag cancelled. If a Google sign-in window opened, finish signing in, then drag again.")
    })

    on("keydown", e => {
        if (!press || !press.dragging) return
        if (e.key === "Escape") {
            e.stopImmediatePropagation()
            e.preventDefault()
            cancelDrag()
        }
    })

    // Keep previews aligned with the grid while it scrolls
    window.addEventListener(
        "scroll",
        () => {
            if (press && press.dragging) render()
            pinned.forEach(entry => placeGhost(entry.p.ghost))
        },
        true
    )
    window.addEventListener("resize", () => pinned.forEach(entry => placeGhost(entry.p.ghost)))
})()
