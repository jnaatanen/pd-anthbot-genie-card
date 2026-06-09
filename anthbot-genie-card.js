/**
 * Anthbot Genie · Home Assistant Lovelace card
 *
 * Map-led card for the Anthbot Genie robot mower, backed by the
 * `anthbot_genie` integration. Single file, no build step.
 *
 *   Drop into /config/www/anthbot-genie-card.js, then add as a Resource:
 *     /local/anthbot-genie-card.js  (type: JavaScript Module)
 *
 * Visual reference: direction-c-map.html · Contract: SPEC.md
 *
 * Architecture (unchanged from the design skeleton):
 *   custom element + `set hass(...)` reactivity + one-time coordinate
 *   projection (§4) + a single service-routing funnel.
 *
 * Notes on deviations from SPEC's literal entity ids — grounded in the real
 * integration, flagged in the README:
 *   - Sibling entities are resolved by the configured mower's `serial_number`
 *     attribute (the integration names entities after the device alias, and a
 *     single HA instance may have several mowers). Falls back to SPEC's
 *     `*.anthbot_genie_*` ids so the §11 mocked-data acceptance tests pass.
 *   - Zone buttons are discovered by attribute signature, not a name prefix.
 *   - Per-zone area is computed from the polygon (the integration exposes no
 *     `area` attribute).
 */

const CARD_VERSION = '0.7.1';

// SPEC literal-id fallbacks (used when serial-scoped resolution finds nothing,
// e.g. the §11 acceptance tests that mock `sensor.anthbot_genie_*`).
const FALLBACK = {
  lawn_mower: 'lawn_mower.anthbot_genie',
  battery_level: 'sensor.anthbot_genie_battery_level',
  charging: 'binary_sensor.anthbot_genie_charging',
  connection: 'binary_sensor.anthbot_genie_connection',
  mower_status: 'sensor.anthbot_genie_mower_status',
  mowing_time: 'sensor.anthbot_genie_mowing_time',
  mowing_area: 'sensor.anthbot_genie_mowing_area',
  map_area: 'sensor.anthbot_genie_map_area',
  mowing_area_total: 'sensor.anthbot_genie_mowing_area_total',
  cutting_height: 'sensor.anthbot_genie_cutting_height',
  rtk_state: 'sensor.anthbot_genie_rtk_state',
  error_code: 'sensor.anthbot_genie_error_code',
  zones: 'sensor.anthbot_genie_zones',
  position: 'sensor.anthbot_genie_position',
  coverage_trail: 'sensor.anthbot_genie_coverage_trail',
  yard_map: 'sensor.anthbot_genie_yard_map',
};

// Domain per logical key, for fallback/zone discovery.
const KEY_DOMAIN = {
  battery_level: 'sensor', mower_status: 'sensor', mowing_time: 'sensor',
  mowing_area: 'sensor', map_area: 'sensor', mowing_area_total: 'sensor',
  cutting_height: 'sensor', rtk_state: 'sensor', error_code: 'sensor',
  zones: 'sensor', position: 'sensor', coverage_trail: 'sensor', yard_map: 'sensor',
  charging: 'binary_sensor', connection: 'binary_sensor',
};

// entity_id name-slug per key (the integration's `has_entity_name` slug), used
// to identify a metric when `hass.entities[*].translation_key` is unavailable.
const KEY_SLUG = {
  battery_level: 'battery_level', mower_status: 'mower_status',
  mowing_time: 'mowing_time_session', mowing_area: 'mowing_area_session',
  map_area: 'map_area', mowing_area_total: 'mowing_area_total',
  cutting_height: 'cutting_height', rtk_state: 'rtk_state',
  error_code: 'error_code', zones: 'zones', coverage_trail: 'coverage_trail', yard_map: 'yard_map',
  charging: 'charging', connection: 'connection',
};

const ZONE_BUTTON_PREFIX = 'button.anthbot_genie_zone_';

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers — no DOM, no hass. Easy to unit-test.
// ────────────────────────────────────────────────────────────────────────────

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isUnavailable(stateObj) {
  return !stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown';
}

/** Shoelace polygon area in source units²; caller scales to m². */
function polygonAreaUnits(vertices) {
  let a = 0;
  for (let i = 0, n = vertices.length; i < n; i++) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Average of projected vertices — good enough label anchor for convex-ish zones. */
function centroid(vertices) {
  let sx = 0, sy = 0;
  for (const [x, y] of vertices) { sx += x; sy += y; }
  return [sx / vertices.length, sy / vertices.length];
}

/** "8.2k" for >=1000, else integer. */
function formatAreaShort(m2) {
  if (m2 == null) return null;
  if (m2 >= 1000) return `${(m2 / 1000).toFixed(1)}k`;
  return `${Math.round(m2)}`;
}

/** seconds → whole minutes. */
function secondsToMinutes(sec) {
  const n = asNum(sec);
  return n == null ? null : Math.round(n / 60);
}

/** minutes → "1h 14m" / "14m". */
function formatMinutes(min) {
  if (min == null || !Number.isFinite(min) || min < 0) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** epoch-ms → "14:32" in the browser's locale/zone. */
function formatClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * RTK fix label. The integration passes through `rtk.state`, whose firmware
 * encoding isn't documented (string or NMEA-style fix-quality int). Map both.
 */
function rtkLabel(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const numeric = {
    '0': 'None', '1': 'Single', '2': 'DGPS', '4': 'Fixed', '5': 'Float',
  };
  if (Object.prototype.hasOwnProperty.call(numeric, s)) return numeric[s];
  const t = s.toLowerCase();
  if (t.includes('fix')) return 'Fixed';
  if (t.includes('float')) return 'Float';
  if (t.includes('single')) return 'Single';
  if (t === 'none' || t === 'no' || t === 'invalid') return 'None';
  return s; // unknown encoding → surface verbatim
}

/** CSS var for the RTK pill colour per §3. */
function rtkColorVar(label) {
  if (label === 'Fixed') return 'var(--ag-accent)';
  if (label === 'Float' || label === 'Single' || label === 'DGPS') return 'var(--ag-warn)';
  if (label === 'None') return 'var(--ag-danger)';
  return 'var(--ag-muted)';
}

/**
 * Read every zone button into a normalized shape. Discovery is layered so the
 * card works against the real integration AND the SPEC-shaped §11 mocks:
 *   1. serial-scoped attribute signature (real integration)
 *   2. `zone_button_pattern` prefix (SPEC / mocks)
 *   3. any button.* carrying a vertex array
 */
function readZoneEntities(hass, { serial = null, prefix = ZONE_BUTTON_PREFIX } = {}) {
  const out = [];
  for (const entityId of Object.keys(hass.states)) {
    if (!entityId.startsWith('button.')) continue;
    const s = hass.states[entityId];
    const a = (s && s.attributes) || {};
    const verts = a.vertexs || a.vertices || a.points;
    const hasVerts = Array.isArray(verts) && verts.length >= 3;

    const matchesSerial = serial != null && a.serial_number === serial && a.zone_type;
    const matchesPrefix = entityId.startsWith(prefix);
    if (!matchesSerial && !matchesPrefix && !(hasVerts && a.zone_type)) continue;
    // If we have a serial to scope to and this button belongs to another mower,
    // skip it (multi-mower installs).
    if (serial != null && a.serial_number != null && a.serial_number !== serial) continue;
    if (!hasVerts) continue;

    const vertices = verts.map((v) => (Array.isArray(v) ? [Number(v[0]), Number(v[1])] : [Number(v.x), Number(v.y)]));
    if (vertices.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) continue;

    out.push({
      entityId,
      id: a.id ?? a.zone_id ?? Number(entityId.split('_').pop()),
      name: a.name || (s.attributes && s.attributes.friendly_name) || `Zone ${out.length + 1}`,
      vertices,
      anchor: [asNum(a.x) ?? 0, asNum(a.y) ?? 0],
    });
  }
  return out.sort((p, q) => (p.id ?? 0) - (q.id ?? 0));
}

/**
 * Compute a one-time transform that fits every zone polygon inside a viewBox.
 * Returns { scale, tx, ty, yFlip } — apply to any (x, y) in the same coord
 * frame (zones, position, dock, coverage trail) and they all line up.
 *
 * NOTE: projection math is part of the design contract (§4) — unchanged.
 */
function computeProjection(zones, viewBox, { invertY = false, pad = 0.08 } = {}) {
  let xMin = +Infinity, xMax = -Infinity, yMin = +Infinity, yMax = -Infinity;
  for (const z of zones) {
    for (const [px, py] of z.vertices) {
      if (px < xMin) xMin = px;
      if (px > xMax) xMax = px;
      if (py < yMin) yMin = py;
      if (py > yMax) yMax = py;
    }
  }
  if (!isFinite(xMin)) return null; // no zones
  const bw = (xMax - xMin) || 1;
  const bh = (yMax - yMin) || 1;
  const padW = bw * pad, padH = bh * pad;
  xMin -= padW; xMax += padW; yMin -= padH; yMax += padH;
  const sx = viewBox.w / (xMax - xMin);
  const sy = viewBox.h / (yMax - yMin);
  const scale = Math.min(sx, sy);
  const yFlip = invertY ? 1 : -1;
  const tx = -xMin * scale + (viewBox.w - (xMax - xMin) * scale) / 2;
  const ty = (yFlip === -1)
    ? yMax * scale + (viewBox.h - (yMax - yMin) * scale) / 2
    : -yMin * scale + (viewBox.h - (yMax - yMin) * scale) / 2;
  return { scale, tx, ty, yFlip };
}

function project(p, proj) {
  return [p[0] * proj.scale + proj.tx, p[1] * proj.scale * proj.yFlip + proj.ty];
}

function polygonD(zone, proj) {
  if (!proj) return '';
  return zone.vertices
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${project(p, proj).map((n) => n.toFixed(1)).join(' ')}`)
    .join(' ') + ' Z';
}

// ────────────────────────────────────────────────────────────────────────────
// Inline icons (stroked, currentColor) — kept tiny so the card stays one file.
// ────────────────────────────────────────────────────────────────────────────
const ICON = {
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  dock: '<path d="M12 3l9 9-9 9-9-9 9-9z"/><circle cx="12" cy="12" r="2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  crosshair: '<circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M1 12h6M17 12h6"/>',
  battery: '<rect x="2" y="8" width="18" height="8" rx="1"/><rect x="20" y="10" width="2" height="4"/>',
  rain: '<path d="M12 3.5s5.5 6 5.5 10a5.5 5.5 0 0 1-11 0c0-4 5.5-10 5.5-10z"/>',
};
function icon(name, extra = '') {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ${extra}>${ICON[name] || ''}</svg>`;
}

// ────────────────────────────────────────────────────────────────────────────
// The custom element.
// ────────────────────────────────────────────────────────────────────────────

class AnthbotGenieCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._proj = null;            // cached coordinate projection
    this._zoneSignature = null;   // recompute proj when zones change
    this._renderSignature = null; // skip re-render (and animation thrash) when nothing changed
    this._hist = null;            // { token, samples:[{t,batt,area}] } for estimates
    this._root = null;            // persistent content container (scaffold built once)
    this._refreshTimer = null;    // optional card-driven refresh (refresh_interval)
    this._connected = false;
    this.attachShadow({ mode: 'open' });
  }

  setConfig(config) {
    if (!config.entity) throw new Error('anthbot-genie-card: `entity` is required');
    this._config = {
      variant: 'expanded',     // 'compact' | 'expanded'
      show_dock: true,
      invert_y: false,
      preferred_services: 'lawn_mower',
      zone_button_pattern: ZONE_BUTTON_PREFIX,
      meters_per_unit: 0.001,  // zone vertices are local mm → m for area (§ computed area)
      entities: {},            // optional explicit id overrides, keyed by logical name
      error_labels: {},        // optional error_code → human label map
      refresh_interval: 0,     // seconds; >0 drives homeassistant.update_entity for fresher data
      show_position: true,     // draw the live mower dot (sensor.<mower>_position)
      show_trail: true,        // draw the coverage breadcrumb (sensor.<mower>_coverage_trail)
      rain_entity: null,       // binary_sensor that means "rain is blocking" → animated rain overlay
      show_yard_map: true,     // draw the real yard shape from sensor.<mower>_yard_map (boundary/points)
      ...config,
    };
    this._proj = null;
    this._zoneSignature = null;
    this._renderSignature = null;
    this._render();
    if (this._connected) this._startRefresh();
  }

  connectedCallback() { this._connected = true; this._startRefresh(); }
  disconnectedCallback() { this._connected = false; this._stopRefresh(); }

  // Optional card-driven refresh: ask HA to pull fresh data more often than the
  // integration's own poll. Same cloud cost as lowering its scan_interval.
  _startRefresh() {
    this._stopRefresh();
    const s = Number(this._config && this._config.refresh_interval);
    if (!s || !isFinite(s) || s <= 0) return;
    const ms = Math.max(5, s) * 1000;
    this._refreshTimer = setInterval(() => {
      if (this._hass && this._config) {
        this._hass.callService('homeassistant', 'update_entity', { entity_id: this._config.entity });
      }
    }, ms);
  }

  _stopRefresh() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() { return this._config && this._config.variant === 'compact' ? 4 : 7; }

  static getStubConfig() {
    return { entity: 'lawn_mower.anthbot_genie', variant: 'expanded' };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Entity resolution — map the configured mower to its sibling entities by
  // serial_number, with translation_key / slug / literal-id fallbacks.
  // ────────────────────────────────────────────────────────────────────────
  _mowerSerial() {
    const m = this._hass.states[this._config.entity];
    return (m && m.attributes && m.attributes.serial_number) || null;
  }

  _resolve(key) {
    const ov = this._config.entities && this._config.entities[key];
    if (ov) return ov;

    const hass = this._hass;
    const serial = this._mowerSerial();
    const domain = KEY_DOMAIN[key] || 'sensor';
    const slug = KEY_SLUG[key];

    if (serial) {
      for (const eid of Object.keys(hass.states)) {
        if (!eid.startsWith(domain + '.')) continue;
        const st = hass.states[eid];
        const a = (st && st.attributes) || {};
        if (a.serial_number !== serial) continue;
        const tk = hass.entities && hass.entities[eid] && hass.entities[eid].translation_key;
        if (tk === key) return eid;
        if (slug && eid.endsWith('_' + slug)) return eid;
      }
    }
    return FALLBACK[key] || null;
  }

  _state(key) { return this._hass.states[this._resolve(key)]; }
  _stateStr(key) { const s = this._state(key); return s ? s.state : undefined; }
  _stateNum(key) { const s = this._state(key); return s ? asNum(s.state) : null; }

  // Signature fragment for the live position so the dot re-renders whenever the
  // mower moves — even if no other tracked field changed in that poll.
  _positionSig() {
    const p = this._state('position');
    if (!p) return null;
    const a = p.attributes || {};
    return `${a.x},${a.y},${a.heading},${a.rtk_accuracy_cm},${p.last_updated}`;
  }

  // Signature fragment for the coverage trail so it re-renders as it grows.
  _trailSig() {
    const e = this._state('coverage_trail');
    if (!e) return null;
    const pts = e.attributes && e.attributes.points;
    return `${Array.isArray(pts) ? pts.length : 0}:${e.last_updated}`;
  }

  // Signature fragment for the accumulated yard map (boundary/points).
  _yardMapSig() {
    const e = this._state('yard_map');
    if (!e) return null;
    const a = e.attributes || {};
    const b = Array.isArray(a.boundary) ? a.boundary.length : 0;
    const p = Array.isArray(a.points) ? a.points.length : 0;
    return `${b}/${p}:${e.last_updated}`;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Derived data.
  // ────────────────────────────────────────────────────────────────────────
  _coverage() {
    const m = this._stateNum('mowing_area');
    const t = this._stateNum('map_area');
    if (t == null || t <= 0 || m == null) return null;
    return { covered: m, total: t, pct: Math.max(0, Math.min(100, Math.floor((m / t) * 100))) };
  }

  _activeZoneIds() {
    const z = this._state('zones');
    const a = z && z.attributes && z.attributes.active_zone_ids;
    return Array.isArray(a) ? new Set(a.map(Number)) : new Set();
  }

  _stance() {
    const mower = this._hass.states[this._config.entity];
    const charging = this._stateStr('charging') === 'on';
    const state = (mower && mower.state) || 'unknown';
    const lawn = this._config.preferred_services === 'lawn_mower';
    switch (state) {
      case 'mowing':
        return { key: 'mowing', label: 'Mowing', dot: 'accent', icon: 'pause',
                 primary: { label: 'Pause mowing', domain: 'lawn_mower', service: 'pause' } };
      case 'paused':
        return { key: 'paused', label: 'Paused', dot: 'muted', icon: 'play',
                 primary: { label: 'Resume', domain: 'lawn_mower', service: 'start_mowing' } };
      case 'returning':
        return { key: 'returning', label: 'Returning to dock', dot: 'blue', icon: 'stop',
                 primary: { label: 'Stop', domain: 'anthbot_genie', service: 'stop_mow' } };
      case 'error':
        return { key: 'error', label: 'Error', dot: 'danger', icon: 'check',
                 primary: { label: 'Acknowledge', domain: 'anthbot_genie', service: 'stop_mow' } };
      case 'docked':
      default:
        return {
          key: charging ? 'charging' : 'docked',
          label: charging ? 'Charging' : 'Docked',
          dot: charging ? 'warn' : 'muted',
          icon: 'play',
          primary: lawn
            ? { label: 'Mow', domain: 'lawn_mower', service: 'start_mowing' }
            : { label: 'Mow', domain: 'anthbot_genie', service: 'start_full_mow' },
        };
    }
  }

  // Rain delay: the configured rain_entity is `on` and the mower isn't mowing
  // (i.e. rain is keeping it parked). The integration has no clean "raining now"
  // signal, so the trigger entity is user-configured.
  _isRaining(stance) {
    const id = this._config.rain_entity;
    if (!id) return false;
    const e = this._hass.states[id];
    if (!e || e.state !== 'on') return false;
    return stance.key !== 'mowing';
  }

  _errorText() {
    const raw = this._stateStr('error_code');
    if (raw == null || raw === '' || raw === '0' || raw === 'unknown') return null;
    const label = this._config.error_labels && this._config.error_labels[raw];
    return label || `Error code ${raw}`;
  }

  /** Active zone name(s) for badges / position line. */
  _activeZoneName(zones, active) {
    const hit = zones.find((z) => active.has(Number(z.id)));
    return hit ? hit.name : null;
  }

  // Estimate remaining minutes from battery burn (preferred) or area rate (§6).
  _estimateRemaining(stance) {
    const mower = this._hass.states[this._config.entity];
    const token = `${stance.key}|${mower ? mower.last_changed : ''}`;
    const batt = this._stateNum('battery_level');
    const cov = this._coverage();
    const now = Date.now();

    if (!this._hist || this._hist.token !== token) {
      this._hist = { token, samples: [] };
    }
    const samples = this._hist.samples;
    const last = samples[samples.length - 1];
    if (!last || last.batt !== batt || (cov && last.area !== cov.covered)) {
      samples.push({ t: now, batt, area: cov ? cov.covered : null });
      // keep a ~10 min sliding window
      while (samples.length > 2 && now - samples[0].t > 600000) samples.shift();
    }
    if (samples.length < 2) return null;
    const first = samples[0], lastS = samples[samples.length - 1];
    const dtMin = (lastS.t - first.t) / 60000;
    if (dtMin < 1) return null; // need >=60s of history (§6.2)

    if (stance.key === 'charging') {
      if (first.batt != null && lastS.batt != null && lastS.batt > first.batt) {
        const rate = (lastS.batt - first.batt) / dtMin; // %/min
        if (rate > 0) return (100 - lastS.batt) / rate;
      }
      return null;
    }
    // mowing: battery burn to 0
    if (first.batt != null && lastS.batt != null && lastS.batt < first.batt) {
      const rate = (first.batt - lastS.batt) / dtMin;
      if (rate > 0) return lastS.batt / rate;
    }
    // fallback: area rate to map_area
    if (cov && first.area != null && lastS.area != null && lastS.area > first.area) {
      const rate = (lastS.area - first.area) / dtMin; // m²/min
      if (rate > 0) return (cov.total - lastS.area) / rate;
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Service routing — single funnel.
  // ────────────────────────────────────────────────────────────────────────
  _callService(domain, service, extraData = {}) {
    if (!this._hass) return;
    this._hass.callService(domain, service, { entity_id: this._config.entity, ...extraData });
  }

  _onPrimaryClick() {
    const s = this._stance();
    this._callService(s.primary.domain, s.primary.service);
  }

  _onDockClick() {
    if (this._config.preferred_services === 'lawn_mower') this._callService('lawn_mower', 'dock');
    else this._callService('anthbot_genie', 'return_to_dock');
  }

  _onStopClick() { this._callService('anthbot_genie', 'stop_mow'); }

  // Prefer pressing the zone's own button (encapsulates manual/auto); fall back
  // to the bespoke service (field is `zones`, not `zone_id`).
  _onZoneClick(zone) {
    if (zone && zone.entityId && this._hass.states[zone.entityId]) {
      this._hass.callService('button', 'press', { entity_id: zone.entityId });
    } else if (zone) {
      this._callService('anthbot_genie', 'start_zone_mow', { zones: String(zone.id) });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render.
  // ────────────────────────────────────────────────────────────────────────
  // Build the static <style> and a content container exactly once. Re-renders
  // only replace the container's innerHTML, so this <style> — and any card-mod
  // injected <style> sibling in the shadow root — survive untouched. Replacing
  // the whole shadowRoot each update used to drop all styles for a frame,
  // flashing the background before card-mod re-applied.
  _ensureScaffold() {
    if (this._root && this.shadowRoot.contains(this._root)) return;
    this.shadowRoot.innerHTML = `<style>${this._styleCss()}</style><div class="ag-root"></div>`;
    this._root = this.shadowRoot.querySelector('.ag-root');
  }

  _render() {
    if (!this._config) return;
    this._ensureScaffold();
    if (!this._hass) {
      this._root.innerHTML = this._skeletonHTML();
      this._renderSignature = null;
      return;
    }

    const serial = this._mowerSerial();
    const zones = readZoneEntities(this._hass, { serial, prefix: this._config.zone_button_pattern });
    const cov = this._coverage();
    const active = this._activeZoneIds();
    const stance = this._stance();
    const online = this._stateStr('connection') !== 'off';

    // Cache projection when the set/shape of zones changes.
    const zsig = zones.map((z) => `${z.id}:${z.vertices.length}`).join('|');
    if (zsig !== this._zoneSignature) {
      const vb = this._config.variant === 'compact' ? { w: 380, h: 180 } : { w: 480, h: 280 };
      this._proj = computeProjection(zones, vb, { invertY: this._config.invert_y });
      this._zoneSignature = zsig;
      if (this._proj) {
        // §4.2 dev aid: log the bbox once so the user can sanity-check invert_y.
        // eslint-disable-next-line no-console
        console.debug('[anthbot-genie-card] zone projection', this._proj);
      }
    }

    const est = this._estimateRemaining(stance);

    // Skip re-render when nothing visible changed — preserves CSS animations.
    const mower = this._hass.states[this._config.entity];
    const sig = JSON.stringify({
      v: this._config.variant, online, st: stance.key, zsig,
      active: [...active], cov, batt: this._stateNum('battery_level'),
      rtk: this._stateStr('rtk_state'), err: this._errorText(),
      mt: this._stateStr('mowing_time'), ch: this._stateStr('cutting_height'),
      tot: this._stateStr('map_area'), pos: this._positionSig(), trail: this._trailSig(), ym: this._yardMapSig(),
      lc: mower ? mower.last_changed : null, est: est == null ? null : Math.round(est),
      rain: this._isRaining(stance),
    });
    if (sig === this._renderSignature) return;
    this._renderSignature = sig;

    this._root.innerHTML = this._cardHTML({ zones, cov, active, stance, est, online });

    // Wire interaction.
    const root = this.shadowRoot;
    root.querySelector('[data-act="primary"]')?.addEventListener('click', () => this._onPrimaryClick());
    root.querySelector('[data-act="dock"]')?.addEventListener('click', () => this._onDockClick());
    root.querySelector('[data-act="stop"]')?.addEventListener('click', () => this._onStopClick());
    root.querySelectorAll('[data-zone-id]').forEach((el) => {
      const id = el.dataset.zoneId;
      const zone = zones.find((z) => String(z.id) === id);
      el.addEventListener('click', () => this._onZoneClick(zone));
    });
  }

  _skeletonHTML() {
    return `<ha-card><div class="loading">Anthbot Genie · loading…</div></ha-card>`;
  }

  _cardHTML({ zones, cov, active, stance, est, online }) {
    const variant = this._config.variant;
    const hasMap = zones.length > 0 && this._proj;
    const body = variant === 'compact'
      ? this._compactBody({ stance, cov, est })
      : this._expandedBody({ zones, cov, active, stance, est });
    const actions = variant === 'compact' ? this._compactActions(stance) : this._expandedActions(stance);
    const strip = variant === 'expanded' ? this._zoneStrip(zones, active) : '';

    return `
      <ha-card class="ag-card ag-${variant} ${online ? '' : 'offline'} state-${stance.key}">
        ${hasMap ? this._mapBlock({ zones, cov, active, stance }) : this._noMapNotice(zones.length === 0)}
        ${body}
        ${strip}
        ${actions}
      </ha-card>
    `;
  }

  _noMapNotice(noZones) {
    if (!noZones) return '';
    return `<div class="no-map">${icon('crosshair')}<span>No zones configured — map hidden</span></div>`;
  }

  // ── MAP ──────────────────────────────────────────────────────────────────
  _mapBlock({ zones, cov, active, stance }) {
    const variant = this._config.variant;
    const raining = this._isRaining(stance);
    const viewBox = variant === 'compact' ? '0 0 380 180' : '0 0 480 280';
    const proj = this._proj;
    const activeName = this._activeZoneName(zones, active);
    const rtk = rtkLabel(this._stateStr('rtk_state'));
    const hasPos = !!this._state('position');

    const polys = zones.map((z, i) => {
      const isActive = active.has(Number(z.id));
      return `<path class="zone-poly z${(i % 4) + 1} ${isActive ? 'active' : ''}" d="${polygonD(z, proj)}" data-zone-id="${z.id}"/>`;
    }).join('');

    const labels = variant === 'expanded'
      ? zones.map((z, i) => {
          const isActive = active.has(Number(z.id));
          const [cx, cy] = project(centroid(z.vertices), proj);
          const areaM2 = polygonAreaUnits(z.vertices) * Math.pow(this._config.meters_per_unit, 2);
          return `
            <text class="zone-label ${isActive ? '' : 'muted'}" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle">${this._esc(z.name)}</text>
            <text class="zone-label-area" x="${cx.toFixed(1)}" y="${(cy + 14).toFixed(1)}" text-anchor="middle">${formatAreaShort(areaM2)} m²</text>`;
        }).join('')
      : '';

    const badgeText = activeName && stance.key === 'mowing' && variant === 'expanded'
      ? `${stance.label} · ${activeName}` : stance.label;

    const posText = hasPos
      ? `RTK ${rtk || '—'} · ${activeName ? `in ${this._esc(activeName)}` : 'positioning'}`
      : `RTK ${rtk || '—'} · live position not exposed`;

    return `
      <div class="map ${variant}">
        <svg viewBox="${viewBox}" preserveAspectRatio="xMidYMid slice">
          ${this._config.show_yard_map ? this._renderYardMap(proj) : ''}
          ${polys}
          ${this._config.show_trail ? this._renderCoverageTrail(proj) : ''}
          ${labels}
          ${this._config.show_position ? this._renderLivePosition(proj, hasPos) : ''}
          ${this._config.show_dock ? this._renderDockMarker(proj) : ''}
        </svg>

        ${raining ? `${this._renderRain()}<div class="rain-badge">${icon('rain')}Rain delay</div>` : ''}

        <div class="overlay-tl">
          <span class="badge ${stance.dot === 'accent' ? '' : 'muted'}"><span class="dot dot-${stance.dot}"></span>${this._esc(badgeText)}</span>
          ${variant === 'expanded' ? `
            <span class="legend">
              <span class="sw sw-active"></span>active
              <span class="sw sw-base"></span>pending
            </span>` : (cov ? `<span class="legend">${cov.pct}%</span>` : '')}
        </div>

        ${cov && variant === 'expanded' ? `<div class="overlay-br"><div class="pct-large">${cov.pct}%<span class="sub">coverage</span></div></div>` : ''}

        <div class="pos-state">${icon('crosshair')}<span>${posText}</span></div>
      </div>
    `;
  }

  // Real yard shape accumulated from the mower's path (sensor.<mower>_yard_map):
  // prefer a concave-hull `boundary` polygon; fall back to coverage `points`.
  // Rendered as the base layer, under the zone rectangles. Same projection.
  _renderYardMap(proj) {
    if (!proj) return '';
    const e = this._state('yard_map');
    if (!e) return '';
    const a = e.attributes || {};
    const boundary = a.boundary;
    if (Array.isArray(boundary) && boundary.length >= 3) {
      const d = boundary.map((p, i) => {
        const x = asNum(Array.isArray(p) ? p[0] : p && p.x);
        const y = asNum(Array.isArray(p) ? p[1] : p && p.y);
        if (x == null || y == null) return '';
        const [vx, vy] = project([x, y], proj);
        return `${i === 0 ? 'M' : 'L'} ${vx.toFixed(1)} ${vy.toFixed(1)}`;
      }).filter(Boolean).join(' ');
      return d ? `<path class="yard-map" d="${d} Z"/>` : '';
    }
    const pts = a.points;
    if (Array.isArray(pts) && pts.length) {
      const dots = pts.slice(0, 4000).map((p) => {
        const x = asNum(Array.isArray(p) ? p[0] : p && p.x);
        const y = asNum(Array.isArray(p) ? p[1] : p && p.y);
        if (x == null || y == null) return '';
        const [vx, vy] = project([x, y], proj);
        return `<circle cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="2.5"/>`;
      }).join('');
      return dots ? `<g class="yard-map-pts">${dots}</g>` : '';
    }
    return '';
  }

  // Coverage breadcrumb: the path the mower has mowed this session
  // (sensor.<mower>_coverage_trail, attribute `points` = [[x,y],...] in zone units).
  _renderCoverageTrail(proj) {
    if (!proj) return '';
    const e = this._state('coverage_trail');
    const pts = e && e.attributes && e.attributes.points;
    if (!Array.isArray(pts) || pts.length < 2) return '';
    const coords = pts.map((p) => {
      const x = asNum(Array.isArray(p) ? p[0] : p && p.x);
      const y = asNum(Array.isArray(p) ? p[1] : p && p.y);
      if (x == null || y == null) return null;
      const [vx, vy] = project([x, y], proj);
      return `${vx.toFixed(1)},${vy.toFixed(1)}`;
    }).filter(Boolean).join(' ');
    if (!coords) return '';
    return `<polyline class="coverage-trail" points="${coords}" />`;
  }

  // Animated rain: dashed diagonal streaks falling top-left → bottom-right,
  // full width. Dashes are stroke-dasharray segments; animating dashoffset makes
  // them fall along each line. Staggered per line for a natural look.
  _renderRain() {
    let lines = '';
    for (let i = 0; i < 22; i++) {
      const x = i * 6 - 16;
      const delay = -(((i * 37) % 60)) / 100;
      lines += `<line x1="${x}" y1="-8" x2="${x + 16}" y2="72" style="animation-delay:${delay}s"/>`;
    }
    return `<div class="rain-overlay"><svg class="rain-fx" viewBox="0 0 100 64" preserveAspectRatio="xMidYMid slice">${lines}</svg></div>`;
  }

  _renderLivePosition(proj, hasPos) {
    if (!hasPos || !proj) return '';
    const pos = this._state('position');
    const x = asNum(pos.attributes.x), y = asNum(pos.attributes.y);
    if (x == null || y == null) return '';
    const [vx, vy] = project([x, y], proj);
    const accuracy = asNum(pos.attributes.rtk_accuracy_cm);
    const heading = asNum(pos.attributes.heading);
    const accuracyR = accuracy != null ? (accuracy / 100) / this._config.meters_per_unit * proj.scale : 0;
    return `
      ${accuracyR > 0 ? `<circle cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="${accuracyR.toFixed(1)}" fill="var(--ag-accent)" fill-opacity="0.12"/>` : ''}
      <circle cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="5" fill="var(--ag-accent)" stroke="var(--ag-surface)" stroke-width="2">
        <animate attributeName="r" values="5;6;5" dur="2s" repeatCount="indefinite"/>
      </circle>
      ${heading != null ? `<g transform="translate(${vx.toFixed(1)} ${vy.toFixed(1)}) rotate(${heading})"><path d="M 0 -10 L 4 -4 L -4 -4 Z" fill="var(--ag-accent)"/></g>` : ''}
    `;
  }

  _renderDockMarker(proj) {
    const mower = this._hass.states[this._config.entity];
    const dx = asNum(mower && mower.attributes && mower.attributes.dock_x);
    const dy = asNum(mower && mower.attributes && mower.attributes.dock_y);
    if (dx == null || dy == null || !proj) return '';
    const [vx, vy] = project([dx, dy], proj);
    return `
      <g class="dock-marker" transform="translate(${vx.toFixed(1)} ${vy.toFixed(1)})">
        <rect x="-7" y="-7" width="14" height="14" rx="2"/>
        <circle cx="0" cy="0" r="3"/>
        <text x="0" y="-12" text-anchor="middle">DOCK</text>
      </g>
    `;
  }

  // ── COMPACT BODY ───────────────────────────────────────────────────────────
  _compactBody({ stance, cov, est }) {
    const battery = this._stateNum('battery_level');
    const mins = secondsToMinutes(this._stateStr('mowing_time'));
    const parts = [];
    if (mins != null) parts.push(`${mins} min in`);
    if (cov) parts.push(`${Math.round(cov.covered)} / ${Math.round(cov.total)} m²`);
    if (est != null) parts.push(`~${formatMinutes(est)} left`);
    const where = parts.join(' · ') || (this._stateStr('mower_status') || '');
    return `
      <div class="body compact-body">
        <div class="status-row">
          <span class="state">${this._esc(stance.label)}</span>
          <span class="battery">${icon('battery')}${battery != null ? `${battery}%` : '—'}</span>
        </div>
        ${where ? `<div class="where">${this._esc(where)}</div>` : ''}
      </div>
    `;
  }

  _compactActions(stance) {
    return `
      <div class="actions compact-actions">
        <button class="primary" data-act="primary">${icon(stance.icon)}${this._esc(stance.primary.label.replace(' mowing', ''))}</button>
        <button data-act="dock">${icon('dock')}Dock</button>
        <button data-act="stop">${icon('stop')}Stop</button>
      </div>
    `;
  }

  // ── EXPANDED BODY ──────────────────────────────────────────────────────────
  _expandedBody({ zones, cov, active, stance, est }) {
    const mower = this._hass.states[this._config.entity];
    const deviceName = (mower && mower.attributes && mower.attributes.friendly_name) || 'Anthbot Genie';
    const battery = this._stateNum('battery_level');
    const mins = secondsToMinutes(this._stateStr('mowing_time'));
    const height = this._stateNum('cutting_height');
    const rtk = rtkLabel(this._stateStr('rtk_state'));
    const lawnSize = this._stateNum('map_area');
    const errorText = this._errorText();

    // where-line
    const where = this._buildWhereLine(mower, mins, stance, est, errorText);

    const estLabel = stance.key === 'charging'
      ? (est != null ? `~${formatMinutes(est)} to full` : '')
      : (est != null ? `~${formatMinutes(est)}` : '');

    return `
      <div class="body expanded-body">
        <div class="top-row">
          <div>
            <div class="device-name">${this._esc(deviceName)}</div>
            <div class="state">${this._esc(errorText && stance.key === 'error' ? `Error · ${errorText}` : stance.label)}</div>
            ${where ? `<div class="where">${this._esc(where)}</div>` : ''}
          </div>
          <div class="battery-large">
            <div class="pct">${battery != null ? `${battery}%` : '—'}</div>
            ${estLabel ? `<div class="est">${this._esc(estLabel)}</div>` : ''}
          </div>
        </div>

        ${cov ? `
          <div class="progress">
            <div class="progress-row"><span class="lbl">Coverage</span><span class="val">${Math.round(cov.covered)} / ${Math.round(cov.total)} m²</span></div>
            <div class="progress-track"><div class="progress-fill" style="width:${cov.pct}%"></div></div>
          </div>` : ''}

        <div class="stats">
          <div><div class="lbl">Time</div><div class="val">${mins != null ? mins : '—'}<span class="unit">min</span></div></div>
          <div><div class="lbl">Height</div><div class="val">${height != null ? height : '—'}<span class="unit">mm</span></div></div>
          <div><div class="lbl">RTK</div><div class="val" style="color:${rtkColorVar(rtk)}">${rtk || '—'}</div></div>
          <div><div class="lbl">Lawn size</div><div class="val">${lawnSize != null ? formatAreaShort(lawnSize) : '—'}<span class="unit">${lawnSize != null && lawnSize >= 1000 ? 'k m²' : 'm²'}</span></div></div>
        </div>
      </div>
    `;
  }

  _buildWhereLine(mower, mins, stance, est, errorText) {
    if (stance.key === 'error') return errorText ? this._stateStr('mower_status') || '' : '';
    if (stance.key === 'docked') return this._stateStr('mower_status') || '';
    const bits = [];
    const started = mower && mower.last_changed ? Date.parse(mower.last_changed) : NaN;
    if (Number.isFinite(started) && (stance.key === 'mowing' || stance.key === 'paused')) {
      bits.push(`started ${formatClock(started)}`);
    }
    if (mins != null) bits.push(`${mins} min in`);
    if (est != null && stance.key === 'mowing') bits.push(`est. ${formatClock(Date.now() + est * 60000)} done`);
    return bits.join(' · ');
  }

  _expandedActions(stance) {
    return `
      <div class="actions expanded-actions">
        <button class="primary" data-act="primary">${icon(stance.icon)}${this._esc(stance.primary.label)}</button>
        <button data-act="dock">${icon('dock')}Dock</button>
        <button data-act="stop">${icon('stop')}Stop</button>
      </div>
    `;
  }

  _zoneStrip(zones, active) {
    if (!zones.length) return '';
    const chips = zones.map((z, i) => {
      const isActive = active.has(Number(z.id));
      const areaM2 = polygonAreaUnits(z.vertices) * Math.pow(this._config.meters_per_unit, 2);
      return `
        <span class="zone ${isActive ? 'active' : ''}" data-zone-id="${z.id}">
          <span class="swatch sw-z${(i % 4) + 1}"></span>${this._esc(z.name)}<span class="area">${formatAreaShort(areaM2)}</span>
        </span>`;
    }).join('');
    return `<div class="zone-strip">${chips}</div>`;
  }

  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── STYLE ──────────────────────────────────────────────────────────────────
  // Ported from direction-c-map.html with design tokens swapped for HA CSS
  // variables (§7). The mock's tokens become `--ag-*` fallbacks so the card
  // still looks right if a theme omits a variable. color-mix uses `in srgb`
  // for predictable mixing against arbitrary theme colours.
  _styleCss() {
    return `
        :host {
          display: block;
          --ag-surface: var(--ha-card-background, var(--card-background-color, #fff));
          --ag-fg: var(--primary-text-color, #1c1b1a);
          --ag-muted: var(--secondary-text-color, #5b6168);
          --ag-faint: var(--disabled-text-color, #8a9099);
          --ag-border: var(--divider-color, #e3e6ea);
          --ag-border-strong: color-mix(in srgb, var(--divider-color, #e3e6ea) 70%, var(--secondary-text-color, #5b6168));
          --ag-accent: var(--state-lawn-mower-mowing-color, var(--state-active-color, var(--primary-color, #16a34a)));
          --ag-accent-deep: color-mix(in srgb, var(--ag-accent) 72%, #000);
          --ag-accent-soft: color-mix(in srgb, var(--ag-accent) 18%, transparent);
          --ag-warn: var(--warning-color, #e0a106);
          --ag-danger: var(--error-color, #d32f2f);
          --ag-blue: var(--info-color, #2f7fd3);
          /* Map palette — explicitly green, independent of the theme accent so
             the yard reads as grass. Light background → medium zone greens →
             darkest green for the active zone. All overridable via card-mod. */
          --ag-map-bg: oklch(97% 0.02 150);
          --ag-zone-stroke: oklch(60% 0.08 150);
          --ag-z1: oklch(88% 0.075 140);
          --ag-z2: oklch(85% 0.075 162);
          --ag-z3: oklch(86% 0.07 126);
          --ag-z4: oklch(83% 0.08 176);
          --ag-zone-active-fill: oklch(73% 0.13 150);
          --ag-zone-active-stroke: oklch(45% 0.13 150);
          --ag-zone-label-active: oklch(32% 0.09 150);
          --ag-trail: oklch(40% 0.12 150);
          --ag-map-fill: oklch(84% 0.085 152);
          --ag-mono: var(--ha-font-family-code, ui-monospace, 'SF Mono', Menlo, monospace);
          --ag-body: var(--ha-font-family-body, var(--mdc-typography-font-family, system-ui, sans-serif));
        }
        ha-card.ag-card { overflow: hidden; color: var(--ag-fg); font-family: var(--ag-body); }
        ha-card.ag-card.offline { opacity: 0.55; filter: grayscale(0.4); }
        .ag-card * { box-sizing: border-box; }
        .loading { padding: 24px; color: var(--ag-muted); }
        .no-map { display:flex; align-items:center; gap:8px; padding:16px 20px; color: var(--ag-faint); font: 400 12px var(--ag-mono); }
        .no-map svg { width:14px; height:14px; }

        /* MAP */
        .map { position: relative; background: var(--ag-map-bg); overflow: hidden; }
        .map.compact { height: 180px; }
        .map.expanded { height: 280px; }
        .map svg { width: 100%; height: 100%; display: block; }

        .zone-poly { stroke: var(--ag-zone-stroke); stroke-width: 1; vector-effect: non-scaling-stroke; cursor: pointer; }
        .zone-poly.z1 { fill: var(--ag-z1); } .zone-poly.z2 { fill: var(--ag-z2); }
        .zone-poly.z3 { fill: var(--ag-z3); } .zone-poly.z4 { fill: var(--ag-z4); }
        .zone-poly.active { fill: var(--ag-zone-active-fill); stroke: var(--ag-zone-active-stroke); stroke-width: 1.5; stroke-dasharray: 6 4; animation: dashpulse 4s linear infinite; }
        @keyframes dashpulse { to { stroke-dashoffset: -40; } }
        .coverage-trail { fill: none; stroke: var(--ag-trail); stroke-width: 2; opacity: 0.6; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; pointer-events: none; }
        .yard-map { fill: var(--ag-map-fill); stroke: var(--ag-zone-stroke); stroke-width: 1; vector-effect: non-scaling-stroke; opacity: 0.95; }
        .yard-map-pts circle { fill: var(--ag-map-fill); }
        .rain-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
        .rain-fx { width: 100%; height: 100%; display: block; }
        .rain-fx line { stroke: var(--ag-rain, rgba(255,255,255,0.55)); stroke-width: 1.3; stroke-dasharray: 3 7; vector-effect: non-scaling-stroke; animation: ag-rain 0.6s linear infinite; }
        @keyframes ag-rain { to { stroke-dashoffset: -40; } }
        .rain-badge { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.92); color: #14241d; padding: 7px 12px; border-radius: 999px; font: 600 12px/1 var(--ag-body); box-shadow: 0 2px 8px rgba(0,0,0,0.18); z-index: 2; }
        .rain-badge svg { width: 14px; height: 14px; color: var(--ag-blue); }

        .zone-label { font: 500 10px/1 var(--ag-mono); letter-spacing: 0.08em; text-transform: uppercase; fill: var(--ag-zone-label-active); pointer-events: none; }
        .zone-label.muted { fill: var(--ag-muted); }
        .zone-label-area { font: 400 9px/1 var(--ag-mono); fill: var(--ag-faint); pointer-events: none; }

        .dock-marker rect { fill: var(--ag-border); stroke: var(--ag-muted); stroke-width: 1; }
        .dock-marker circle { fill: var(--ag-accent-deep); }
        .dock-marker text { font: 500 8px var(--ag-mono); fill: var(--ag-muted); letter-spacing: 0.1em; }

        .overlay-tl { position: absolute; top: 14px; left: 16px; right: 16px; display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
        .badge { display: inline-flex; align-items: center; gap: 6px; background: color-mix(in srgb, var(--ag-surface) 92%, transparent); backdrop-filter: blur(8px); padding: 6px 10px; border-radius: 999px; font: 500 11px/1 var(--ag-body); color: var(--ag-fg); box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
        .badge.muted { color: var(--ag-muted); }
        .dot { width: 6px; height: 6px; border-radius: 50%; }
        .dot-accent { background: var(--ag-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ag-accent) 20%, transparent); animation: pulse 2s ease-in-out infinite; }
        .dot-muted { background: var(--ag-muted); } .dot-warn { background: var(--ag-warn); }
        .dot-blue { background: var(--ag-blue); } .dot-danger { background: var(--ag-danger); }
        .legend { display: inline-flex; align-items: center; gap: 6px; background: color-mix(in srgb, var(--ag-surface) 92%, transparent); backdrop-filter: blur(8px); padding: 6px 10px; border-radius: 999px; font: 500 11px/1 var(--ag-mono); color: var(--ag-muted); box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
        .sw { display: inline-block; width: 10px; height: 8px; border-radius: 1px; }
        .sw-active { background: var(--ag-zone-active-fill); border: 1px solid var(--ag-zone-active-stroke); }
        .sw-base { background: var(--ag-z1); }
        .overlay-br { position: absolute; bottom: 14px; right: 16px; }
        .pct-large { background: color-mix(in srgb, var(--ag-surface) 92%, transparent); backdrop-filter: blur(8px); padding: 8px 12px; border-radius: 10px; font: 600 20px/1 var(--ag-body); letter-spacing: -0.02em; box-shadow: 0 1px 3px rgba(0,0,0,0.12); font-variant-numeric: tabular-nums; }
        .pct-large .sub { display: block; font: 500 10px/1 var(--ag-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ag-faint); margin-top: 4px; }
        .pos-state { position: absolute; bottom: 14px; left: 16px; display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; background: color-mix(in srgb, var(--ag-surface) 85%, transparent); backdrop-filter: blur(8px); border-radius: 6px; font: 400 10px/1 var(--ag-mono); color: var(--ag-faint); letter-spacing: 0.04em; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
        .pos-state svg { width: 10px; height: 10px; color: var(--ag-faint); }

        /* COMPACT BODY */
        .compact-body { padding: 14px 18px; }
        .status-row { display: flex; justify-content: space-between; align-items: center; }
        .status-row .state { font: 600 17px/1 var(--ag-body); letter-spacing: -0.02em; }
        .status-row .battery { display: flex; align-items: center; gap: 6px; font: 500 13px var(--ag-mono); color: var(--ag-muted); font-variant-numeric: tabular-nums; }
        .status-row .battery svg { width: 18px; height: 18px; color: var(--ag-accent); }
        .compact-body .where { font: 400 12px var(--ag-body); color: var(--ag-muted); margin-top: 4px; }

        /* EXPANDED BODY */
        .expanded-body { padding: 20px 24px 14px; }
        .top-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
        .device-name { font: 500 10px/1 var(--ag-mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--ag-faint); }
        .expanded-body .state { font: 600 26px/1.1 var(--ag-body); letter-spacing: -0.02em; margin-top: 8px; }
        .expanded-body .where { font: 400 13px/1.5 var(--ag-body); color: var(--ag-muted); margin-top: 6px; }
        .battery-large { text-align: right; flex-shrink: 0; }
        .battery-large .pct { font: 600 28px/1 var(--ag-body); letter-spacing: -0.02em; color: var(--ag-accent); font-variant-numeric: tabular-nums; }
        .battery-large .est { font: 500 11px/1 var(--ag-mono); color: var(--ag-muted); margin-top: 6px; }

        .progress { margin-top: 18px; }
        .progress-row { display: flex; justify-content: space-between; align-items: baseline; }
        .progress-row .lbl { font: 500 11px/1 var(--ag-mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ag-faint); }
        .progress-row .val { font: 500 12px var(--ag-mono); color: var(--ag-muted); font-variant-numeric: tabular-nums; }
        .progress-track { margin-top: 10px; height: 8px; background: var(--ag-border); border-radius: 999px; overflow: hidden; }
        .progress-fill { height: 100%; background: var(--ag-accent); border-radius: 999px; }

        .stats { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--ag-border); gap: 8px; }
        .stats > div + div { border-left: 1px solid var(--ag-border); padding-left: 12px; }
        .stats .lbl { font: 500 10px/1 var(--ag-mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ag-faint); }
        .stats .val { font: 600 16px/1.1 var(--ag-body); letter-spacing: -0.01em; margin-top: 6px; font-variant-numeric: tabular-nums; }
        .stats .val .unit { font: 400 10px var(--ag-mono); color: var(--ag-muted); margin-left: 3px; }

        /* ZONE STRIP */
        .zone-strip { display: flex; gap: 6px; padding: 0 24px 20px; overflow-x: auto; }
        .zone-strip .zone { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--ag-border); border-radius: 999px; font: 500 11px/1 var(--ag-body); color: var(--ag-muted); background: var(--ag-surface); cursor: pointer; white-space: nowrap; }
        .zone-strip .zone:hover { border-color: var(--ag-muted); color: var(--ag-fg); }
        .zone-strip .zone.active { background: var(--ag-accent-soft); border-color: var(--ag-accent); color: var(--ag-accent-deep); }
        .zone-strip .swatch { width: 8px; height: 8px; border-radius: 2px; }
        .sw-z1 { background: var(--ag-z1); } .sw-z2 { background: var(--ag-z2); } .sw-z3 { background: var(--ag-z3); } .sw-z4 { background: var(--ag-z4); }
        .zone-strip .area { color: var(--ag-faint); font: 500 11px var(--ag-mono); margin-left: 2px; font-variant-numeric: tabular-nums; }
        .zone-strip .zone.active .area { color: var(--ag-accent-deep); }

        /* ACTIONS */
        .actions button { border: 1px solid var(--ag-border-strong); background: var(--ag-surface); border-radius: 10px; cursor: pointer; font: 500 13px var(--ag-body); color: var(--ag-fg); display: flex; align-items: center; justify-content: center; gap: 6px; transition: background 0.15s, border-color 0.15s; }
        .actions button:hover { background: color-mix(in srgb, var(--ag-fg) 5%, var(--ag-surface)); border-color: var(--ag-muted); }
        .actions button.primary { background: var(--ag-accent); color: var(--text-primary-color, #fff); border-color: var(--ag-accent); font-weight: 600; }
        .actions button.primary:hover { background: var(--ag-accent-deep); }
        .actions svg { width: 14px; height: 14px; }
        .compact-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; padding: 12px 18px 16px; }
        .compact-actions button { height: 36px; border-radius: 8px; font-size: 12px; }
        .compact-actions svg { width: 12px; height: 12px; }
        .expanded-actions { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; padding: 18px 24px 22px; }
        .expanded-actions button { height: 42px; }

        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ag-accent) 20%, transparent); }
          50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--ag-accent) 5%, transparent); }
        }
        @media (prefers-reduced-motion: reduce) {
          .zone-poly.active, .dot-accent, .pos-state, .rain-fx line, circle animate { animation: none !important; }
        }
    `;
  }
}

customElements.define('anthbot-genie-card', AnthbotGenieCard);

// Register with HA's card picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'anthbot-genie-card',
  name: 'Anthbot Genie',
  description: 'Map-led card for the Anthbot Genie robot mower (v' + CARD_VERSION + ')',
  preview: false,
  documentationURL: 'https://github.com/jnaatanen/pd-anthbot-genie-card',
});

console.info(
  `%c ANTHBOT-GENIE-CARD %c v${CARD_VERSION} `,
  'color:#fff;background:#16a34a;padding:2px 6px;border-radius:3px 0 0 3px',
  'color:#16a34a;background:#dcfce7;padding:2px 6px;border-radius:0 3px 3px 0'
);
