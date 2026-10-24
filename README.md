# Dia Video Preview

Two things, built around Zen's sidebar media player:

1. **Live video in the sidebar.** Switch away from a tab that's playing a video and, alongside Zen's media card, the video itself keeps playing in a small screen just above it. Click the screen to jump back to the tab. Go back to the tab and it disappears, like Zen's card.
2. **Picture-in-Picture when you leave Zen.** Switch to another app while that background video is playing and Firefox's normal Picture-in-Picture window opens. Come back to Zen and it closes again.

Both can be turned off, and PiP can also be set to work for a video playing in the tab you're on, in the mod's settings in Sine.

## How it works

- A tiny helper in each tab reports where the main video sits on the page.
- The mod repeatedly snapshots just that area of the background tab, using the same snapshot call Firefox uses for tab thumbnails, and draws it into the sidebar. It runs at 24 fps while playing (adjustable) and 2 fps while paused. It stops entirely while the preview is hidden or Zen isn't focused.
- Firefox normally stops drawing video frames in background tabs after about 10 seconds, which would freeze the preview. The mod turns that off (`media.suspend-bkgnd-video.enabled` = false) while it's enabled. Background videos then keep decoding, which costs a little battery. You can switch it off in the mod's settings, but the preview will freeze after ~10 seconds.
- PiP uses the same command as the PiP button on Zen's media card.

## Install

1. Copy the `dia-video-preview` folder into your profile at `chrome/sine-mods/dia-video-preview`.
2. Clear the startup cache in `about:support`, then restart Zen.

## Troubleshooting

In the Browser Console (⌘⇧J), `DiaVideoPreview.state` shows which tab is being previewed and where the mod thinks its video is.
