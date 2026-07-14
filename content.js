/* Colonist Card Counter (Personal)
 * Reads the public game log on colonist.io via MutationObserver, parses events,
 * and tracks per-player resource counts with hypothesis branching for unknown steals.
 *
 * Design notes:
 *  - The log is a virtualized list: only ~15 messages exist in the DOM at once,
 *    and old nodes get re-mounted when you scroll. We dedupe by data-index and
 *    keep every parsed event in an index-sorted store. If an older message shows
 *    up late (scrollback), we rebuild state from scratch — events are cheap.
 *  - Unknown robber steals branch the state into weighted hypotheses. Later
 *    events (spends, trades, offers, monopoly totals) prune impossible branches.
 *  - All site-specific matching lives in CONFIG so selector/wording drift is a
 *    one-place fix. Unmatched messages are logged when DEBUG is on.
 */
(() => {
  'use strict';
  if (window.__colonistCounterLoaded) return;
  window.__colonistCounterLoaded = true;

  // ------------------------------------------------------------------ config
  const CONFIG = {
    DEBUG: false,              // console-log unmatched messages + parse trace
    MAX_HYPOTHESES: 2000,      // cap before weight-based pruning
    UI_THROTTLE_MS: 250,
    RESOURCES: ['wood', 'brick', 'sheep', 'wheat', 'ore'],
    // img src/alt matchers -> canonical resource
    RES_MATCHERS: [
      [/lumber|wood/i, 'wood'],
      [/brick/i, 'brick'],
      [/wool|sheep/i, 'sheep'],
      [/grain|wheat/i, 'wheat'],
      [/ore/i, 'ore'],
    ],
    PIECE_MATCHERS: [
      [/road/i, 'road'],
      [/settlement|house/i, 'settlement'],
      [/city/i, 'city'],
      [/devcard|dev_card|card_dev/i, 'devcard'],
    ],
    DICE_RE: /dice_?(\d)/i,
    // any card-ish img that didn't match a resource = hidden/unknown card
    HIDDEN_CARD_RE: /card/i,
    COSTS: {
      road:       { wood: 1, brick: 1 },
      settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
      city:       { wheat: 2, ore: 3 },
      devcard:    { sheep: 1, wheat: 1, ore: 1 },
    },
  };

  const log = (...a) => CONFIG.DEBUG && console.log('%c[CardCounter]', 'color:#7ee787', ...a);
  const warn = (...a) => console.warn('[CardCounter]', ...a);

  // ------------------------------------------------------- hypothesis engine
  // A hypothesis: { counts: { player: {wood:0,...} }, w: weight }
  class Tracker {
    constructor() { this.reset(); }

    reset() {
      this.hyps = [{ counts: {}, w: 1 }];
      this.players = new Set();
      this.dice = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 2, 0]));
      this.devBought = {};
      this.warnings = 0;
    }

    ensure(p) {
      if (!p) return;
      this.players.add(p);
      for (const h of this.hyps) {
        if (!h.counts[p]) h.counts[p] = Object.fromEntries(CONFIG.RESOURCES.map(r => [r, 0]));
      }
    }

    _normalize() {
      // merge identical states, renormalize weights, cap count
      const map = new Map();
      for (const h of this.hyps) {
        const key = JSON.stringify(h.counts);
        const prev = map.get(key);
        if (prev) prev.w += h.w; else map.set(key, h);
      }
      let hyps = [...map.values()];
      if (hyps.length > CONFIG.MAX_HYPOTHESES) {
        hyps.sort((a, b) => b.w - a.w);
        hyps = hyps.slice(0, CONFIG.MAX_HYPOTHESES);
      }
      const total = hyps.reduce((s, h) => s + h.w, 0) || 1;
      for (const h of hyps) h.w /= total;
      this.hyps = hyps;
    }

    // mutate every hypothesis; drop ones that become invalid (negative counts).
    // If ALL would be invalid, an earlier message was missed or unparsed: the
    // cards evidently existed, so correct (clamp) and count it in the footer.
    _applyAll(fn, ctx) {
      const next = [];
      for (const h of this.hyps) {
        const c = structuredClone(h.counts);
        if (fn(c) !== false) next.push({ counts: c, w: h.w });
      }
      if (next.length) {
        this.hyps = next;
      } else {
        this.warnings++;
        log(`correction: ${ctx || 'event'} implied cards that were never tracked — likely an unparsed earlier message (see UNMATCHED lines)`);
        for (const h of this.hyps) fn(h.counts, /*clamp*/ true);
      }
      this._normalize();
    }

    gain(p, bundle) {
      this.ensure(p);
      this._applyAll(c => {
        for (const [r, n] of Object.entries(bundle)) c[p][r] += n;
      }, `${p} gains ${JSON.stringify(bundle)}`);
    }

    lose(p, bundle) {
      this.ensure(p);
      this._applyAll((c, clamp) => {
        for (const [r, n] of Object.entries(bundle)) {
          c[p][r] -= n;
          if (c[p][r] < 0) { if (clamp) c[p][r] = 0; else return false; }
        }
      }, `${p} spends ${JSON.stringify(bundle)}`);
    }

    transfer(from, to, bundle) {
      if (from === to) return; // self-trades are impossible; guard against name-merge edge cases
      this.ensure(from); this.ensure(to);
      this._applyAll((c, clamp) => {
        for (const [r, n] of Object.entries(bundle)) {
          c[from][r] -= n; c[to][r] += n;
          if (c[from][r] < 0) { if (clamp) { c[to][r] += c[from][r]; c[from][r] = 0; } else return false; }
        }
      }, `${from} gives ${to} ${JSON.stringify(bundle)}`);
    }

    // player proved they hold at least `bundle` (e.g. made a trade offer).
    // If NO hypothesis allows it, they revealed a card we never tracked —
    // grant it (it was one of their mystery cards / a missed message).
    requireAtLeast(p, bundle) {
      this.ensure(p);
      const before = this.hyps.length;
      const kept = this.hyps.filter(h =>
        Object.entries(bundle).every(([r, n]) => h.counts[p][r] >= n));
      if (kept.length) {
        this.hyps = kept;
        this._normalize();
      } else {
        this.warnings++;
        log(`correction: ${p} revealed untracked cards ${JSON.stringify(bundle)} — crediting them`);
        this._applyAll(c => {
          for (const [r, n] of Object.entries(bundle)) {
            if (c[p][r] < n) c[p][r] = n;
          }
        }, `${p} reveals ${JSON.stringify(bundle)}`);
      }
      if (CONFIG.DEBUG && kept.length && kept.length !== before) log(`reveal pruned ${before - kept.length} hypotheses`);
    }

    // robber steal where the card is hidden: branch per possible resource
    unknownSteal(thief, victim) {
      this.ensure(thief); this.ensure(victim);
      const next = [];
      for (const h of this.hyps) {
        const held = CONFIG.RESOURCES.filter(r => h.counts[victim][r] > 0);
        const totalCards = held.reduce((s, r) => s + h.counts[victim][r], 0);
        if (!totalCards) { next.push(h); continue; } // victim empty: no-op steal
        for (const r of held) {
          const c = structuredClone(h.counts);
          c[victim][r] -= 1; c[thief][r] += 1;
          next.push({ counts: c, w: h.w * (h.counts[victim][r] / totalCards) });
        }
      }
      this.hyps = next;
      this._normalize();
    }

    // monopoly: thief takes every `res` from everyone; `announced` (card count
    // from the log, if present) prunes hypotheses with a different total.
    monopoly(thief, res, announced) {
      this.ensure(thief);
      const next = [];
      for (const h of this.hyps) {
        let sum = 0;
        for (const p of this.players) if (p !== thief) sum += h.counts[p][res];
        if (announced != null && sum !== announced) continue;
        const c = structuredClone(h.counts);
        for (const p of this.players) if (p !== thief) c[p][res] = 0;
        c[thief][res] += sum;
        next.push({ counts: c, w: h.w });
      }
      if (next.length) this.hyps = next;
      else { // announced total impossible in every branch -> trust the log
        this.warnings++;
        this._applyAll(c => {
          for (const p of this.players) if (p !== thief) c[p][res] = 0;
          if (announced != null) c[thief][res] += announced;
        }, `${thief} monopolizes ${res}`);
        return;
      }
      this._normalize();
    }

    // ---- readouts -------------------------------------------------------
    summary() {
      const out = {};
      for (const p of this.players) {
        out[p] = {};
        let sumMins = 0;
        for (const r of CONFIG.RESOURCES) {
          let min = Infinity, max = -Infinity, probMore = 0, exp = 0;
          for (const h of this.hyps) {
            const v = h.counts[p]?.[r] ?? 0;
            if (v < min) min = v;
            if (v > max) max = v;
            exp += v * h.w;
          }
          for (const h of this.hyps) if ((h.counts[p]?.[r] ?? 0) > min) probMore += h.w;
          out[p][r] = { min, max, exp, probMore };
          sumMins += min;
        }
        // total hand size per hypothesis (usually identical across branches)
        let hMin = Infinity, hMax = -Infinity;
        for (const h of this.hyps) {
          const t = CONFIG.RESOURCES.reduce((s, r) => s + (h.counts[p]?.[r] ?? 0), 0);
          if (t < hMin) hMin = t;
          if (t > hMax) hMax = t;
        }
        out[p].__total = { min: hMin, max: hMax };
        // mystery cards: cards known to be in hand but of uncertain type
        out[p].__unknown = Math.max(0, hMax - sumMins);
      }
      return out;
    }
  }

  // ---------------------------------------------------------------- tokenizer
  // Walk a log-message element and emit an ordered token stream:
  //   {t:'word', v}  {t:'res', v}  {t:'piece', v}  {t:'dice', v}  {t:'hidden'}
  function tokenize(el) {
    const tokens = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const w of node.textContent.trim().split(/\s+/)) {
          if (w) tokens.push({ t: 'word', v: w });
        }
      } else if (node.tagName === 'IMG') {
        const id = `${node.getAttribute('src') || ''} ${node.getAttribute('alt') || ''}`;
        const dice = id.match(CONFIG.DICE_RE);
        if (dice) { tokens.push({ t: 'dice', v: +dice[1] }); continue; }
        let matched = false;
        for (const [re, res] of CONFIG.RES_MATCHERS) {
          if (re.test(id)) { tokens.push({ t: 'res', v: res }); matched = true; break; }
        }
        if (matched) continue;
        for (const [re, piece] of CONFIG.PIECE_MATCHERS) {
          if (re.test(id)) { tokens.push({ t: 'piece', v: piece }); matched = true; break; }
        }
        if (!matched && CONFIG.HIDDEN_CARD_RE.test(id)) tokens.push({ t: 'hidden' });
      }
    }
    return tokens;
  }

  const wordsLower = tokens => tokens.filter(t => t.t === 'word').map(t => t.v.toLowerCase());
  const textOf = tokens => wordsLower(tokens).join(' ');
  const norm = w => w.toLowerCase().replace(/[:.,!]+$/, '');

  // The log refers to the current user as "You" (actor) or "you" (object) —
  // merge every casing into one identity so they aren't separate players.
  const canonName = n => (n && /^you$/i.test(n.trim()) ? 'You' : n);

  function bundleFrom(resTokens) {
    const b = {};
    for (const t of resTokens) b[t.v] = (b[t.v] || 0) + 1;
    return b;
  }

  // words strictly before the first occurrence of `keyword` = actor name
  function nameBefore(tokens, keyword) {
    const parts = [];
    for (const t of tokens) {
      if (t.t !== 'word') break;
      if (norm(t.v) === keyword) break;
      parts.push(t.v);
    }
    return canonName(parts.join(' ').replace(/[:.,!]+$/, '')) || null;
  }

  // words after the LAST occurrence of `keyword`
  function nameAfter(tokens, keyword) {
    let idx = -1;
    tokens.forEach((t, i) => { if (t.t === 'word' && norm(t.v) === keyword) idx = i; });
    if (idx < 0) return null;
    const parts = [];
    for (let i = idx + 1; i < tokens.length; i++) {
      if (tokens[i].t !== 'word') break;
      parts.push(tokens[i].v);
    }
    return canonName(parts.join(' ').replace(/[:.,!]+$/, '')) || null;
  }

  function resBetween(tokens, startWord, endWord) {
    let started = startWord == null, out = [];
    for (const t of tokens) {
      if (!started) {
        if (t.t === 'word' && norm(t.v) === startWord) started = true;
        continue;
      }
      if (endWord && t.t === 'word' && norm(t.v) === endWord) break;
      if (t.t === 'res') out.push(t);
    }
    return out;
  }

  // ------------------------------------------------------------ event parser
  // Returns an event object {type, ...} or null (irrelevant) or {type:'unknown'}
  const RES_WORDS = {
    lumber: 'wood', wood: 'wood', brick: 'brick', bricks: 'brick',
    wool: 'sheep', sheep: 'sheep', grain: 'wheat', wheat: 'wheat', ore: 'ore',
  };

  function parseTokens(tokens) {
    const text = textOf(tokens);
    if (!text) return null;
    const res = tokens.filter(t => t.t === 'res');
    const dice = tokens.filter(t => t.t === 'dice');
    const pieces = tokens.filter(t => t.t === 'piece');
    const hidden = tokens.some(t => t.t === 'hidden');
    const resWords = wordsLower(tokens).map(w => RES_WORDS[norm(w)]).filter(Boolean);

    // dice roll
    if (/\brolled\b/.test(text) && dice.length >= 2) {
      return { type: 'roll', player: nameBefore(tokens, 'rolled'), sum: dice[0].v + dice[1].v };
    }

    // bank trade: "X gave bank [...] and took [...]"
    if (/gave bank/.test(text) && /\btook\b/.test(text)) {
      return {
        type: 'bankTrade',
        player: nameBefore(tokens, 'gave'),
        gave: bundleFrom(resBetween(tokens, 'bank', 'took')),
        took: bundleFrom(resBetween(tokens, 'took', null)),
      };
    }

    // resource income: "X got:" / "X received starting resources"
    // (guard against trade wordings that also contain "got")
    if (/\bgot\b/.test(text) && !/\bgave\b|\btraded\b|\bwith\b/.test(text) && res.length) {
      return { type: 'gain', player: nameBefore(tokens, 'got'), bundle: bundleFrom(res) };
    }
    if (/starting resources/.test(text) && res.length) {
      return { type: 'gain', player: nameBefore(tokens, 'received'), bundle: bundleFrom(res) };
    }

    // year of plenty: "X took [...] from bank"
    if (/\btook\b/.test(text) && /\bbank\b/.test(text) && !/gave/.test(text) && res.length) {
      return { type: 'gain', player: nameBefore(tokens, 'took'), bundle: bundleFrom(res) };
    }

    // player trade: "X traded [...] for [...] with Y"
    if (/\btraded\b/.test(text) && /\bwith\b/.test(text)) {
      return {
        type: 'trade',
        player: nameBefore(tokens, 'traded'),
        partner: nameAfter(tokens, 'with'),
        gave: bundleFrom(resBetween(tokens, 'traded', 'for')),
        took: bundleFrom(resBetween(tokens, 'for', 'with')),
      };
    }

    // player trade, alternate wording: "X gave [...] and got [...] (from Y)"
    if (/\bgave\b/.test(text) && /\bgot\b/.test(text) && !/\bbank\b/.test(text)) {
      return {
        type: 'trade',
        player: nameBefore(tokens, 'gave'),
        partner: nameAfter(tokens, 'from'),
        gave: bundleFrom(resBetween(tokens, 'gave', 'got')),
        took: bundleFrom(resBetween(tokens, 'got', 'from')),
      };
    }

    // trade offer: "X wants to give [...] for [...]" — proves possession AND is
    // remembered so a following "Y accepted trade offer" can execute it.
    if (/wants to give/.test(text)) {
      return {
        type: 'offer',
        player: nameBefore(tokens, 'wants'),
        bundle: bundleFrom(resBetween(tokens, 'give', 'for')),
        took: bundleFrom(resBetween(tokens, 'for', null)),
      };
    }

    // counter offer proves possession: "X proposed counter offer [...] for [...]"
    if (/counter offer/.test(text) && res.length) {
      return {
        type: 'offer',
        player: nameBefore(tokens, 'proposed'),
        bundle: bundleFrom(resBetween(tokens, 'offer', 'for')),
        took: bundleFrom(resBetween(tokens, 'for', null)),
      };
    }

    // accepted offer: "Y accepted trade (offer) (from X)"
    if (/\baccepted\b/.test(text)) {
      return {
        type: 'tradeAccept',
        accepter: nameBefore(tokens, 'accepted'),
        proposer: nameAfter(tokens, 'from'), // may be null -> falls back to last offer
      };
    }

    const monoMatch = text.match(/\bstole\b\s+(\d+)/);
    if (monoMatch && !/\bfrom\b/.test(text)) {
      const monoRes = res.length === 1 ? res[0].v : (resWords.length === 1 ? resWords[0] : null);
      if (monoRes) return { type: 'monopoly', player: nameBefore(tokens, 'stole'), res: monoRes, count: +monoMatch[1] };
    }

    // robber steal: "X stole [res|hidden] from Y"
    if (/\bstole\b/.test(text) && /\bfrom\b/.test(text)) {
      const thief = nameBefore(tokens, 'stole');
      const victim = nameAfter(tokens, 'from');
      if (res.length === 1 && !hidden) return { type: 'stealKnown', thief, victim, res: res[0].v };
      return { type: 'stealUnknown', thief, victim };
    }

    // discard: "X discarded [...]"
    if (/\bdiscarded\b/.test(text) && res.length) {
      return { type: 'lose', player: nameBefore(tokens, 'discarded'), bundle: bundleFrom(res) };
    }

    // builds (paid): "X built a [piece]" — piece may be an icon or a word
    const PIECE_WORDS = { road: 'road', settlement: 'settlement', city: 'city' };
    const pieceWord = wordsLower(tokens).map(w => PIECE_WORDS[norm(w)]).find(Boolean);
    if (/\bbuilt\b/.test(text) && (pieces.length || pieceWord)) {
      return { type: 'build', player: nameBefore(tokens, 'built'), piece: pieces.length ? pieces[0].v : pieceWord };
    }

    // dev card purchase: "X bought [devcard]" — require a dev card signal so
    // chat messages containing the word "bought" don't false-positive
    if (/\bbought\b/.test(text) && (pieces.some(t => t.v === 'devcard') || hidden || /development|dev card|devcard/.test(text))) {
      return { type: 'build', player: nameBefore(tokens, 'bought'), piece: 'devcard', dev: true };
    }

    // generic income fallback: "X received [...]" (non-trade wording)
    if (/\breceived\b/.test(text) && !/\bfrom\b|\bwith\b|\btraded\b/.test(text) && res.length) {
      return { type: 'gain', player: nameBefore(tokens, 'received'), bundle: bundleFrom(res) };
    }

    // free placements / robber moves / knight plays etc. — irrelevant to counts
    if (/\bplaced\b|\bmoved robber\b|\bused\b|\bplayed\b|is now|turn|joined|left|won|disconnected|reconnect/.test(text)) {
      return null;
    }

    // UI noise the message detector can pick up (lobby banners, profile
    // popups, dev-card tooltips, dice-probability panels) — not log events.
    if (/connected to game|happy settling|rulebook|list of commands|chat is being monitored|profile|overview|ranked|history of last|place the robber|steal a random card|discard cards \(|was rolled!|balanced dice|learn how to play|settings|spectat/i.test(text)) {
      return null;
    }
    if (/^[\d\s]+$/.test(text)) return null;          // bare numbers (probability panels)
    if (wordsLower(tokens).length > 20) return null;  // long UI panels aren't log lines

    return { type: 'unknown', text };
  }

  // ------------------------------------------------------------- event store
  const tracker = new Tracker();
  const eventsByIndex = new Map(); // index -> event
  let syntheticSeq = 0;            // epsilon slots for messages without data-index
  const CARD_EVENTS = new Set(['roll', 'gain', 'lose', 'bankTrade', 'trade', 'offer', 'tradeAccept', 'stealKnown', 'stealUnknown', 'monopoly', 'build']);
  let maxAppliedIndex = -Infinity;
  let unknownCount = 0;
  const unmatchedLines = new Set();
  // pending trade offers (proposer -> {gave, took}) + last applied card event,
  // used to pair "accepted trade" lines and to avoid double-counting when the
  // log emits BOTH an accept line and an explicit traded line.
  let pendingOffers = new Map();
  let lastOfferPlayer = null;
  // adjacency guards: a trade can be logged as an "accepted" line AND an
  // explicit "traded" line for the same pair back-to-back — apply only one.
  let lastAcceptPair = null;
  let lastExplicitPair = null;

  const pairKey = (a, b) => [a, b].sort().join('||');
  const clearPairGuards = () => { lastAcceptPair = null; lastExplicitPair = null; };

  // ---- "You" <-> username identity merge (automatic) ----------------------
  // The log calls the current user "You" but names everyone else. Colonist's
  // player status panel lists the current user LAST, so: find the smallest
  // element containing every known player name (= the status panel; our own
  // overlay lives in a shadow root and is invisible to this scan), and take
  // the bottom-most name as self.
  let selfName = null;
  let selfDetected = false;
  let detectedAtPlayerCount = 0;
  const recentMessageRoots = []; // recent REAL log message elements — mark the feed region

  const resolveName = n => (n === 'You' && selfName ? selfName : n);
  const NAME_FIELDS = ['player', 'partner', 'thief', 'victim', 'accepter', 'proposer'];

  function detectSelf() {
    const names = [...tracker.players].filter(n => n !== 'You');
    // re-run when new players show up, in case an early detection was wrong
    if (selfDetected && names.length <= detectedAtPlayerCount) return;
    if (names.length < 2) return; // not enough signal yet

    // Structural matching: in the status panel each username is rendered in
    // its own element, so a name "occurs" where a text node's trimmed content
    // EQUALS it. This avoids two flattened-text failure modes: count digits
    // jamming against names ("0Bob"), and usernames that are substrings of
    // other usernames ("dan" inside "tmdan").
    const nodeOrderOf = (root, name) => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const hits = []; let t, i = 0;
      while ((t = tw.nextNode())) {
        if (t.textContent.trim() === name) hits.push(i);
        i++;
      }
      return hits;
    };

    // anchor on text nodes containing the first name, then walk up to the
    // smallest ancestor that contains all names
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const anchors = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes(names[0])) {
        anchors.push(node.parentElement);
        if (anchors.length > 60) break;
      }
    }
    let best = null;
    for (let el of anchors) {
      while (el && el !== document.body) {
        const txt = el.textContent || '';
        if (names.every(n => txt.includes(n))) {
          // The status panel lists each player exactly ONCE and never contains
          // log messages; the chat feed repeats names and contains them.
          const isLogRegion = recentMessageRoots.some(r => { try { return el.contains(r); } catch { return false; } });
          const eachOnce = names.every(n => nodeOrderOf(el, n).length === 1);
          if (!isLogRegion && eachOnce && txt.length <= 800) {
            if (!best || txt.length < (best.textContent || '').length) best = el;
          }
          break; // higher ancestors only get bigger
        }
        el = el.parentElement;
      }
    }
    if (!best) return; // panel not found yet — retry on a later render

    let last = null, lastPos = -1;
    for (const n of names) {
      const hits = nodeOrderOf(best, n);
      const pos = hits.length ? hits[hits.length - 1] : -1;
      if (pos > lastPos) { lastPos = pos; last = n; }
    }
    if (!last) return;
    const changed = last !== selfName;
    selfName = last;
    selfDetected = true;
    detectedAtPlayerCount = names.length;
    if (changed) {
      log(`detected current user from status panel order: ${last}`);
      rebuild();
      scheduleRender();
    }
  }

  function applyEvent(raw) {
    // map "You" onto the detected username (applied here, not at parse time,
    // so detection works retroactively through rebuild)
    let ev = raw;
    if (selfName) {
      ev = { ...raw };
      for (const k of NAME_FIELDS) if (ev[k]) ev[k] = resolveName(ev[k]);
    }
    switch (ev.type) {
      case 'roll': if (ev.sum >= 2 && ev.sum <= 12) tracker.dice[ev.sum]++; if (ev.player) tracker.ensure(ev.player); break;
      case 'gain': clearPairGuards(); if (ev.player) tracker.gain(ev.player, ev.bundle); break;
      case 'lose': clearPairGuards(); if (ev.player) tracker.lose(ev.player, ev.bundle); break;
      case 'bankTrade':
        clearPairGuards();
        if (ev.player) { tracker.lose(ev.player, ev.gave); tracker.gain(ev.player, ev.took); }
        break;
      case 'trade':
        if (ev.player && ev.partner) {
          const key = pairKey(ev.player, ev.partner);
          if (lastAcceptPair === key) { clearPairGuards(); break; } // same trade, already applied via accept line
          tracker.transfer(ev.player, ev.partner, ev.gave);
          tracker.transfer(ev.partner, ev.player, ev.took);
          lastExplicitPair = key; lastAcceptPair = null;
        }
        break;
      case 'offer':
        if (ev.player) {
          tracker.requireAtLeast(ev.player, ev.bundle);
          pendingOffers.set(ev.player, { gave: ev.bundle, took: ev.took || {} });
          lastOfferPlayer = ev.player;
        }
        break;
      case 'tradeAccept': {
        const proposer = ev.proposer || lastOfferPlayer;
        const offer = proposer && pendingOffers.get(proposer);
        if (offer && ev.accepter && ev.accepter !== proposer) {
          const key = pairKey(proposer, ev.accepter);
          if (lastExplicitPair === key) { clearPairGuards(); break; } // same trade, already applied via traded line
          tracker.transfer(proposer, ev.accepter, offer.gave);
          tracker.transfer(ev.accepter, proposer, offer.took);
          lastAcceptPair = key; lastExplicitPair = null;
        }
        break;
      }
      case 'stealKnown': clearPairGuards(); if (ev.thief && ev.victim) tracker.transfer(ev.victim, ev.thief, { [ev.res]: 1 }); break;
      case 'stealUnknown': clearPairGuards(); if (ev.thief && ev.victim) tracker.unknownSteal(ev.thief, ev.victim); break;
      case 'monopoly': clearPairGuards(); if (ev.player) tracker.monopoly(ev.player, ev.res, ev.count); break;
      case 'build':
        clearPairGuards();
        if (ev.player) {
          tracker.lose(ev.player, CONFIG.COSTS[ev.piece] || {});
          if (ev.dev) tracker.devBought[ev.player] = (tracker.devBought[ev.player] || 0) + 1;
        }
        break;
      case 'unknown':
        unknownCount++;
        unmatchedLines.add(ev.text);
        log('UNMATCHED log line:', ev.text);
        break;
    }
  }

  function resetTransients() {
    unknownCount = 0;
    unmatchedLines.clear();
    pendingOffers = new Map();
    lastOfferPlayer = null;
    clearPairGuards();
  }

  function rebuild() {
    tracker.reset();
    resetTransients();
    const sorted = [...eventsByIndex.keys()].sort((a, b) => a - b);
    for (const i of sorted) applyEvent(eventsByIndex.get(i));
    maxAppliedIndex = sorted.length ? sorted[sorted.length - 1] : -Infinity;
  }

  function ingestMessage(el) {
    let index = el.getAttribute?.('data-index');
    if (index == null) index = el.closest?.('[data-index]')?.getAttribute('data-index');
    let key;
    if (index != null) {
      key = +index;
      if (eventsByIndex.has(key)) return; // virtual-scroller re-mount
    } else {
      // No data-index (noise panels / fallback mode): slot just after the
      // current max with a tiny epsilon so real indices are never overtaken —
      // otherwise one synthetic key would make every later real message look
      // out-of-order and trigger a full rebuild per message.
      syntheticSeq++;
      key = (maxAppliedIndex === -Infinity ? 0 : maxAppliedIndex) + syntheticSeq * 1e-6;
    }
    const tokens = tokenize(el);
    const ev = parseTokens(tokens);
    if (!ev) { eventsByIndex.set(key, { type: 'noop' }); return; }
    eventsByIndex.set(key, ev);
    if (CARD_EVENTS.has(ev.type)) {
      // remember real log message elements — they mark the feed region so
      // self-detection can exclude it (noise panels must NOT be recorded here)
      recentMessageRoots.push(el);
      if (recentMessageRoots.length > 3) recentMessageRoots.shift();
    }
    if (key >= maxAppliedIndex) {
      applyEvent(ev);
      maxAppliedIndex = key;
    } else {
      log('out-of-order message (scrollback) — rebuilding state');
      rebuild();
    }
    scheduleRender();
  }

  // --------------------------------------------------------- log discovery
  const KEYWORD_RE = /\brolled\b|\bgot\b|\bbuilt\b|\bplaced\b|\btraded\b|\bstole\b|\bdiscarded\b|\bbought\b|starting resources|gave bank|wants to give/i;

  function looksLikeLogMessage(el) {
    if (!(el instanceof HTMLElement)) return false;
    const text = el.textContent || '';
    if (text.length > 300) return false;
    return KEYWORD_RE.test(text) || (!!el.querySelector?.('img') && /card_|dice_/i.test(el.innerHTML));
  }

  // find the smallest message unit: prefer the [data-index] wrapper
  function messageRoot(el) {
    return el.closest?.('[data-index]') || el;
  }

  const seen = new WeakSet();

  function processNode(node) {
    if (!(node instanceof HTMLElement)) return;
    const candidates = [];
    if (looksLikeLogMessage(node)) candidates.push(node);
    node.querySelectorAll?.('[data-index]').forEach(el => candidates.push(el));
    for (const c of candidates) {
      const root = messageRoot(c);
      if (seen.has(root)) continue;
      if (!looksLikeLogMessage(root)) continue;
      seen.add(root);
      try { ingestMessage(root); } catch (e) { warn('parse error', e); }
    }
  }

  function scanExisting() {
    document.querySelectorAll('[data-index]').forEach(processNode);
    // fallback if the feed doesn't use data-index anymore
    if (eventsByIndex.size === 0) {
      document.querySelectorAll('div,span,li').forEach(el => {
        if (el.childElementCount <= 8 && looksLikeLogMessage(el) && !looksLikeLogMessage(el.parentElement)) {
          processNode(el);
        }
      });
    }
  }

  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) processNode(n);
      if (m.type === 'characterData' && m.target.parentElement) processNode(m.target.parentElement);
    }
  });

  // ------------------------------------------------------------------ overlay
  let host, shadow, renderQueued = false, collapsed = false;

  function buildUI() {
    host = document.createElement('div');
    host.id = 'colonist-card-counter-host';
    Object.assign(host.style, { position: 'fixed', bottom: '16px', right: '16px', zIndex: 2147483646 });
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
          font: 12px/1.45 "SF Mono", "Cascadia Code", Consolas, monospace;
          color: #000; background: #fff;
          border: 1px solid #000; border-radius: 8px;
          width: max-content; min-width: 280px; max-width: min(94vw, 720px);
          box-shadow: 0 4px 18px rgba(0,0,0,.35);
          user-select: none; overflow: hidden;
        }
        .bar {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 10px;
          border-bottom: 1px solid #000; background: #fff;
        }
        .bar .title { font-weight: 700; letter-spacing: .06em; flex: 1; }
        .bar button {
          all: unset; cursor: pointer; padding: 2px 8px; border-radius: 5px;
          border: 1px solid #000; color: #000; font: inherit; font-size: 11px;
        }
        .bar button:hover { background: #000; color: #fff; }
        .bar button:focus-visible { outline: 2px solid #000; outline-offset: 1px; }
        #body { overflow-x: auto; }
        table { border-collapse: collapse; width: 100%; }
        th, td { padding: 4px 9px; text-align: right; white-space: nowrap; }
        th { color: #333; font-weight: 700; border-bottom: 1px solid #000; }
        td:first-child, th:first-child { text-align: left; max-width: 130px; overflow: hidden; text-overflow: ellipsis; }
        tr + tr td { border-top: 1px solid #ddd; }
        .prob { color: #666; font-size: 10px; }
        .tot { font-weight: 700; }
        .foot { padding: 5px 10px 8px; color: #444; font-size: 10px; display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid #ddd; }
        .warn { font-weight: 700; }
        .hint { padding: 10px; color: #444; }
      </style>
      <div class="panel">
        <div class="bar" id="drag">
          <span class="title">CARD COUNTER</span>
          <button id="copyDebug" title="Copy log lines the parser couldn't understand">Copy unparsed</button>
          <button id="reset" title="Clear tracked state and reparse the visible log">Reset</button>
          <button id="collapse">&#8722;</button>
        </div>
        <div id="body"><div class="hint">Waiting for game log… start or resume a game.</div></div>
      </div>`;
    document.documentElement.appendChild(host);

    shadow.getElementById('copyDebug').addEventListener('click', async () => {
      const btn = shadow.getElementById('copyDebug');
      const payload = unmatchedLines.size
        ? [...unmatchedLines].join('\n')
        : '(no unparsed lines this game)';
      try {
        await navigator.clipboard.writeText(payload);
        btn.textContent = `Copied ${unmatchedLines.size}`;
      } catch {
        console.log('[CardCounter] unparsed lines:\n' + payload);
        btn.textContent = 'See console';
      }
      setTimeout(() => { btn.textContent = 'Copy unparsed'; }, 1500);
    });

    shadow.getElementById('reset').addEventListener('click', () => {
      eventsByIndex.clear();
      tracker.reset();
      resetTransients();
      maxAppliedIndex = -Infinity;
      syntheticSeq = 0;
      recentMessageRoots.length = 0;
      selfName = null;
      selfDetected = false;
      detectedAtPlayerCount = 0;
      scanExisting();
      scheduleRender();
    });
    shadow.getElementById('collapse').addEventListener('click', () => {
      collapsed = !collapsed;
      shadow.getElementById('body').style.display = collapsed ? 'none' : '';
      shadow.getElementById('collapse').innerHTML = collapsed ? '&#43;' : '&#8722;';
    });

    // drag: grab the panel anywhere except its buttons
    const panel = shadow.querySelector('.panel');
    let sx, sy, ox, oy, dragging = false, moved = false;
    panel.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return; // let buttons receive their clicks
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = host.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.setPointerCapture(e.pointerId);
    });
    panel.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 3) return; // ignore micro-jitter on clicks
      moved = true;
      host.style.left = `${ox + dx}px`;
      host.style.top = `${oy + dy}px`;
      host.style.right = 'auto'; host.style.bottom = 'auto';
    });
    panel.addEventListener('pointerup', e => {
      dragging = false;
      if (panel.hasPointerCapture(e.pointerId)) panel.releasePointerCapture(e.pointerId);
    });
  }

  function fmtCell(cell) {
    if (cell.min === cell.max) return `${cell.min}`;
    const pct = Math.round(cell.probMore * 100);
    return `${cell.min}<span class="prob">+${pct}%</span>`;
  }

  // usernames come from the page — escape them before injecting into our DOM
  const escapeHtml = s => String(s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function render() {
    renderQueued = false;
    if (!shadow) return;
    const body = shadow.getElementById('body');
    const s = tracker.summary();
    const players = [...tracker.players];
    if (!players.length) return;

    const RES_HEADERS = { wood: 'Wood', brick: 'Brick', sheep: 'Sheep', wheat: 'Wheat', ore: 'Ore' };
    const rows = players.map(p => {
      const t = s[p].__total;
      const tot = t.min === t.max ? `${t.min}` : `${t.min}–${t.max}`;
      const label = escapeHtml(p === selfName ? `${p} (you)` : p);
      return `<tr><td title="${escapeHtml(p)}">${label}</td>${CONFIG.RESOURCES.map(r => `<td>${fmtCell(s[p][r])}</td>`).join('')}<td class="tot">${tot}</td><td>${s[p].__unknown || 0}</td><td>${tracker.devBought[p] || 0}</td></tr>`;
    }).join('');

    const hypNote = tracker.hyps.length > 1 ? `${tracker.hyps.length} branches` : 'exact';
    const warnNote = (tracker.warnings || unknownCount)
      ? `<span class="warn">${tracker.warnings} corrections / ${unknownCount} unparsed</span>` : 'ok';

    body.innerHTML = `
      <table>
        <thead><tr><th>Player</th>${CONFIG.RESOURCES.map(r => `<th>${RES_HEADERS[r]}</th>`).join('')}<th>Total</th><th>Unknown</th><th>Dev</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="foot"><span>${hypNote}</span>${warnNote}</div>`;

    detectSelf(); // self-guarded: no-op once detected unless new players appear
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(render, CONFIG.UI_THROTTLE_MS);
  }

  // -------------------------------------------------------------------- boot
  function boot() {
    buildUI();
    scanExisting();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleRender();
    // debug handle: inspect state from DevTools via __colonistCounter
    window.__colonistCounter = { tracker, eventsByIndex, ingestMessage, rebuild, detectSelf, CONFIG };
    log('loaded — watching for game log messages');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
