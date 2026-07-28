# Titlebar Horizontal Insets Design

## Goal

Match the horizontal breathing room in the supplied macOS reference while preserving the titlebar’s current height and vertical alignment.

## Measurements

Both screenshots are Retina captures at 2× scale. In the reference window, the red traffic light begins 32 physical pixels from the window edge, equivalent to a 16px logical inset. Opus currently uses a 10px inset. The visible sidebar-toggle icon is about 2 logical pixels farther from the left edge in the reference.

## Design

- Change Tauri `trafficLightPosition.x` from `10` to `16`. Keep `y` at `24`.
- Change the Tauri-only header left padding from `84px` to `86px`, moving the sidebar toggle and app title 2px inward.
- Change the Tauri-only header right padding from `12px` to `14px`, moving the reading/editing mode button 2px inward.
- Do not change the 36px button hit targets, icon sizes, header height, sidebar layout, or non-Tauri browser-shell layout.

The native traffic lights and web titlebar use separate layout systems, so their values remain explicit and independently covered by regression tests.

## Verification

Update the Rust configuration test to require `{ "x": 16, "y": 24 }`. Add a frontend CSS regression test requiring Tauri header padding of `4px 14px 4px 86px`. Run frontend, Rust, and E2E suites, then rebuild, sign, verify, and install the ARM64 `Opus.app` without launching it automatically.
