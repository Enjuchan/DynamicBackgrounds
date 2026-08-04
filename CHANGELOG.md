# Changelog

All notable changes to this project are documented here.

Versioning follows [Semantic Versioning](https://semver.org):

- **PATCH** (x.y.Z) - bug fixes only. Nothing added, nothing removed.
- **MINOR** (x.Y.0) - new features that leave existing settings untouched.
- **MAJOR** (X.0.0) - something is removed, or stored data has to be migrated.

Rule of thumb: if someone has to reconfigure anything after updating, it's a
major release.

---

## 3.8.0

### Added

- **The grid draws thumbnails instead of full-resolution images.** Every image
  now carries a small 480px WebP copy alongside the original, and the library
  view uses that.

  What made this worth doing is that file size was never the issue. A decoded
  image costs `width × height × 4` bytes in memory no matter how well it
  compresses. Measured against a real library: 2688×1536 is 600 KB as a file and
  15.8 MB once decoded, a factor of 26. And because categories are shown as
  fanned stacks of five cards side by side, practically the whole library is
  painted at once. For 34 images that came to roughly 537 MB, all of it to fill
  cards 240px wide.

  With thumbnails the same library needs about 18 MB.

  The originals are untouched. They are still what you see as a background, what
  the hover preview loads, and what the ZIP export writes.

- Images uploaded before this version get their thumbnail generated in the
  background the next time the manager is opened, one at a time so nothing
  stutters, and it is stored afterwards. Until a thumbnail exists the grid falls
  back to the original, so it may be slow once but is never blank.

---

## 3.7.2

### Changed

- **The plugin now goes by one name everywhere.** Console messages, the toolbar
  tooltip, the window heading, the context menu entry and all CSS class names
  say `DynamicBackgrounds`. Until now the code carried a mix: some messages were
  tagged `[BackgroundManager]`, others `[DynamicBackgrounds]`, and every CSS
  class used the `BackgroundManager-` prefix.

  That prefix was inherited from the plugin this one started out from, see
  Credits below. Nothing about your stored images or settings is affected: the
  database has always been called `DynamicBackgrounds` and the settings key
  comes from the file name.

  Lovelace 3.0.2 accepts both the old and the new class name, so an older copy
  of either one keeps working while both updates make their way around.

### Added

- **Credits for the original.** This plugin started from
  [BackgroundManager](https://github.com/Naru-kami/BackgroundManager-plugin) by
  Naru-kami and still contains code from it. The MIT licence requires the
  original copyright notice to be kept, and it had been missing. `LICENSE` now
  names both holders, and the README has a Credits section.

### Fixed

- Six leftover debug messages in the image download path wrote to the console on
  every download. They logged the blob size, the source URL and the file name,
  which was useful while that code was being written and pure noise since.

---

## 3.7.1

### Fixed

- **The whole client no longer jumps up and down by a few pixels while an
  ambient effect is running.** Every few seconds the interface ticked upwards
  and back, and the header row was clipped at the top edge of the window while
  it was displaced.

  Ambient effects enlarge the background container with `transform: scale`, by
  between 2% and 14% depending on the effect. That overscan is deliberate:
  without it, panning would reveal the edges of the image. But a transformed
  element counts towards the scrollable area of every ancestor with its
  enlarged box, and the container is absolutely positioned. The app grew past
  the window, measured at 1626px inside 1610px.

  Discord's own mount point keeps `overflow: hidden` yet still scrolls
  programmatically. As the animation ran, the height oscillated, the browser
  kept correcting the scroll offset, and everything shifted by 16px and back.

  The background layer now clips to the window. Nothing looks different, since
  the overscan was never visible in the first place.

  Only the container itself could not be the place to fix this: it *is* the
  enlarged element, so its own box overflows regardless of how it treats its
  children.

- **Everything the user sees is English again.** One toast after downloading an
  image and four console messages had been left in German, sitting between
  otherwise English ones. Code comments stay German; the line runs between
  comment and output, not between file and file.

---

## 3.7.0

### Changed

- **Scrolling is smooth again, and switching servers or channels is noticeably
  faster.** The background layer carried `background-attachment: fixed`, which
  tells the browser it must not hand the image to the GPU and has to repaint
  the whole surface on every scroll. At roughly two million pixels, on every
  movement in the channel list, DM list or chat.

  It was never needed: the layer is absolutely positioned and fills the
  viewport, so it does not scroll along in the first place. And once an ambient
  effect runs, its transform makes the container the reference frame, at which
  point `fixed` behaves like `scroll` anyway.

- Filters and blur now only apply when they actually do something. They used to
  sit on both full-screen layers permanently, even at neutral values -
  `grayscale(0%) contrast(100%) saturate(100%)` and `blur(0px)` change nothing
  visible but still cost a compositing layer each, and `backdrop-filter`
  additionally reads back the page behind it. Two `data` attributes now switch
  the rules on, set whenever a value leaves its default.

- `mix-blend-mode` is limited to the duration of an image change. It is only
  needed while both layers are visible at once, so the crossfade does not dip;
  the rest of the time it merely forced both into separate layers.

- The inactive layer is now `visibility: hidden` outside of transitions. At
  `opacity: 0` the browser skips painting it but still keeps the layer and its
  filters around.

### Notes

The measurement that found this: two elements of 1997×1678 with an active
filter, one of them invisible. The filters were the obvious suspect and got
fixed first, but they were not the bottleneck. `fixed` is a single word inside
a `background` shorthand and easy to miss - the symptom, scrolling stutter,
pointed straight at it.

---

## 3.6.3

### Fixed

- All user-facing text is English again. The update notice added in 3.6.0 was
  written in German (`Aktualisieren`, `ist verfuegbar`, `Update fehlgeschlagen`)
  while the rest of the interface is English.
- A handful of older strings had the same problem and are translated now: the
  context menu entries **View image**, **Save image** and **Category**, the
  favourite tooltip, and the clipboard and download toasts. One of them sat
  directly next to an English message in the same `catch` block.

Code comments stay German - they explain reasoning to whoever edits the file,
not to whoever uses it.

### Changed

- The update notice now closes itself once the update has been written. It used
  to stay on screen after a successful update, leaving an offer for a version
  that was already installed.

  BetterDiscord hands the button handler a dismiss function as its first
  argument; it was simply being ignored. If the write fails the notice stays on
  purpose, so the update can be retried.

---

## 3.6.1

### Fixed

- The update button did nothing except log `Cannot read properties of
  undefined (reading 'writeFile')`. The download and the version comparison
  worked, but writing the file used `fs.promises.writeFile`, and the `fs`
  module Discord's renderer hands out through `require` has no `promises`
  property. It now uses the callback form of `writeFile`, which is what every
  other plugin in the wild does.

---

## 3.6.0

### Added

- Update check. On start the plugin fetches its own file from GitHub, compares
  the `@version` in the header, and offers a notice with an "Aktualisieren"
  button if a newer release exists. Accepting it rewrites the plugin file;
  BetterDiscord picks up the change and reloads on its own.

### Notes

The `@updateUrl` field in the header had been there since earlier releases but
did nothing - BetterDiscord does not act on it, so without code behind it the
entry was decoration. This release adds that code.

The download goes through `BdApi.Net.fetch`, not `fetch`: Discord's content
security policy blocks requests to outside hosts from the renderer.

The downloaded text is checked for a parseable `@version` before anything is
written. A wrong URL returns an HTML error page with status 200, and writing
that over the running plugin would break it.

---

## 3.5.0

### Changed

- The fallback category is now called **Uncategorized** instead of the German
  "Standard". Existing images and settings are migrated automatically on load,
  including selected category and slideshow filters - the name is stored on
  every image, so renaming it alone would have left them in a group that no
  longer exists.
- The export dialog is in English: "Download images", "All as ZIP", "Image 1".

### Added

- Deleting a category now asks for confirmation and states how many images
  will be moved to Uncategorized. Empty categories are deleted without a
  prompt - there is nothing to lose.

### Notes

The fallback category still cannot be deleted, by design. Deleting any other
category moves its images here rather than deleting them, so it has to exist.

---

## 3.4.3

### Changed

- Removed the remaining "this used to be broken, here is why" comments. What
  a past bug was is history and belongs in this file; the code only needs to
  say what it does now.

---

## 3.4.2

### Changed

- Trimmed code comments. Explanations of what a past bug was and how it was
  fixed belong in this file, not in the source. Comments that state where
  something lives or why a non-obvious approach was chosen were kept.
- Removed the versioning block from the plugin header - it duplicated the
  rules at the top of this file.

---

## 3.4.1

### Fixed

- Removed two properties the plugin attached to the global `window` object.
  BetterDiscord's guidelines forbid this outright ("Plugins must not modify
  global variables, global objects"), and `stop()` never cleaned them up, so
  they stayed behind after disabling the plugin. The slideshow filter state
  now lives on the plugin's own object.
- `stop()` now releases the cached image list. It previously kept every image
  in memory while the plugin was disabled.
- A running live preview no longer lingers when the plugin is disabled
  mid-hover.
- Two remaining German strings in the category dropdown.

---

## 3.4.0

### Changed

- ZIP export no longer loads JSZip from a CDN. The plugin now writes the ZIP
  format itself in about 80 lines. Since images are already compressed as
  WebP, JPEG or PNG, entries are stored without deflate - the size difference
  is negligible. This was required for submission: BetterDiscord's guidelines
  forbid libraries loaded at runtime.
- Duplicate filenames within a category are numbered instead of silently
  overwriting each other when extracted.
- Full change history moved from the plugin header into this file.

---

## 3.3.1

### Fixed

- Images vanished without trace when their category was no longer listed in
  the settings. The grid iterated over the registered category list rather
  than the groups that actually existed, so the images stayed in the database
  but were unreachable through the interface. Orphaned categories are now
  displayed and automatically written back into the settings.
- The "Slideshow" heading wrapped onto two lines.

---

## 3.3.0

### Added

- Toolbar split into two labelled rows: **Slideshow** controls what is
  playing, **Library** manages the collection.
- The slideshow can be paused and resumed directly from the toolbar.
- **Next** skips to the following image without opening settings.
- **Export ZIP** is visible again instead of hidden in the overflow menu.
- Filter chips spell out their state: "Favorites only" / "All images".

### Changed

- The dot marking the active category is now pink.
- Category tiles lift on hover instead of gaining a background panel.
- Overflow menu and settings form their own group on the right.

---

## 3.2.1

### Fixed

- The slideshow never restarted after a live preview. Clicking an image
  discarded the preview state silently, so the following cleanup bailed out
  early and left the slideshow paused.
- The slideshow now resumes exactly where it stopped, waiting out the
  remaining time instead of restarting the full interval.

### Changed

- The category filter is a labelled chip like the others, rather than a bare
  icon between two framed controls.
- Overflow and settings buttons match the chips in height and corner radius.
- Category tiles lift slightly on hover.
- The category holding the current background is marked with a dot.

---

## 3.2.0

### Changed

- Toolbar rebuilt with labelled chips instead of bare icons. Rare and
  destructive actions moved into an overflow menu.
- The "Categories" pill was removed - it led to the same place as clicking a
  tile. Empty categories are reachable through "Open category".
- Live preview switches instantly and pauses the slideshow, instead of
  triggering a full transition on every hover.

---

## 3.1.1

### Fixed

- The drop area did not react while dragging: the rule targeted a class name
  that does not exist.
- No glow was visible on the category overview - the cards receive their
  shadow through inline styles, which override any stylesheet.

---

## 3.1.0

### Added

- Live preview: hovering an image in the grid shows it as the real background
  after a short delay, and moving away restores the previous one. Nothing is
  saved.
- Subtle glow treatment: ring around the active image, light edge on hover, a
  reacting drop area, a warm glow on set favourites, and a light edge along
  the top of the window.

### Changed

- ZIP export sorts images into folders by category instead of a flat list.
  Categories and favourites live only in IndexedDB, so without folders the
  organisation was lost on restore.

---

## 3.0.0

### Added

- Ambient effects as a separate setting, independent of the transition:
  Ken Burns, Drift, Breathe, Film grain, Scanlines, Glitch.
- Speed slider for ambient effects (10-600%).
- Reset button on every numeric slider.
- New transitions: Slide (from bottom), Zoom out, Spin, Iris.
- Category tiles show name and image count permanently.

### Changed

- Interface language is now English throughout.
- The category stack animation runs as one continuous movement instead of
  three separate phases.
- Category tiles show three fanned cards instead of five and take half the
  vertical space.
- Transition selection uses a submenu instead of a native dropdown, which the
  operating system rendered and which could not be styled or reliably clicked.
- The drop area shrank from 120px to 62px.

### Fixed

- `openDB` never created missing object stores, producing a permanent
  `NotFoundError` with no way to recover.
- A missing `<bd-themes>` element disabled the entire plugin through an
  unhandled type error.
- `setProperty` ran on every DOM mutation without throttling.
- Number inputs in the settings popout accepted no keystrokes, because
  Discord's context menu consumed them.
- Curtain discarded the opacity transition; Wipe left its mask in place,
  leaving part of the image permanently translucent.
- Blur and Blur-to-Focus overwrote the grayscale and saturation sliders.
- Parallax overwrote the horizontal and vertical position sliders.
- The Glitch burst scaled with the speed setting instead of only its interval.

### Removed

- Transitions Pixelate and Particle Dissolve - both had no visible effect.
- Transition Flip - `rotateY` on a full-screen layer stutters in Electron.
- Duplicates 3D Cube and Blur to Focus.

All removed values are remapped automatically on load.