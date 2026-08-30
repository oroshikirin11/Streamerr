/**
 * The overlay layer as its own process.
 *
 * Today an overlay change respawns the SOURCE: ffmpeg restarts at a seek
 * offset, the bank is discarded, and viewers get a splice. That is why real
 * logs are full of `Packet corrupt`, `DTS ... out of order` and
 * `Non-monotonic DTS` at every Apply.
 *
 * The alternative, verified by experiment before any of this was written:
 * keep the main graph FIXED and change only the pixels flowing into it.
 *
 *     [media] ─────────────────────┐
 *                                  ├─ overlay_vaapi → encode → publish
 *     [RGBA frames on a pipe] ─────┘
 *
 * The renderer filling that pipe is ours, so it can be restarted as often as
 * we like. Measured: renderer swapped mid-stream (red → blue), the encoder
 * produced all 8s in ONE process and never restarted.
 *
 * What this module does NOT do is decide what the canvas contains — that
 * stays in pipeline.js, which owns subtitle timing, band geometry and
 * picture placement. This turns an already-built canvas description into
 * either a command that renders it, or the input args that consume it.
 * Keeping the description single-sourced is the point: two copies of the
 * canvas logic would drift, and the drift would be invisible until a
 * subtitle landed in the wrong place.
 *
 * ffmpeg's own runtime-command interface cannot do this job. Only options
 * flagged `T` are changeable while running, and `overlay_vaapi` — the path
 * actually used — has none at all. Nor can an input be added to a running
 * graph. Measured before choosing this design, not assumed.
 */

/**
 * The pipe carrying finished RGBA frames.
 *
 * rawvideo has no header, so both ends must agree on size, rate and pixel
 * format out of band. Getting any of them wrong does not error — it shears
 * the picture, which is why they come from one place.
 */
export function pipeFormatArgs({ width, height, rate }) {
  return [
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${Math.round(width)}x${Math.round(height)}`,
    '-r', String(rate),
  ];
}

/** Bytes per second on the wire, for deciding whether this is affordable. */
export function pipeBytesPerSecond({ width, height, rate }) {
  const fps = typeof rate === 'string' && rate.includes('/')
    ? Number(rate.split('/')[0]) / Number(rate.split('/')[1])
    : Number(rate);
  return Math.round(width * height * 4 * fps);
}

/**
 * The command that renders the overlay layer to stdout.
 *
 * `spec` is the canvas as pipeline.js already describes it:
 *   inputs   ffmpeg input args for the base and any pictures
 *   filters  filter_complex fragments
 *   out      the label carrying the finished RGBA frames
 *   width/height/rate  what the pipe agreed on
 *
 * Deliberately NOT given `-re`. The renderer is throttled by the reader:
 * when the main encoder is building a cushion faster than realtime it needs
 * overlay frames at that speed too, and pacing this at 1x would make the
 * canvas the bottleneck for the whole broadcast.
 */
export function rendererArgs(spec) {
  const { inputs = [], filters = [], out = 'out' } = spec;
  if (!filters.length) throw new Error('overlay renderer: nothing to render');
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', `[${out}]`,
    // No audio, ever. This is a picture layer.
    '-an',
    /**
     * NUT, not headerless rawvideo — and this one choice carries most of
     * the design:
     *
     *  - frames are TIMESTAMPED, so the renderer only sends a frame when
     *    the canvas CHANGES and the composite holds the last one. Uploads
     *    drop from every-frame to roughly the subtitle change rate, which
     *    is the difference between the N100 broadcasting and not.
     *  - a replacement renderer opens a fresh NUT stream and the demuxer
     *    resyncs onto it mid-read — measured: a SIGKILLed writer cost one
     *    'damaged' log line and zero frames of the video input.
     *  - the stream is self-describing, so the geometry-mismatch class of
     *    bugs (headerless rawvideo shears silently) cannot exist.
     */
    // The renderer reports its own output head on stderr; the feed reads
    // it so a swap can stamp the successor from the true WRITTEN head —
    // the append file preserves run-ahead the fifo used to absorb.
    '-progress', 'pipe:2', '-stats_period', '0.5',
    '-c:v', 'rawvideo', '-f', 'nut',
    'pipe:1',
  ];
}

/**
 * The main graph's side: consume the pipe as an input.
 *
 * `path` is a named pipe rather than an fd because the renderer is replaced
 * repeatedly and ffmpeg must not see EOF when it is. See holdOpen below.
 */
export function pipeInputArgs(spec, path, { capSecs = null } = {}) {
  return [
    // The canvas is a GROWING file: follow=1 makes the file protocol
    // retry at EOF instead of ending the input when the reader catches
    // the writer — the append-file transport's equivalent of the fifo
    // that never EOF'd. The -t bound below still ends the input at clip
    // end, so the process can exit.
    '-follow', '1',
    '-f', 'nut',
    /**
     * The input-side bound is what lets the main process EXIT.
     *
     * The fifo never EOFs — the holder keeps it open so renderer swaps are
     * invisible — and ffmpeg's input thread blocks in read() on a silent
     * open pipe, which hangs the whole process at end of clip: measured, a
     * 10s clip encoded 9.96s and then sat forever. The writer cannot signal
     * the end either; once the reader stops consuming, the renderer blocks
     * on the full fifo and never reaches its own cap. So the READER is
     * bounded: after capSecs it closes the input itself, eof_action=repeat
     * carries the last frame across the margin, and shutdown joins cleanly.
     */
    ...(capSecs != null && capSecs > 0 ? ['-t', Number(capSecs).toFixed(3)] : []),
    '-i', path,
  ];
}

/**
 * THE detail that makes restarts invisible, and the one that is not obvious.
 *
 * A named pipe reports EOF to the reader as soon as the last writer closes
 * it. If the renderer is the only writer, killing it ends the main encoder's
 * overlay input for good: with `eof_action=repeat` the last frame freezes
 * forever and every later renderer writes into a stream nobody reads.
 *
 * So something else must hold the write end open across restarts. This
 * returns a file descriptor opened for writing that the caller keeps for the
 * life of the broadcast and hands to each renderer as its stdout. The
 * renderers come and go; the descriptor does not, so the reader never sees
 * EOF.
 *
 * Verified: a holder across two renderer processes produced a clean
 * red→blue switch mid-stream with the encoder untouched. Without a holder
 * the second renderer's frames never appeared.
 */
export async function holdOpen(path) {
  const { open } = await import('fs/promises');
  // O_RDWR rather than O_WRONLY: opening a fifo write-only BLOCKS until a
  // reader arrives, which would deadlock when the holder is created before
  // the encoder. Read-write never blocks and never sees EOF itself.
  const handle = await open(path, 'r+');
  return handle;
}

/**
 * Create the pipe itself.
 *
 * Node has no mkfifo, so this shells out. Idempotent: a leftover from a
 * crashed broadcast is reused rather than being an error, because a stale
 * fifo is harmless — it has no contents, only a name.
 */
export async function makePipe(path) {
  const { statSync } = await import('fs');
  try {
    if (statSync(path).isFIFO()) return path;
  } catch { /* not there yet, make it */ }
  const { spawn } = await import('child_process');
  await new Promise((res, rej) => {
    const c = spawn('mkfifo', [path], { stdio: 'ignore' });
    c.on('error', rej);
    c.on('close', (code) => (code === 0 ? res() : rej(
      new Error(`mkfifo exited ${code} for ${path}`))));
  });
  return path;
}
