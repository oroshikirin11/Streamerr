/**
 * Getting the next few clips ready, one at a time.
 *
 * A natural clip boundary feels instant because the successor spent the whole
 * previous clip getting ready. A skip does not: the successor has had only as
 * long as the viewer watched. Worse, a SECOND skip used to land on an item
 * whose preparation began when the first skip completed — on nothing at all.
 * Preparing three deep gives those later skips something warm to land on.
 *
 * The constraint that shapes it: extraction demuxes an entire multi-gigabyte
 * file over the network. Three at once would compete with the live source
 * read, and on a title the encoder only just sustains, that is how the
 * cushion starves. So depth must never buy itself concurrency.
 *
 * Run: node test/prefetch.test.mjs
 */
// Depth defaults to 1 in production (see the constant) because the extra
// reads cost real bandwidth on a box with no encode headroom. The BEHAVIOUR
// this file pins is the same at any depth, so ask for 3 and assert against
// whatever the module resolved.
process.env.STREAMERR_PREFETCH_DEPTH = '3';
const { PipelinePlayout, PREFETCH_DEPTH } = await import('../src/ffmpeg/pipeline.js');

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};

const ep = (n, series = 'Death Note') =>
  ({ id: `${series}-${n}`, series, title: `${series} E${n}`, srcPath: `/m/${series}-${n}.mkv` });

/**
 * A playout stripped to what the prefetch chain touches. Every I/O call is
 * replaced by a deferred promise the test resolves by hand, so the ORDER and
 * OVERLAP of the real calls are observable rather than inferred from timing.
 */
function harness({ current, queue, extractable = () => true }) {
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pending = [];

  const gate = (tag, item) => {
    log.push(`${tag}:${item.title}`);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => {
      pending.push(() => { inFlight -= 1; resolve(null); });
    });
  };

  // The chain always re-walks from the front, so it leans on both calls
  // being idempotent — in production, `_warmed` and `_subCache` respectively.
  // Model that here, or the test would be measuring the stubs.
  const warmed = new Set();
  const extracted = new Set();

  const p = Object.create(PipelinePlayout.prototype);
  Object.assign(p, {
    queue: [...queue],
    current: { item: current },
    selection: { subtitle: { typeIndex: 0, codec: 'ass' } },
    cacheDir: '/cache',
    _stopping: false,
    _abort: { signal: { aborted: false } },
    _subCache: new Map(),
    _durTried: new Set(),
    emit() {},
    _fillDurations() {},
    _warm: (item) => {
      if (warmed.has(item.srcPath)) return Promise.resolve();
      warmed.add(item.srcPath);
      return gate('warm', item);
    },
    _extract: (item) => {
      extracted.add(item.srcPath);
      return gate('extract', item);
    },
    _needsExtraction: (item) => extractable(item) && !extracted.has(item.srcPath),
  });

  // Drain every deferred call the chain has made, repeatedly, until it stops
  // making new ones. Each pass resolves only what was already outstanding, so
  // a chain that (wrongly) started two at once would be caught by maxInFlight.
  const settle = async () => {
    for (let guard = 0; guard < 200; guard += 1) {
      await Promise.resolve();
      if (!pending.length) {
        await new Promise((r) => setImmediate(r));
        if (!pending.length) return;
      }
      pending.splice(0, pending.length).forEach((done) => done());
    }
    throw new Error('prefetch chain did not settle');
  };

  return { p, log, settle, peak: () => maxInFlight };
}

console.log('\nhow far ahead, and how many at once');

{
  const q = [ep(2), ep(3), ep(4), ep(5), ep(6)];
  const h = harness({ current: ep(1), queue: q });
  h.p._prefetchUpcoming();
  await h.settle();

  check(`prepares exactly ${PREFETCH_DEPTH} ahead, no deeper`,
    h.log.filter((l) => l.startsWith('extract:')).length, PREFETCH_DEPTH);
  check('...and in queue order', h.log, [
    'warm:Death Note E2', 'extract:Death Note E2',
    'warm:Death Note E3', 'extract:Death Note E3',
    'warm:Death Note E4', 'extract:Death Note E4',
  ]);
  // The whole point of the design: depth must not become concurrency.
  check('never more than one file being read at a time', h.peak(), 1);
}

{
  // A queue shorter than the depth must simply stop, not spin on holes.
  const h = harness({ current: ep(1), queue: [ep(2)] });
  h.p._prefetchUpcoming();
  await h.settle();
  check('a short queue stops at its end', h.log,
    ['warm:Death Note E2', 'extract:Death Note E2']);
}

{
  // Already cached: nothing to extract, but warming is still worth doing.
  const h = harness({ current: ep(1), queue: [ep(2), ep(3)], extractable: () => false });
  h.p._prefetchUpcoming();
  await h.settle();
  check('nothing to extract still warms the files', h.log,
    ['warm:Death Note E2', 'warm:Death Note E3']);
}

console.log('\nwhat a queue edit does');

{
  // The reported edge case: two episodes queued, a third added while the
  // first is still on air. Before, nothing looked at it until the next clip
  // boundary — throwing away the rest of the current clip's runtime.
  const h = harness({ current: ep(1), queue: [ep(2), ep(3)] });
  h.p._prefetchUpcoming();
  await h.settle();
  check('the original two are prepared', h.log.filter((l) => l.startsWith('extract:')),
    ['extract:Death Note E2', 'extract:Death Note E3']);

  h.p.setQueue([ep(2), ep(3), ep(4)]);
  await h.settle();
  check('...an item added mid-clip is picked up too',
    h.log.filter((l) => l.startsWith('extract:')).includes('extract:Death Note E4'), true);
  check('...without re-reading the two already done',
    h.log.filter((l) => l === 'extract:Death Note E2').length, 1);
  check('...and still one file at a time', h.peak(), 1);
}

{
  // Editing the queue before anything is on air must not start reading
  // gigabytes off the share — that is just someone building a queue.
  const h = harness({ current: ep(1), queue: [] });
  h.p.current = null;
  h.p.setQueue([ep(2), ep(3)]);
  await h.settle();
  check('a queue edit with nothing on air reads nothing', h.log, []);
}

{
  // Rapid edits must coalesce into one more pass, not one chain per edit.
  const h = harness({ current: ep(1), queue: [ep(2), ep(3), ep(4)] });
  h.p._prefetchUpcoming();
  h.p._prefetchUpcoming();
  h.p._prefetchUpcoming();
  await h.settle();
  check('repeated kicks do not stack up parallel chains', h.peak(), 1);
  check('...and do not re-read what is done',
    h.log.filter((l) => l === 'warm:Death Note E2').length, 1);
}

console.log('\nwhose subtitles are worth pulling');

{
  // _extract pulls the track index CURRENTLY selected, and a track choice
  // does not carry to an unrelated work. Spending a full read on a film's
  // track 0 because an episode chose track 0 is a wasted read.
  const film = { id: 'm1', series: null, title: 'Backrooms', srcPath: '/m/br.mkv' };
  const other = { id: 'm2', series: null, title: 'Apocalypto', srcPath: '/m/ap.mkv' };
  const h = harness({ current: ep(1), queue: [ep(2), film, other] });
  h.p._prefetchUpcoming();
  await h.settle();

  check('the immediate successor is always extracted',
    h.log.includes('extract:Death Note E2'), true);
  check('an unrelated film further back is NOT extracted',
    h.log.some((l) => l.startsWith('extract:Backrooms')), false);
  check('...but it is still warmed, which is correct whatever plays',
    h.log.includes('warm:Backrooms'), true);
  check('...and the queue keeps being walked past it',
    h.log.includes('warm:Apocalypto'), true);
}

{
  // A film on air with its own sequel queued behind it: still one work each,
  // so only the immediate successor earns the read.
  const film = { id: 'm1', series: null, title: 'Backrooms', srcPath: '/m/br.mkv' };
  const h = harness({ current: film, queue: [ep(2), ep(3)] });
  h.p._prefetchUpcoming();
  await h.settle();
  check('a series behind a film: successor yes, the rest no',
    h.log.filter((l) => l.startsWith('extract:')), ['extract:Death Note E2']);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
