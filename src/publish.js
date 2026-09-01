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
export const PROTOCOLS = ['tcp', 'rtmp', 'rtmps', 'srt'];

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
/** A display nickname: trimmed, bounded, never load-bearing. */
export const destName = (v) => String(v ?? '').trim().slice(0, 40);

export function publishDefaults() {
  return {
    protocol: 'rtmp',
    rtmp: { url: '', key: '' },
    rtmps: { url: '', key: '' },
    srt: { url: '', streamId: '', passphrase: '', latencyMs: 200 },
    /**
     * Raw MPEG-TS over plain TCP — for lines whose UDP loss no SRT
     * latency window survives (measured on the deployment: evening
     * upstream bursts corrupted every UDP stream while TCP + the bank
     * stayed clean). TCP has nowhere to carry a stream key, and ffmpeg
     * cannot send bytes before its own, so the engine runs a local
     * bridge: ffmpeg writes to 127.0.0.1, the bridge dials the real
     * target, sends `SGR-TS/1 <key>\n` and splices bytes from there.
     */
    tcp: { url: '', key: '', passphrase: '' },
    /**
     * Which Streamingestarr room ("channel") the primary feeds. Metadata
     * pushes carry it, so a fan-out where each destination is a different
     * room gets its own now-playing. Empty = the receiver's default room.
     */
    channel: '',
    // Additional destinations, fanned out from the one encode.
    extras: [],
  };
}

/** The container each protocol carries. */
export function muxerFor(protocol, codec = 'h264') {
  // AV1 cannot ride mpegts (measured on the receiver: demuxes as
  // bin_data) — over SRT/TCP it goes in matroska, per the receiver
  // contract (the ingest probes the container, it never assumes TS).
  if ((protocol === 'srt' || protocol === 'tcp') && codec === 'av1') return 'matroska';
  return muxerForBase(protocol);
}
function muxerForBase(protocol) {
  return protocol === 'srt' || protocol === 'tcp' ? 'mpegts' : 'flv';
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
    //
    // The default 1316-byte payload needs a 1344-byte path MTU. That holds
    // on the open internet but NOT through WireGuard/tailscale tunnels
    // (MTU 1280): there every packet IP-fragments, a lost fragment drops
    // the whole packet outside SRT's loss accounting, and the viewer sees
    // slice smears while every sender-side log looks clean. If a tunnel
    // ever re-enters the publish path, add payload_size=1128 (6 x 188,
    // TS-aligned, fits under 1280) here.
    const q = ['mode=caller',
      `latency=${clampLatency(creds.latencyMs)}`];
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

  if (protocol === 'tcp') {
    if (!/^tcp:\/\/[^/\s:]+:\d+$/i.test(url)) {
      throw new Error('The server address must look like tcp://host:port');
    }
    const key = String(creds.key ?? '').trim();
    if (!key) throw new Error('The stream key is empty');
    if (/[\r\n ]/.test(key)) throw new Error('The stream key cannot contain spaces or line breaks');
    // The optional passphrase rides the same preamble line as a second
    // token, so it has the same character rules.
    if (/[\r\n ]/.test(String(creds.passphrase ?? '').trim())) {
      throw new Error('A TCP passphrase cannot contain spaces or line breaks');
    }
    /**
     * The key is deliberately NOT in this URL: ffmpeg never sees the real
     * target. The engine's bridge (tcp-bridge.js) dials it, authenticates
     * with the preamble line and splices; what ffmpeg gets is the bridge's
     * 127.0.0.1 address, already substituted by the engine. nodelay:
     * never let Nagle sit on a live broadcast's writes.
     */
    return `${url}?tcp_nodelay=1`;
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
  if (protocol === 'tcp') return `${url} (key=********, via local bridge)`;
  return `${url}/${'*'.repeat(8)}`;
}

/**
 * Every destination that should receive this broadcast: the chosen protocol
 * first, then any enabled extras. The primary leads because a tee reports
 * failures by slave index, and the one the operator configured first should
 * be the one they can find in the log.
 */
/** Can this protocol carry this codec to the receivers we deploy to?
 *  H.264 rides anything; HEVC/AV1 need a container-honest transport —
 *  SRT or raw TCP. RTMP stays H.264-only because the receiver's RTMP
 *  stack has no Enhanced RTMP. */
export const protocolCarries = (protocol, codec = 'h264') => (
  codec === 'h264' ? true : protocol === 'srt' || protocol === 'tcp'
);

export function destinations(publish, codec = 'h264') {
  const p = publish ?? publishDefaults();
  let protocol = PROTOCOLS.includes(p.protocol) ? p.protocol : 'rtmp';
  /**
   * Codec-aware selection, switch-resistant by design (see
   * docs/codec-protocol-unification.md): configs persist per protocol
   * and the codec CHOOSES — it never overwrites. A non-h264 codec moves
   * the primary to its SRT slot when one is configured; extras that
   * cannot carry the codec sit out (returned in `skipped` for the
   * caller to warn about) and rejoin when the codec allows them.
   */
  if (!protocolCarries(protocol, codec) && String(p.srt?.url ?? '').trim()) {
    protocol = 'srt';
  }
  const out = [{ protocol, creds: p[protocol] ?? {}, primary: true, name: destName(p.name),
    channel: String(p.channel ?? '').trim().slice(0, 64) }];
  const skipped = [];
  for (const e of p.extras ?? []) {
    if (!e || e.enabled === false) continue;
    if (!PROTOCOLS.includes(e.protocol)) continue;
    const d = { protocol: e.protocol, creds: e, primary: false, id: e.id, name: destName(e.name),
      channel: String(e.channel ?? '').trim().slice(0, 64) };
    if (protocolCarries(e.protocol, codec)) out.push(d);
    else skipped.push(d);
  }
  out.skipped = skipped;
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
export function publishOutputArgs(dests, { videoBitrate = null, codec = 'h264' } = {}) {
  if (!dests.length) throw new Error('No broadcast destination is configured');

  const flvFlags = 'no_duration_filesize+no_sequence_end';
  // flv fourcc by codec: 7 = AVC, hvc1/av01 = enhanced-RTMP. Remapped per
  // muxer as before; mpegts ignores tags.
  const vtag = { h264: '7', hevc: 'hvc1', av1: 'av01' }[codec] ?? '7';
  // "mpegts ignores tags" held right up until a muxer that does not:
  // matroska REJECTS the flv fourccs ("Tag [10][0][0][0] incompatible
  // with AAC", measured live on the first NUT/AV1 broadcast). AV1 only
  // ever travels in matroska, so its tags are scrubbed to 0 — the flv
  // fourccs exist for flv, which AV1 never touches here.
  const scrub = codec === 'av1';
  const common = [
    '-c', 'copy',
    '-tag:v', scrub ? '0' : vtag, '-tag:a', scrub ? '0' : '10',
    ...(videoBitrate ? ['-b:v', String(videoBitrate)] : []),
    '-muxdelay', '0', '-muxpreload', '0', '-max_interleave_delta', '0',
  ];

  if (dests.length === 1) {
    const { protocol, creds } = dests[0];
    const url = targetUrl(protocol, creds);
    return [
      ...common,
      ...(muxerFor(protocol, codec) === 'flv' ? ['-flvflags', flvFlags] : []),
      '-f', muxerFor(protocol, codec), url,
    ];
  }

  /**
   * onfail=ignore on every slave, which is the whole reason a fan-out is
   * safe to offer. Measured: with one destination refusing connections
   * ffmpeg logs "continuing with 1/2 slaves" and the surviving output
   * receives every byte. Without it, one unreachable server takes the
   * broadcast down with it.
   */
  /**
   * EXTRA destinations additionally ride ffmpeg's fifo muxer, which is
   * what makes them come BACK: onfail=ignore alone drops a slave forever
   * on the first refused connection, so a receiver restart killed the
   * destination until someone restarted the broadcast. The fifo puts a
   * queue and a reconnect loop in front of the real muxer —
   * attempt_recovery with recovery_wait_time retries indefinitely
   * (max_recovery_attempts=0), restart_with_keyframe rejoins decodably,
   * and drop_pkts_on_overflow keeps a dead receiver from ever
   * backpressuring the tee: the queue caps at ~10s of stream
   * (queue_size=240 packets) and then sheds, so the primary and the
   * other slaves never feel it.
   *
   * The PRIMARY keeps the plain direct muxer on purpose: its failure
   * semantics feed the engine's own publisher supervision, and hiding
   * its death behind a fifo would turn "the broadcast is down" into
   * silence.
   */
  const slaves = dests.map(({ protocol, creds, primary }) => {
    const inner = muxerFor(protocol, codec);
    const innerOpts = inner === 'flv' ? `:format_opts=flvflags=${flvFlags}` : '';
    const opts = primary
      ? [`f=${inner}`, 'onfail=ignore',
        ...(inner === 'flv' ? [`flvflags=${flvFlags}`] : [])]
      : ['f=fifo', `fifo_format=${inner}`,
        /**
         * ADTS->ASC happens HERE, at the tee, not inside the fifo's flv:
         * left to the muxer's auto-inserted aac_adtstoasc, a recovery
         * restarts the muxer but reuses the filter instance already in
         * its EOF state, and every audio packet after the reconnect fails
         * ("non-NULL packet sent after an EOF") in a once-a-second
         * recovery loop — seen live on the first real outage. Converted
         * before the fifo, the inner flv sees plain ASC and inserts
         * nothing fragile.
         */
        ...(inner === 'flv' ? ['bsfs/a=aac_adtstoasc'] : []),
        'attempt_recovery=1', 'recover_any_error=1', 'max_recovery_attempts=0',
        'restart_with_keyframe=1', 'recovery_wait_time=2',
        /**
         * queue_size counts PACKETS, and this stream carries ~71/s
         * (24 video + ~47 aac) — 240 was ~3.4s, and any receiver
         * hiccup longer than that shed packets, seen as stutter on
         * the theater page that the primary's viewers never got.
         * 1200 ≈ 17s ≈ the bank depth; ~25MB at 12Mbps, cheap.
         */
        'drop_pkts_on_overflow=1', 'queue_size=1200', 'onfail=ignore'];
    return `[${opts.join(':')}${primary ? '' : innerOpts}]${teeEscape(targetUrl(protocol, creds))}`;
  });
  // tee needs the streams named explicitly; it maps nothing by default.
  return [...common, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'tee', slaves.join('|')];
}

/** Secret fields on a destination, by protocol. */
const PUBLISH_SECRETS = {
  rtmp: ['key'], rtmps: ['key'], srt: ['streamId', 'passphrase'],
  tcp: ['key', 'passphrase'],
};

export function redactPublish(publish) {
  const pub = { ...publishDefaults(), ...(publish ?? {}) };
  const mask = (proto, creds) => {
    const out = { ...(creds ?? {}) };
    for (const f of PUBLISH_SECRETS[proto] ?? []) out[f] = out[f] ? '__SET__' : '';
    return out;
  };
  return {
    protocol: pub.protocol,
    name: destName(pub.name),
    rtmp: mask('rtmp', pub.rtmp),
    rtmps: mask('rtmps', pub.rtmps),
    srt: mask('srt', pub.srt),
    tcp: mask('tcp', pub.tcp),
    extras: (pub.extras ?? []).map((e) => ({ ...mask(e.protocol, e), protocol: e.protocol })),
  };
}

/**
 * Put back every secret the browser was never given. A sentinel means "leave
 * what is stored"; anything else is a deliberate overwrite. Extras are
 * matched by id, so reordering or removing one cannot leak another's key
 * into it.
 */
export function restorePublishSecrets(patch, publish) {
  const stored = { ...publishDefaults(), ...(publish ?? {}) };
  for (const proto of ['rtmp', 'rtmps', 'srt', 'tcp']) {
    if (!patch[proto]) continue;
    for (const f of PUBLISH_SECRETS[proto]) {
      if (patch[proto][f] === '__SET__') patch[proto][f] = stored[proto]?.[f] ?? '';
    }
  }
  if (Array.isArray(patch.extras)) {
    const byId = new Map((stored.extras ?? []).map((e) => [e.id, e]));
    patch.extras = patch.extras.map((e) => {
      const prev = byId.get(e.id) ?? {};
      const out = { ...e };
      for (const f of PUBLISH_SECRETS[e.protocol] ?? []) {
        if (out[f] === '__SET__') out[f] = prev[f] ?? '';
      }
      return out;
    });
  }
  return patch;
}

