# Manual test checklist

The automated suite covers the protocol codecs, the GATT operation queue, the connection
state machine, dead-banding and cross-backend agreement — all without hardware. What it
cannot cover is a real radio, a real mug and a real browser. This is that list.

Run it against the hardware you have. Anything you cannot test, say so rather than
assuming it works: several behaviours below could not be verified during development and
are noted as such.

## 1. First connection

- [ ] `npm run dev`, open `http://localhost:5173` in Chrome.
- [ ] Take the mug off its charger; hold the bottom button until the light flashes blue.
- [ ] Press **Connect**. The mug appears in the browser dialog.
- [ ] After connecting, check: model name, serial number, firmware version, current
      temperature, battery percentage, liquid level, liquid state.
- [ ] Model is identified without a "which model is this?" prompt. If the prompt appears,
      copy the diagnostics report from Settings — that is the data needed to extend the
      detection table.

## 2. Controls

Each of these must show the new value and keep it after the next poll:

- [ ] Move the target temperature slider.
- [ ] Tap each preset (Latte through Green tea).
- [ ] Tap several presets as fast as you can. The readout follows every tap with no
      flash of an older value, the mug ends on the last one, and no "Read-only" message
      appears.
- [ ] Turn temperature control off — target shows "Off".
- [ ] Turn it back on — the previous target returns, not a default.
- [ ] Change the LED colour; the mug's light changes.
- [ ] Rename the mug; the new name survives a disconnect and reconnect.
- [ ] Switch the mug's own °C/°F unit; confirm in the Ember phone app that the mug's
      display changed, and that the web page's own unit toggle is unaffected.
- [ ] Type a name with an accent (for example `caffè`) — it must be rejected inline
      without a write being attempted.

If writes are accepted but keep reverting, the app shows a "Read-only mug" toast at the
bottom of the screen. That means the mug has never been set up in the Ember app.

## 3. A real brew

- [ ] Pour hot water in and watch the state go Filling → Heating → Perfect.
- [ ] Readings update within a second or two of the mug changing state, not on the next
      poll — that is the push-event path working.
- [ ] Lift the mug off the charger and put it back; the charging indicator flips
      immediately.
- [ ] Open the History tab: the temperature line shows the heating ramp, the state shading
      changes colour under it, and the target ribbon sits around the target line.
- [ ] Drink it down; the liquid level falls and a drink appears in the statistics.

## 4. Connection resilience

- [ ] Walk out of range mid-session. After a second or so a "Reconnecting…" toast
      appears at the bottom; nothing on the page moves.
- [ ] While it is reconnecting, change the target. The new value shows at once.
- [ ] Walk back. It reconnects on its own, the toast disappears, and the mug takes the
      target you set while it was away.
- [ ] Open the Ember phone app and connect to the mug while the page is connected. Expect
      disconnects; after three failed attempts the toast should mention the phone app.
- [ ] Close the phone app; the page recovers and no error message is left behind.

## 5. Reload behaviour

- [ ] Reload the page. It shows the last readings greyed out with "Last seen N minutes
      ago" and a **Reconnect** button — not an empty screen.
- [ ] Reconnect works and picks up where it left off.
- [ ] Enable `chrome://flags/#enable-web-bluetooth-new-permissions-backend` and restart
      Chrome. Reload again: it should now reconnect with no interaction at all.
- [ ] Close the tab while connected, reopen it: the history has no missing tail beyond
      about ten seconds.

## 6. Storage backends

- [ ] With the default browser storage, record for a while, then check Settings shows
      storage as persistent. If it does not, keep using the app and check again — Chrome
      grants it on engagement.
- [ ] `npm run db:start`, open `http://localhost:41821`, go to Settings → Local server →
      **Test**.
- [ ] Press **Move history here**. Watch the progress bar; confirm the row count matches
      and the charts look identical before and after.
- [ ] Run the same migration again: everything should be reported as already present, with
      no new rows.
- [ ] Kill the server mid-migration, restart it, press the button again — it resumes
      rather than starting over.
- [ ] With the server as the active backend, stop the server, use the mug for a few
      minutes, then start the server again. The readings taken while it was down should
      upload on their own.
- [ ] Set up Supabase, run the migration, sign in, and migrate. Repeat the idempotency
      check.
- [ ] Deliberately disable RLS on one Supabase table and reconnect: the app must refuse to
      use the project and say which table is unprotected.
- [ ] Export a backup, clear the local copy, restore from the file, and confirm the counts.

## 7. Over a day

- [ ] Leave it recording for 24 hours with normal use.
- [ ] The all-time chart shows honest gaps where the tab was closed — no straight line
      drawn across the night.
- [ ] The coverage figure roughly matches how long the tab was actually open.
- [ ] "Time at perfect temperature" is plausible. If it reads like a whole night, the gap
      clamp is broken and that is a bug worth reporting immediately.
- [ ] Drag the overview strip at the bottom to jump around; zoom with the scroll wheel;
      double-click to reset.

## 8. Other devices

Only relevant if the hardware is to hand. The capability matrix is implemented from the
reference library and unit-tested, but has not been run against real hardware for any
model other than the Mug 2.

- [ ] **Travel Mug**: no LED control, a button-volume control instead, a battery voltage
      reading, and liquid level scaled 0–100 rather than 0–30.
- [ ] **Cup / Tumbler**: no name field.
- [ ] **Mug 1**: same controls as the Mug 2.

## Known unverified behaviour

These could not be checked without the hardware in question, and are implemented
defensively:

- Which GATT service exposes characteristics 1–20 on a Travel Mug. The app enumerates
  every permitted service rather than assuming, but if a fourth service exists its
  characteristics would be invisible. The diagnostics panel lists unrecognised UUIDs.
- The serial-number to model mapping. The table ships empty; detection falls back to the
  device name and a user override.
- Byte 5 of the date/time characteristic, assumed to be a signed hour offset. Writing it
  is **not implemented**, because getting it wrong could corrupt the mug's clock.
- The blast radius of forcing writability. It overwrites the mug's pairing key; the
  expectation is that the Ember phone app has to add the device again.
- Whether Chrome on Android accepts the manufacturer-data device filter. The app catches
  the failure and retries without it.
