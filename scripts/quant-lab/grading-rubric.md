# Chart pattern grading rubric (for independent graders)

Each image is a grid of panels. One panel = one detection by an automated pattern detector.

- **Black line:** 4-hour closes. The grey band is each bar's high–low.
- **Orange points and lines:** the swing points the detector says form the pattern.
- **Blue or black vertical line:** the moment of detection. Everything to its right is the future. **Ignore it when grading.** You are judging whether the shape was really there at detection time, not whether it worked.
- **Dashed lines:** green is the target, red is the stop, grey dotted is the trigger. Ignore these too.

Grade every panel **VALID** or **INVALID**: would a competent chart technician, looking only at the chart left of the vertical line, agree the orange points form the named pattern?

## Textbook definitions (4h memecoin charts, so tolerances are loose)

- **double_top:** two distinct peaks at roughly the same height (within ~6%) with a clear valley between them. The pattern comes after a prior advance, and the peaks are the dominant highs of that stretch. Two ripples inside a larger move don't count, and neither does a "second peak" that is just part of a continued rally.
- **double_bottom:** the mirror image. Two roughly equal troughs with a clear peak between, after a prior decline, and the troughs are the dominant lows.
- **head_shoulders:** three peaks. The middle one (head) is clearly higher than the two outer ones (shoulders), and the shoulders are roughly similar in height. There are two troughs between them, forming the neckline. Comes after an advance.
- **inv_head_shoulders:** the mirror image at a low, after a decline.
- **bull_flag:** a sharp, steep rise (the pole), then a short, shallow, sideways-to-down drift (the flag) that retraces less than about half of the pole.
- **bear_flag:** the mirror. A sharp drop, then a short, shallow, sideways-to-up drift.
- **accumulation:** after a large decline, price moves sideways in a band for about 2 weeks at or near the lows. Its lowest point comes early in the band and is not revisited. A sideways pause partway down a continuing decline is **INVALID**.
- **distribution:** the mirror. After a large advance, price moves sideways near the highs for about 2 weeks, with the high early in the band.
- **asc_triangle:** a roughly flat resistance (two or more similar highs) and rising support (higher lows). Price is contained between the two lines and the range is narrowing.
- **desc_triangle:** a roughly flat support (two or more similar lows) and falling resistance (lower highs). Contained and narrowing.

When a panel is borderline, ask: would you show this to a student as an example of the pattern? If not, it's INVALID.

## Output

Return JSON only: an array of objects in this shape, one per panel, in reading order (left to right, top to bottom):

`{"image": "<file>", "panel": <1-based index>, "title": "<panel title text>", "verdict": "VALID" | "INVALID", "why": "<≤12 words>"}`

## Additional definitions (used when grading other detectors)
- **symmetric_triangle**: lower highs AND higher lows converging toward an apex; price contained between the two lines.
- **rising_wedge**: both boundary lines rise, the lower one faster, so they converge; price contained. (Bearish.)
- **falling_wedge**: both lines fall, the upper one faster, converging; price contained. (Bullish.)
- **channel_up / channel_down**: two roughly PARALLEL rising (or falling) lines, price bouncing between them with ≥2 touches each side.
- **breakout / breakdown**: price has just closed decisively beyond a clear, previously-tested horizontal level (resistance for breakout, support for breakdown) — the level must have been tested before.
- **v_reversal / inverted_v**: a sharp, roughly symmetric decline then an equally sharp recovery (or the mirror), with no basing period at the turn.
- **blow_off_top**: a parabolic, accelerating advance (each leg steeper) ending in a sharp spike high and an immediate, large reversal.
- **range**: price oscillating sideways between a clear horizontal support and resistance, several touches, no trend.
- **inverse_head_shoulders / ascending_triangle / descending_triangle**: same as inv_head_shoulders / asc_triangle / desc_triangle above.
