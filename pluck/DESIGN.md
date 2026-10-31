---
name: Pluck
description: A local signal lab that pulls video streams out of a live web page.
colors:
  void: "#08090b"
  panel: "#0d0f12"
  panel-raised: "#12151a"
  panel-inset: "#171b21"
  hairline: "#24282f"
  hairline-soft: "#1a1e23"
  hairline-loud: "#333941"
  ink: "#eceef1"
  ink-muted: "#aeb5bf"
  ink-faint: "#7f8792"
  lamp-amber: "#ffb224"
  lamp-amber-hover: "#ffc153"
  lamp-amber-ink: "#1a1204"
  signal-live: "#5ad9a4"
  signal-danger: "#ff6f5c"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 6.4vw, 4.5rem)"
    fontWeight: 800
    lineHeight: 0.96
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Bricolage Grotesque, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(1.6rem, 2.9vw, 2.4rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Bricolage Grotesque, Segoe UI, system-ui, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Bricolage Grotesque, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.62
    letterSpacing: "0em"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "0.7rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.09em"
  readout:
    fontFamily: "JetBrains Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "0.7rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
rounded:
  sm: "4px"
  md: "7px"
  lg: "12px"
  pill: "99px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "32px"
  band: "clamp(44px, 6vw, 76px)"
components:
  button-primary:
    backgroundColor: "{colors.lamp-amber}"
    textColor: "{colors.lamp-amber-ink}"
    rounded: "{rounded.md}"
    padding: "0 22px"
    height: "52px"
    typography: "{typography.title}"
  button-primary-hover:
    backgroundColor: "{colors.lamp-amber-hover}"
    textColor: "{colors.lamp-amber-ink}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    padding: "0 13px"
    height: "34px"
  input-page:
    backgroundColor: "{colors.void}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "52px"
  chip-kind:
    backgroundColor: "{colors.void}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.sm}"
    padding: "1px 5px 1px 4px"
  chip-best-guess:
    backgroundColor: "{colors.lamp-amber-soft}"
    textColor: "{colors.lamp-amber}"
    rounded: "2px"
    padding: "2px 6px"
---

# Design System: Pluck

## Overview

**Creative North Star: "The Signal Lab"**

Pluck is an instrument, not a shopfront. The ground is the near-black of a powered-down
monitor, everything you can touch is separated by hairlines instead of card shadows, and a
single warm lamp colour marks the one action that matters at any moment: capture, take,
save. Nothing glows without meaning; a live window is mint, a failure is coral, and the
rest of the screen stays quiet so those two colours keep their authority.

The page reads as a control room in two zones. On the left the copy and the capture console
explain and command; on the right a spec map tells you what the tool will accept and what
comes back. Once a session starts, the console becomes a real monitor with a live browser
frame inside it and a dock of detected streams pinned beside it. Density is deliberate: a
detected stream is 66 px tall and carries resolution, size, duration and three actions, so a
dozen can be scanned without scrolling.

Type does the rest of the work. Bricolage Grotesque at weight 800 sets the headline into two
hard lines; JetBrains Mono appears only where a number, an address, a size, a duration or a
protocol label lives. Mono is evidence, not costume.

**Key Characteristics:**
- Near-black layered grounds with 1 px hairlines, no decorative shadows on content.
- One accent (amber) for action, mint and coral reserved for state.
- Monospace is data only; headings are packed, tight, and unfriendly to ornament.
- Instrument framing: every panel is a frame with a labeled edge, not a floating card.

## Colors

A powered-down monitor: three near-black grounds, three greys, one lamp.

### Primary
- **Lamp Amber** (#ffb224): the only accent. Primary buttons, the active filter chip, the
  progress fill, the "best guess" mark, the tick at the console's top edge. Used on well
  under 10% of any screen.
- **Lamp Amber Ink** (#1a1204): text on amber, so the button stays legible at 4.5:1.

### Secondary
- **Signal Live** (#5ad9a4): a window is open, a transfer finished. Never decorative.
- **Signal Coral** (#ff6f5c): a transfer failed, a blocked navigation, an error hint.

### Neutral
- **Void** (#08090b): page ground and input wells. The darkest value in the system.
- **Panel** (#0d0f12): consoles, docks, dialogs. One step up from void.
- **Panel Raised** (#12151a) / **Panel Inset** (#171b21): hover rows and the thumbnail bed.
- **Hairline** (#24282f): every border and divider. **Hairline Soft** (#1a1e23) for rows
  inside a panel, **Hairline Loud** (#333941) for the progress rail track and field outlines.
- **Ink** (#eceef1) / **Ink Muted** (#aeb5bf) / **Ink Faint** (#7f8792): primary, secondary
  and metadata text.

### Named Rules
**The One Lamp Rule.** Amber belongs to exactly one thing per view: the next action. If two
elements on a screen both claim it, one is wrong.

**The Hairline Rule.** Structure comes from 1 px lines and ground shift, never from drop
shadows on content. Shadow is reserved for surfaces that genuinely float above the page
(monitor frame, dialog, toast).

## Typography

**Display Font:** Bricolage Grotesque (with Segoe UI, system-ui)
**Data Font:** JetBrains Mono (with ui-monospace, Cascadia Mono)

**Character:** A grotesque with tight apertures and a slightly squared bowl, set at 800 for
the headline so it reads as signage rather than marketing. Mono is the technical voice: it
carries addresses, byte counts, timecodes, protocol names and every uppercase micro-label.

### Hierarchy
- **Display** (800, clamp 2.5rem → 4.5rem, line-height 0.96, tracking -0.04em): hero
  headline only, two hard lines, maximum 20 characters per line.
- **Headline** (600, clamp 1.6rem → 2.4rem, tracking -0.03em): band titles, one sentence,
  max 22ch.
- **Title** (600, 1.05rem): row names, dialog titles, step names.
- **Body** (400, 1rem, line-height 1.62): lede and prose, max 58ch.
- **Label** (mono, 0.7rem, tracking 0.09em, uppercase): panel labels, element kinds,
  protocol tags. Never below 11 px.
- **Readout** (mono, 0.7rem): URLs, sizes, durations, percentages, segment counters.

### Named Rules
**The Mono Is Evidence Rule.** Monospace marks something the machine measured or was told:
an address, a byte count, a protocol, a key. Prose, headings and button labels never use it.

## Layout

A single 1180 px max-width column on a 24 px gutter, centered, with two distinct stages.

**Landing stage.** A 1.12fr / 0.88fr split: copy and console left, the spec map right. The
console is the anchor at 40 px below the lede. Bands below the fold are separated by a 1 px
rule plus `clamp(44px, 6vw, 76px)` of vertical padding, never by cards.

**Session stage.** The same container becomes a 1fr / clamp(336px, 31vw, 424px) workspace:
live monitor on the left, signal dock on the right. The monitor keeps a 1280×720 aspect; a
solid toolbar overlays its bottom edge rather than sitting outside it.

**Breakpoints.** 1100 px collapses the hero to one column. 860 px stacks the workspace
(monitor above dock, dock height capped at 380 px). 720 px shrinks the session bar to two
rows, hides the toolbar scroll buttons, and turns transfer rows into two columns. 560 px
reduces the console row to one column with a full-width button.

**Rhythm.** Rows are 66 px tall, panels use 14–20 px insets, and the vertical rhythm between
blocks is 26 / 40 / 76 px. Nothing is centered except uppercase labels inside pills.

## Elevation & Depth

The system is layered tonally, not lifted. Three flat grounds (void → panel → panel raised)
do the stacking; shadow appears only where a surface is genuinely above the page.

- **Monitor frame:** `0 32px 64px -36px rgba(0,0,0,.95)` plus a 1 px inset top highlight. It
  is the one object that floats.
- **Console / dialog / toast:** `0 18px 40px -22px rgba(0,0,0,.9)`, short and dense.
- **Rows, chips, inputs:** no shadow at all. Hover is a 2.8% white wash.
- **Toolbar over live frame:** solid 94% void with an upward shadow so the frame's own
  content never bleeds into the controls.

## Shapes

- **Radii:** 4 px for chips and small marks, 7 px for buttons/inputs, 12 px for consoles,
  dialogs and the monitor frame. Pills (99 px) only for state badges and the legal strip.
- **Corners:** a 1 px border on every framed surface; the frame's corner radius always
  matches its outer radius so nested corners stay concentric.
- **Clipping:** the monitor frame and the signal list clip at the parent radius; rows are
  full-bleed inside their panel with hairline separators, never inset cards.
- **Marks:** the "best guess" tag is a 2 px-radius rectangle with a 5 px amber dot; the
  protocol chip is a 4 px-radius rectangle anchored to the thumbnail's bottom-left corner.

## Components

- **Capture console:** bordered panel, 2 px rail across the top with a 42 px amber tick and a
  one-shot sweep, one input row (input + amber submit), a hint line, and a footer strip of
  three machine facts separated by hairline dots.
- **Signal row:** 58 px thumbnail (frame from the live window, falling back to the file
  extension), kind chip on the thumbnail, name with an optional "best guess" mark, meta line
  in mono (quality · size · duration · aes-128), and three icon actions: copy, preview,
  take. Preview is disabled for playlists, which cannot be played back directly.
- **Session bar:** live pill, host identity, countdown rail with label and mono timer, end
  action. The rail is the only wide amber element in the app.
- **Transfer row:** filename, kind, progress rail with mono readout under it, and one action
  that changes with state (cancel → save file → dismiss). Done switches the rail to mint,
  error to coral with the reason in coral text.
- **Filter chips and sort:** five chip buttons (all / hls / dash / stream + hidden notes) and
  a select, all 34 px tall, with the active chip filled amber.
- **Dialogs:** preview and rename dialogs are panel-ground surfaces with a hairline border, a
  title line and a single primary action; the backdrop is 62% void with no blur.

## Do's and Don'ts

**Do**
- Use one amber action per surface and keep amber labels to 0.7rem mono.
- Separate sections with a 1 px hairline plus generous padding instead of boxes.
- Keep numbers, addresses and protocol words in JetBrains Mono at 11 px or larger.
- Show state with mint or coral only where the machine actually changed state.
- Let the live frame be the brightest thing on the session screen.

**Don't**
- Don't add a second accent colour, gradient text, glass blur, or coloured left borders.
- Don't put an uppercase kicker above a heading; the heading starts the block.
- Don't use mono for prose, button labels or decoration.
- Don't shrink functional text below 11 px, including chips, labels and readouts.
- Don't wrap rows in cards; rows live edge to edge inside their panel.
