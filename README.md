<img src="icons/icon-128.png" width="64" height="64" alt="" align="right" />

Calendar Additions for Google Calendar™
=======================================

A Chrome extension that adds extra features to Google Calendar.

**Duplicate events**
- **Merge**: the same event on several of your calendars is shown as one striped,
  multi-coloured event.
- **My calendar only**: when an event shows up on several calendars, you see only the copy on *your* calendar.
  The other copies are hidden and your copy fills their space.

**Drag to edit**, in the day and week views:
- Drag an event's **top edge** to change its start time, just like dragging the bottom edge changes its end time.
- Hold **Alt** (**Option** on a Mac) while dragging to move in **5-minute steps** instead of 15. Press or release
  Alt at any point during the drag to switch between the two.
- Hold **Shift** while dragging to move in **30-minute steps**. Like Alt, it can be pressed or released mid-drag.
- **Create events** in 5- or 30-minute steps: hold **Alt** or **Shift** and drag on an empty part of the grid. When
  you let go, Google's full event editor opens with the start and end times filled in.

Changing existing events needs a one-time Google Cloud setup; see [Drag to edit](#drag-to-edit) below. Creating
events with Alt or Shift works without it.

The two groups of features have separate switches, so you can use either one on its own.

![examples](images/examples.jpg)

## Installation

Calendar Additions is not on the Chrome Web Store, so you install it as an unpacked extension. This works in Chrome and
in Chromium-based browsers such as Edge, Brave and Arc.

1. **Get the code.** Either clone the repo:
   ```bash
   git clone https://github.com/lahav-axio/google-calendar-additions.git
   ```
   or, on GitHub, click **Code → Download ZIP** and unzip it somewhere permanent. Chrome loads the extension from
   that folder every time, so don't delete or move the folder afterwards.
2. **Open the extensions page.** Go to `chrome://extensions` (in Edge, `edge://extensions`).
3. **Turn on Developer mode** with the toggle in the top-right corner.
4. **Click "Load unpacked"** and select the folder that contains `manifest.json`, which is the repo's root folder.
5. **Disable Cal Merge** if you have the Web Store version installed. Calendar Additions includes all of its
   features, and the two shouldn't run at the same time.
6. **Pin the extension.** Click the puzzle-piece icon in the toolbar, then click the pin next to
   *Calendar Additions for Google Calendar™*.
7. **Configure it.** Click the extension icon to open the settings. For example, set **Mode** to
   *My calendar only*, then reload Google Calendar.

### Updating
Run `git pull` in the folder, or download the ZIP again and replace the folder's contents. Then click the
**↻ reload** icon on the extension's card in `chrome://extensions`, and reload Google Calendar.

## Settings

The popup has two sections.

**Duplicate events**

| Setting | What it does |
|---|---|
| **Enable** | Turns merging (or *My calendar only* mode) on or off. |
| **Mode** | *Merge (blend colours)* is the original behaviour. *My calendar only* shows only your copy of duplicated events. |
| **My calendar** | Shown in *My calendar only* mode. Enter your calendar id, which is usually your email. You can enter several, separated by commas. Leave it blank to auto-detect the signed-in account. |
| **Hide events not on my calendar** | Shown in *My calendar only* mode. Also hides events that don't appear on your calendar at all. When off, only duplicates are collapsed. |
| **Style** | Shown in *Merge* mode. Sets the gradient style for merged events. |
| **Wildcard** | Events whose title contains this word (e.g. `busy`) are matched with any other event at the same time. Use `\|` to give several words. This setting works in both modes. |

**Drag to edit**

| Setting | What it does |
|---|---|
| **Enable** | Turns on drag to edit. Changing existing events also needs an API client ID; creating events with Alt or Shift works without one. |
| **API client ID** | The OAuth client ID from your Google Cloud project. See [Drag to edit](#drag-to-edit). |
| **Google account → Connect** | Signs in to Google so the extension can save your changes. If you skip this, you're asked to sign in on your first drag. |

## Drag to edit

Google Calendar's own drag code only snaps to 15 minutes and has no handle for the start time. So when this
feature is on, the extension runs the whole drag itself: moving an event, dragging its top edge and dragging its
bottom edge. It then saves the new time through the
[Google Calendar API](https://developers.google.com/calendar/api). Clicking an event without dragging still opens
it as usual.

How it behaves:
- Times snap to the 15-minute grid, to the 5-minute grid while Alt is held, or to the 30-minute grid while Shift
  is held. If you hold both, Alt wins.
- While you drag, the event itself moves and shows its new times, just like Google's own preview.
- Grabbing the bottom edge anywhere on Google's resize handle works too, including with Alt or Shift.
- Press **Esc** while dragging to cancel.
- Moving an event works across days in the week view. Dragging near the top or bottom of the grid scrolls it.
- If the event has guests, you're asked whether to send them update emails, just as Google does.
- After a change, a message with an **Undo** button appears.
- Changing one occurrence of a repeating event changes only that occurrence.
- All-day events, events that run past midnight, and the month view still use Google's own dragging, or show
  a message.

Creating an event:
- Hold **Alt** or **Shift**, then start dragging on an empty part of the day or week grid. A *(No title)* preview
  follows the pointer, snapping to 5 or 30 minutes. You can drag up or down, and press or release Alt and Shift
  mid-drag to change the step.
- When you let go, Google's full event editor opens with the start and end times filled in. Add a title and any
  other details there, then click **Save**. Google saves the event itself, so it appears right away.
- Press **Esc** while dragging to cancel. Alt- or Shift-clicking without dragging works as a normal click.
- Dragging on empty space *without* Alt or Shift is left to Google, so its usual quick-create popup appears. Hold
  Alt or Shift before you start: pressing them partway through a plain drag doesn't switch the step.

### One-time setup (about 5 minutes)

The extension needs its own OAuth client to call the Calendar API on your behalf. You create one in your own Google
Cloud project, which is free.

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and create a project (or pick an existing
   one).
2. Open **APIs & Services → Library**, search for **Google Calendar API**, and click **Enable**.
3. Open **Google Auth Platform** (called **OAuth consent screen** in older consoles) and click **Get started**.
   Give the app a name such as *Calendar Additions*, and choose the audience:
   - **Internal** if you use a Google Workspace account. Only people in your organisation can use it, and Google
     doesn't need to review it.
   - **External** for a personal @gmail.com account. Leave it in *Testing* and add your own email under
     **Test users**.
4. Open the extension's popup, turn on **Drag to edit → Enable**, open **Setup help** and copy the redirect URI. It looks
   like `https://<extension-id>.chromiumapp.org/`.
5. Back in the console, go to **Clients → Create client**. Choose **Web application** as the application type,
   paste the redirect URI under **Authorized redirect URIs**, and click **Create**.
6. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`), paste it into **API client ID** in the popup,
   and click **Connect**. Sign in and allow access to your calendar events.

The extension asks for two permissions. `calendar.events` lets it change event times. `calendar.settings.readonly`
lets it read your calendar's time zone so times snap to the same grid Google shows. The access token stays in your
browser.

> **Note:** Chrome bases an unpacked extension's id on the folder it's loaded from. If you move the folder, the
> redirect URI changes: copy the new one from **Setup help** and add it to your OAuth client.

### Troubleshooting drag to edit
- **Dragging behaves exactly like before.** Check that **Drag to edit → Enable** is on and an **API client ID** is set,
  then reload Google Calendar.
- **"redirect_uri_mismatch" during sign-in.** The redirect URI on your OAuth client doesn't match the one in
  **Setup help**. Copy it again exactly, including the trailing `/`.
- **The event jumps back after saving.** Google Calendar sometimes takes a moment to show changes made through
  the API. If it hasn't updated after about 30 seconds, a **Reload** button appears.
- **Alt+drag moves the browser window (Linux).** Some Linux desktops use Alt+drag to move windows. Change that
  shortcut in your desktop settings, or use the Super key for window moves.

## How "my calendar" is detected

Each event element on the Google Calendar page has a `data-eventid` attribute. Its value is base64 of
`"<eventId> <calendarId>"`, and Google shortens some calendar ids inside it: `@gmail.com` becomes `@m`,
`@group.calendar.google.com` becomes `@g`, and so on. The content script decodes the attribute and compares the
calendar id with the **My calendar** setting. If the setting is blank, it compares against the email of the
signed-in account. If no copy can be identified as yours, duplicates are still collapsed to a single copy.

### Troubleshooting
- **The wrong copy stays visible, or nothing changes.** Open DevTools on calendar.google.com (F12, then the
  Console tab). Look for the log line
  `Calendar Additions (my calendar mode): my calendars = [...] example event calendar = ...`.
  If the ids in that line don't match, copy your calendar's exact id from the log into **My calendar**.
- **Changes to settings don't seem to apply.** Settings changes reload the calendar tab automatically. If one
  doesn't, reload the tab yourself.
- **Google changed its page layout.** This extension reads Google Calendar's markup, so updates on Google's side
  can break it. Please open an issue in that case.

## Build

Run `build` (macOS/Linux) or `build_windows.bat` to create `calendar-additions.zip`.

## License

GPL-3.0. See [LICENSE](LICENSE).

Based on [Cal Merge](https://github.com/HCAWN/gcal-multical-event-merge) by HCAWN and
[imightbeamy](https://github.com/imightbeamy/gcal-multical-event-merge).

*Google Calendar is a trademark of Google LLC. This project is not affiliated with Google.*
