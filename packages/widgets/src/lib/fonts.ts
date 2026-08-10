/* Font stacks for canvas-drawn text. Canvas (and uPlot) text doesn't inherit
 * the app's CSS — uPlot's default is Arial, visibly foreign next to the app's
 * Inter/JetBrains Mono. Same stack as the .font-mono-num utility.
 */
export const MONO_STACK = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
/** Axis tick labels on uPlot charts. */
export const AXIS_FONT = `10px ${MONO_STACK}`;
/** Small in-chart annotations (datum labels, overlay chips). */
export const MONO_9PX = `9px ${MONO_STACK}`;
