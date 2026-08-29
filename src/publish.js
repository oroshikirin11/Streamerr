/**
 * Where the broadcast goes — one destination or several.
 *
 * The engine has always produced MPEG-TS and handed it to a publisher that
 * remuxed to FLV for RTMP. That was the only shape, so the muxer was a
 * constant. It no longer is: RTMPS wants the same FLV, SRT wants the
 * MPEG-TS the engine already has, and a fan-out wants both at once.
 *
 * Everything here is derived from the URL's protocol, so adding one later is
 * a table entry rather than a branch in the publisher.
 */

/** Protocols that can be published to, in the order the UI offers them. */
export const PROTOCOLS = ['rtmp', 'rtmps', 'srt'];

/** Fields that must never be logged, echoed to a client, or put in an error. */
export const SECRET_FIELDS = ['key', 'passphrase', 'streamId'];

/**
 * Credentials are stored PER PROTOCOL, side by side.
 *
 * Switching from RTMP to SRT must not cost the operator their Owncast key —
 * they are two different sets of credentials for two different servers, and
 * a switch is usually a trial rather than a migration. Keeping them apart
 * means switching back is free, and an operator who wants to overwrite one
 * simply types over it.
 */
export function publishDefaults() {
  return {
    protocol: 'rtmp',
    rtmp: { url: '', key: '' },
    rtmps: { url: '', key: '' },
    srt: { url: '', streamId: '', passphrase: '', latencyMs: 200 },
    // Additional destinations, fanned out from the one encode.
    extras: [],
  };
}

/** The container each protocol carries. */
export function muxerFor(protocol) {
  return protocol === 'srt' ? 'mpegts' : 'flv';
}

const clampLatency = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 200;
  return Math.min(8000, Math.max(20, Math.round(n)));
};

/**
 * Validate one destination and build the URL ffmpeg is given.
 *
 * Throws with a message written for the operator rather than for a log: this
 * is what the settings page shows when a target will not do.
 */
export function targetUrl(protocol, creds = {}) {
  const url = String(creds.url ?? '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('The server address is empty');

  if (protocol === 'rtmp' || protocol === 'rtmps') {
    const re = protocol === 'rtmp' ? /^rtmp:\/\/[^/\s]+/i : /^rtmps:\/\/[^/\s]+/i;
    if (!re.test(url)) throw new Error(`The server address must start with ${protocol}://`);
    const key = String(creds.key ?? '').trim();
    if (!key) throw new Error('The stream key is empty');
    return `${url}/${key}`;
  }

  if (protocol === 'srt') {
    if (!/^srt:\/\/[^/\s:]+:\d+/i.test(url)) {
      throw new Error('The server address must look like srt://host:port');
    }
    /**
     * Query parameters, not path segments: SRT carries the stream name in
     * `streamid` and has no path component at all, so appending one the way
     * RTMP does produces a URL that connects and then delivers nothing.
     *
     * Assembled by hand, NOT with URLSearchParams.
     *
     * Measured with `ffmpeg -v debug`: the URL is passed to the SRT layer
     * exactly as written and never percent-decoded. So encoding a stream id
     * sends the escape sequence itself — `live/x` would arrive as the
     * literal `live%2Fx`. It also means the characters that look dangerous
     * are fine: an SRS stream id of `#!::r=live/x,m=publish` survives
     * verbatim, `#` and all.
     *
     * What genuinely cannot survive is `&`, which ends the parameter, so it
     * is refused with a message rather than silently truncating the target.
     */
    const bad = (v, field) => {
      if (/[&\s]/.test(v)) throw new Error(`The SRT ${field} cannot contain "&" or spaces`);
    };
    // caller: we dial out. Every hosted SRT ingest documented (Cloudflare,
    // Mux, Restream) is a listener, so this is the only mode that reaches
    // one. A self-hosted relay can be told to listen.
    const q = ['mode=caller', `latency=${clampLatency(creds.latencyMs)}`];
    const sid = String(creds.streamId ?? '').trim();
    if (sid) { bad(sid, 'stream id'); q.push(`streamid=${sid}`); }
    const pass = String(creds.passphrase ?? '').trim();
    if (pass) {
      // SRT rejects a passphrase outside this range at connect time, with an
      // error that does not say so.
      if (pass.length < 10 || pass.length > 79) {
        throw new Error('An SRT passphrase must be between 10 and 79 characters');
      }
      bad(pass, 'passphrase');
      q.push(`passphrase=${pass}`);
    }
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${q.join('&')}`;
  }

  throw new Error(`Unknown protocol: ${protocol}`);
}

/** The same URL with every secret replaced, for logs and the console. */
export function redactUrl(protocol, creds = {}) {
  const url = String(creds.url ?? '').trim().replace(/\/+$/, '');
  if (!url) return '(unconfigured)';
  if (protocol === 'srt') {
    const bits = [`latency=${clampLatency(creds.latencyMs)}`];
    if (String(creds.streamId ?? '').trim()) bits.push('streamid=********');
    if (String(creds.passphrase ?? '').trim()) bits.push('passphrase=********');
    return `${url}?mode=caller&${bits.join('&')}`;
  }
  return `${url}/${'*'.repeat(8)}`;
}

/**
 * Every destination that should receive this broadcast: the chosen protocol
 * first, then any enabled extras. The primary leads because a tee reports
 * failures by slave index, and the one the operator configured first should
 * be the one they can find in the log.
 */
export function destinations(publish) {
  const p = publish ?? publishDefaults();
  const protocol = PROTOCOLS.includes(p.protocol) ? p.protocol : 'rtmp';
  const out = [{ protocol, creds: p[protocol] ?? {}, primary: true }];
  for (const e of p.extras ?? []) {
    if (!e || e.enabled === false) continue;
    if (!PROTOCOLS.includes(e.protocol)) continue;
    out.push({ protocol: e.protocol, creds: e, primary: false, id: e.id });
  }
  return out;
}

/**
 * The tee muxer splits slaves on `|` and reads options up to `]`, so both
 * have to be escaped inside a slave. A stream key containing one is
 * unlikely and silently truncating the broadcast target is not an
 * acceptable way to find out.
 */
const teeEscape = (s) => String(s).replace(/[\\|\]]/g, (c) => `\\${c}`);

/**
 * ffmpeg output arguments for the whole set.
 *
 * One destination is written directly — no tee, so the failure semantics and
 * the argument list stay exactly what they have always been for the common
 * case. Several go through `tee`.
 *
 * `-tag:v 7 -tag:a 10` is applied globally rather than per slave, which
 * looks wrong and is not: measured, ffmpeg re-maps codec tags per muxer, so
 * a tee carrying FLV and MPEG-TS together produces a valid FLV *and* an
 * MPEG-TS whose stream types are the correct 27/15. Without the tags the
 * FLV slave refuses the TS stream types outright and aborts the whole tee.
 */
export function publishOutputArgs(dests, { videoBitrate = null } = {}) {
  if (!dests.length) throw new Error('No broadcast destination is configured');

  const flvFlags = 'no_duration_filesize+no_sequence_end';
  const common = [
    '-c', 'copy',
    '-tag:v', '7', '-tag:a', '10',
    ...(videoBitrate ? ['-b:v', String(videoBitrate)] : []),
    '-muxdelay', '0', '-muxpreload', '0', '-max_interleave_delta', '0',
  ];

  if (dests.length === 1) {
    const { protocol, creds } = dests[0];
    const url = targetUrl(protocol, creds);
    return [
      ...common,
      ...(muxerFor(protocol) === 'flv' ? ['-flvflags', flvFlags] : []),
      '-f', muxerFor(protocol), url,
    ];
  }

  /**
   * onfail=ignore on every slave, which is the whole reason a fan-out is
   * safe to offer. Measured: with one destination refusing connections
   * ffmpeg logs "continuing with 1/2 slaves" and the surviving output
   * receives every byte. Without it, one unreachable server takes the
   * broadcast down with it.
   */
  const slaves = dests.map(({ protocol, creds }) => {
    const opts = [`f=${muxerFor(protocol)}`, 'onfail=ignore'];
    if (muxerFor(protocol) === 'flv') opts.push(`flvflags=${flvFlags}`);
    return `[${opts.join(':')}]${teeEscape(targetUrl(protocol, creds))}`;
  });
  // tee needs the streams named explicitly; it maps nothing by default.
  return [...common, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'tee', slaves.join('|')];
}
