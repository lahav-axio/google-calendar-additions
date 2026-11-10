Cal Merge + My Calendar for Google Calendar™
=============================================

A fork of [HCAWN's Cal Merge](https://github.com/HCAWN/gcal-multical-event-merge) (itself forked from
[@imightbeamy's repo](https://github.com/imightbeamy/gcal-multical-event-merge)) that adds a second mode.

The original extension **merges** the same event on multiple Google Calendars into one striped, multi-coloured
event. This fork adds a **"My calendar only"** mode. When an event shows up on several calendars, you see only the
copy on *your* calendar. The other copies are hidden and your copy fills their space.

![examples](images/examples.jpg)

## Installation

This fork is not on the Chrome Web Store, so you install it as an unpacked extension. This works in Chrome and
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
5. **Disable the Web Store version of Cal Merge** if you have it installed, so the two don't run at the same time.
6. **Pin the extension.** Click the puzzle-piece icon in the toolbar, then click the pin next to
   *Cal Merge + My Calendar*.
7. **Configure it.** Click the extension icon, set **Mode** to *My calendar only*, then reload Google Calendar.

### Updating
Run `git pull` in the folder, or download the ZIP again and replace the folder's contents. Then click the
**↻ reload** icon on the extension's card in `chrome://extensions`, and reload Google Calendar.

## Settings

| Setting | What it does |
|---|---|
| **Enable** | Turns the extension on or off. |
| **Mode** | *Merge (blend colours)* is the original behaviour. *My calendar only* shows only your copy of duplicated events. |
| **My calendar** | Shown in *My calendar only* mode. Enter your calendar id, which is usually your email. You can enter several, separated by commas. Leave it blank to auto-detect the signed-in account. |
| **Hide events not on my calendar** | Shown in *My calendar only* mode. Also hides events that don't appear on your calendar at all. When off, only duplicates are collapsed. |
| **Style** | Shown in *Merge* mode. Sets the gradient style for merged events. |
| **Wildcard** | Events whose title contains this word (e.g. `busy`) are matched with any other event at the same time. Use `\|` to give several words. This setting works in both modes. |

## How "my calendar" is detected

Each event element on the Google Calendar page has a `data-eventid` attribute. Its value is base64 of
`"<eventId> <calendarId>"`, and Google shortens some calendar ids inside it: `@gmail.com` becomes `@m`,
`@group.calendar.google.com` becomes `@g`, and so on. The content script decodes the attribute and compares the
calendar id with the **My calendar** setting. If the setting is blank, it compares against the email of the
signed-in account. If no copy can be identified as yours, duplicates are still collapsed to a single copy.

### Troubleshooting
- **The wrong copy stays visible, or nothing changes.** Open DevTools on calendar.google.com (F12, then the
  Console tab). Look for the log line
  `Cal merge (my calendar mode): my calendars = [...] example event calendar = ...`.
  If the ids in that line don't match, copy your calendar's exact id from the log into **My calendar**.
- **Changes to settings don't seem to apply.** Settings changes reload the calendar tab automatically. If one
  doesn't, reload the tab yourself.
- **Google changed its page layout.** This extension reads Google Calendar's markup, so updates on Google's side
  can break it. Please open an issue in that case.

## Build

Run `build` (macOS/Linux) or `build_windows.bat` to create a zip of the extension.

## License

GPL-3.0, the same as the upstream project. See [LICENSE](LICENSE).

*Google Calendar is a trademark of Google LLC. This project is not affiliated with Google.*
