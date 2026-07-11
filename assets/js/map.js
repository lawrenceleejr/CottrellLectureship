/* =========================================================================
   Scholars & Institutions map.

   Draws every US + Canada college/university as a quiet grey dot, and every
   institution with a Cottrell Scholar as a terracotta dot. Two independently
   toggleable, clustered layers; click a dot for details.

   On top of that, a filter toolbar (built here, above the map):
     • a live text search over institution, city, state, and scholar names;
     • a radius filter around a point you set (tap the map, drag the pin, or use
       your location) with a live, distance-sorted list of the nearest hits.

   Data is produced by scripts/build_map_data.py and read at runtime from
   static/data/{colleges,scholars,meta}.json (URLs injected via data-* attrs).
   ========================================================================= */
(function () {
  "use strict";

  // Basemap tiles. Light, low-chroma tiles so the coloured dots carry the map.
  // Swap these two URLs to use a different provider (e.g. OpenStreetMap standard).
  var TILES = {
    light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    dark:  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 18
  };

  // Friendly labels for the institution-type codes (RCSA's own labels for scholar
  // campuses; Carnegie-derived codes for every other college — same vocabulary).
  var TYPE_LABEL = {
    "R1": "R1 doctoral university — very high research",
    "R2": "R2 doctoral university — high research",
    "R3": "R3 doctoral / professional university",
    "Comp": "Master's / comprehensive university",
    "PUI": "Primarily undergraduate institution",
    "2 yr": "Two-year / associate's college",
    "Special": "Special-focus institution",
    "Foreign": "University (Canada)",
    "Research inst. / observatory": "Research institute / observatory"
  };

  // Every raw type collapses to one of these filter buckets. Anything that isn't
  // a recognised standalone bucket (special-focus, research institutes, the few
  // unclassified campuses) folds into "Special".
  function typeBucket(t) {
    switch (t) {
      case "R1": case "R2": case "R3":
      case "Comp": case "PUI": case "2 yr": case "Foreign":
        return t;
      default:
        return "Special";
    }
  }

  // Institution-type filter chips, in display order. `key` is the bucket above.
  var TYPE_FILTERS = [
    { key: "R1",      label: "R1",              title: "R1 — very high research" },
    { key: "R2",      label: "R2",              title: "R2 — high research" },
    { key: "R3",      label: "R3",              title: "R3 — doctoral / professional" },
    { key: "Comp",    label: "Master's",        title: "Master's / comprehensive" },
    { key: "PUI",     label: "PUI",             title: "Primarily undergraduate" },
    { key: "2 yr",    label: "Two-year",        title: "Two-year / associate's" },
    { key: "Special", label: "Special / other", title: "Special-focus, research institutes, unclassified" },
    { key: "Foreign", label: "Canada",          title: "Canadian universities" }
  ];

  // Enrollment size: IPEDS band (1–5) -> human label (shown in popups) …
  var SIZE_LABEL = {
    1: "Under 1,000 students", 2: "1,000–4,999 students",
    3: "5,000–9,999 students", 4: "10,000–19,999 students",
    5: "20,000 or more students"
  };
  // … and the coarser Small/Medium/Large buckets used by the filter chips.
  var SIZE_FILTERS = [
    { key: "S", label: "Small",  hint: "< 5,000" },
    { key: "M", label: "Medium", hint: "5,000–19,999" },
    { key: "L", label: "Large",  hint: "20,000+" }
  ];
  function sizeBucket(sz) {
    if (sz === 1 || sz === 2) { return "S"; }
    if (sz === 3 || sz === 4) { return "M"; }
    if (sz === 5) { return "L"; }
    return null;   // not reported (Canada, standalone institutes, a few US)
  }

  var mapEl = document.getElementById("cs-map");
  if (!mapEl || typeof L === "undefined") { return; }
  var CFG = {
    colleges: mapEl.dataset.colleges,
    scholars: mapEl.dataset.scholars,
    meta: mapEl.dataset.meta
  };

  // Coarse pointers (phones/tablets) need a much larger tap target than a mouse.
  var TOUCH = ("ontouchstart" in window) ||
    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

  // ---------------------------------------------------------------- theming
  function isDark() {
    var t = document.documentElement.dataset.theme;
    if (t === "light") { return false; }
    if (t === "dark") { return true; }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function palette() {
    var cs = getComputedStyle(document.documentElement);
    var g = function (n, d) { return (cs.getPropertyValue(n) || d).trim(); };
    return {
      scholar:     g("--dot-scholar", "#b4531f"),
      scholarRing: g("--dot-scholar-ring", "#fff"),
      college:     g("--dot-college", "#a89f90"),
      collegeRing: g("--dot-college-ring", "#faf7f2"),
      accent:      g("--accent", "#12655d")
    };
  }
  var PAL = palette();

  // ------------------------------------------------------------------- map
  var map = L.map(mapEl, {
    preferCanvas: true,
    center: [46, -96],
    zoom: 4,
    minZoom: 3,
    maxZoom: TILES.maxZoom,
    worldCopyJump: true,
    scrollWheelZoom: true,
    tap: true
  });

  var tiles = L.tileLayer(isDark() ? TILES.dark : TILES.light, {
    attribution: TILES.attribution,
    subdomains: TILES.subdomains,
    maxZoom: TILES.maxZoom,
    detectRetina: true
  }).addTo(map);

  // One shared canvas renderer for *both* dot layers. This is deliberate:
  // with two renderers in two panes, the upper pane's canvas covers the whole
  // map and swallows every tap meant for a dot in the lower pane — so the grey
  // college dots were effectively unclickable. A single canvas has one hit
  // handler that walks all dots and picks the top-most one under the tap.
  // `tolerance` grows the clickable area well past the tiny visible radius so
  // a fingertip actually lands on a dot.
  var dotRenderer = L.canvas({ padding: 0.5, tolerance: TOUCH ? 16 : 8 });

  // Panes for the radius overlay: the ring sits above the dots but must never
  // eat taps (pointer-events:none), and the draggable centre pin sits on top.
  map.createPane("cs-radius");
  map.getPane("cs-radius").style.zIndex = 615;
  map.getPane("cs-radius").style.pointerEvents = "none";
  map.createPane("cs-center");
  map.getPane("cs-center").style.zIndex = 665;
  // Keep scholar *cluster* badges above college ones (these are DOM, not canvas,
  // so they don't interfere with dot taps).
  map.createPane("cs-scholar");
  map.getPane("cs-scholar").style.zIndex = 640;
  var radiusRenderer = L.svg({ pane: "cs-radius" });

  // --------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function place(d) {
    return [d.city, d.state].filter(Boolean).join(", ");
  }
  function fmt(n) { return Number(n).toLocaleString("en-US"); }
  function clusterIcon(kind) {
    return function (cluster) {
      var n = cluster.getChildCount();
      var size = n < 10 ? 30 : n < 50 ? 38 : n < 200 ? 46 : 54;
      return L.divIcon({
        html: "<div style='width:" + size + "px;height:" + size + "px'>" + n + "</div>",
        className: "marker-cluster-cs marker-cluster-" + kind,
        iconSize: L.point(size, size)
      });
    };
  }
  // Miles between two lat/lon points (haversine).
  var MI_PER_M = 1 / 1609.344;
  function haversineMi(lat1, lon1, lat2, lon2) {
    var R = 3958.7613, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // ------------------------------------------------------------ popups
  // The institution's classification line: type ("R1 doctoral university…") and,
  // where known, enrollment size — each shown only when present.
  function classBits(d) {
    var bits = [];
    var t = TYPE_LABEL[d.type] || d.type;
    if (t) { bits.push(t); }
    if (d.size && SIZE_LABEL[d.size]) { bits.push(SIZE_LABEL[d.size]); }
    return bits;
  }
  function scholarPopup(d) {
    var list = d.scholars.map(function (s) {
      var meta = [s.year, s.discipline].filter(Boolean).join(" · ");
      return "<li><span class='cs-pop-sch-name'>" + esc(s.name) + "</span>" +
             (meta ? " <span class='cs-pop-sch-meta'>— " + esc(meta) + "</span>" : "") + "</li>";
    }).join("");
    var cls = classBits(d);
    var n = d.count;
    return "<div class='cs-pop'>" +
      "<p class='cs-pop-name'>" + esc(d.name) + "</p>" +
      (place(d) ? "<p class='cs-pop-meta'>" + esc(place(d)) + "</p>" : "") +
      (cls.length ? "<p class='cs-pop-meta cs-pop-class'>" + esc(cls.join(" · ")) + "</p>" : "") +
      "<span class='cs-pop-tag'>" + n + " Cottrell Scholar" + (n === 1 ? "" : "s") + "</span>" +
      "<ul class='cs-pop-scholars'>" + list + "</ul>" +
      "</div>";
  }
  function collegePopup(d) {
    var cls = classBits(d);
    return "<div class='cs-pop'>" +
      "<p class='cs-pop-name'>" + esc(d.name) + "</p>" +
      (place(d) ? "<p class='cs-pop-meta'>" + esc(place(d)) + "</p>" : "") +
      (cls.length ? "<p class='cs-pop-meta cs-pop-class'>" + esc(cls.join(" · ")) + "</p>" : "") +
      "<p class='cs-pop-empty'>No Cottrell Scholar yet — a potential partner institution.</p>" +
      "</div>";
  }

  // ------------------------------------------------------------ layers
  var collegeGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 55,
    disableClusteringAtZoom: 10,
    spiderfyOnMaxZoom: false,
    showCoverageOnHover: false,
    iconCreateFunction: clusterIcon("college")
  });
  var scholarGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 42,
    disableClusteringAtZoom: 9,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    clusterPane: "cs-scholar",
    iconCreateFunction: clusterIcon("scholar")
  });

  // Every institution as a unified record: the raw data, its marker, its kind,
  // and a lower-cased "haystack" string the text search matches against.
  var INST = [];
  var collegeMarkers = [];
  var scholarMarkers = [];

  function haystack(d, kind, extra) {
    var parts = [d.name, d.city, d.state, d.country, d.type];
    if (extra) { parts = parts.concat(extra); }
    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  function addColleges(rows) {
    rows.forEach(function (d) {
      if (typeof d.lat !== "number" || typeof d.lon !== "number") { return; }
      var m = L.circleMarker([d.lat, d.lon], {
        renderer: dotRenderer,
        radius: TOUCH ? 4 : 3.4, weight: 1,
        color: PAL.collegeRing, fillColor: PAL.college,
        opacity: 0.7, fillOpacity: 0.92
      });
      m.bindPopup(collegePopup(d), { closeButton: true, maxWidth: 280, autoPanPadding: [24, 24] });
      collegeMarkers.push(m);
      INST.push({ data: d, marker: m, kind: "college", lat: d.lat, lon: d.lon,
                  hay: haystack(d, "college"), tb: typeBucket(d.type),
                  sb: sizeBucket(d.size), dist: null });
    });
  }
  function addScholars(rows) {
    rows.forEach(function (d) {
      if (typeof d.lat !== "number" || typeof d.lon !== "number") { return; }
      var m = L.circleMarker([d.lat, d.lon], {
        renderer: dotRenderer,
        radius: TOUCH ? 6.5 : 5.8, weight: 1.6,
        color: PAL.scholarRing, fillColor: PAL.scholar,
        opacity: 1, fillOpacity: 1
      });
      m.bindPopup(scholarPopup(d), { closeButton: true, maxWidth: 300, minWidth: 220, autoPanPadding: [24, 24] });
      scholarMarkers.push(m);
      var extra = (d.scholars || []).map(function (s) {
        return [s.name, s.year, s.discipline].filter(Boolean).join(" ");
      });
      INST.push({ data: d, marker: m, kind: "scholar", lat: d.lat, lon: d.lon,
                  hay: haystack(d, "scholar", extra), tb: typeBucket(d.type),
                  sb: sizeBucket(d.size), dist: null });
    });
  }

  // --------------------------------------------------------- filter state
  var state = {
    q: "",
    radiusOn: false,
    center: null,        // L.LatLng
    radiusMi: 100,
    layerOn: { scholar: true, college: true },
    types: {},           // bucket -> true; empty object == no type filter
    sizes: {},           // "S"/"M"/"L" -> true; empty object == no size filter
    showAll: false       // results list: show every hit vs. just the nearest few
  };
  var lastVis = { scholar: [], college: [] };  // cached results of last apply
  var totals = { scholar: 0, college: 0 };

  function anyOn(obj) {
    for (var k in obj) { if (obj[k]) { return true; } }
    return false;
  }
  function countOn(obj) {
    var n = 0;
    for (var k in obj) { if (obj[k]) { n++; } }
    return n;
  }

  function passes(rec) {
    if (state.q && rec.hay.indexOf(state.q) === -1) { return false; }
    if (anyOn(state.types) && !state.types[rec.tb]) { return false; }
    if (anyOn(state.sizes) && (!rec.sb || !state.sizes[rec.sb])) { return false; }
    if (state.radiusOn && state.center) {
      rec.dist = haversineMi(state.center.lat, state.center.lng, rec.lat, rec.lon);
      if (rec.dist > state.radiusMi) { return false; }
    } else {
      rec.dist = null;
    }
    return true;
  }

  function rebuildGroup(group, recs) {
    group.clearLayers();
    if (recs.length) { group.addLayers(recs.map(function (r) { return r.marker; })); }
  }

  var els = {};   // toolbar element refs, filled in buildToolbar()

  function applyFilters() {
    var sch = [], col = [];
    for (var i = 0; i < INST.length; i++) {
      var rec = INST[i];
      if (passes(rec)) { (rec.kind === "scholar" ? sch : col).push(rec); }
    }
    lastVis.scholar = sch;
    lastVis.college = col;
    rebuildGroup(scholarGroup, sch);
    rebuildGroup(collegeGroup, col);
    updateCounts();
    renderResults();
    updateFilterMeta();
  }
  var applyFiltersDebounced = debounce(applyFilters, 150);

  // ------------------------------------------------------------ legend
  var legendCount = {};   // kind -> count <span>
  function updateCounts() {
    if (legendCount.scholar) {
      setCount(legendCount.scholar, lastVis.scholar.length, totals.scholar);
    }
    if (legendCount.college) {
      setCount(legendCount.college, lastVis.college.length, totals.college);
    }
  }
  function setCount(node, shown, total) {
    if (shown === total) {
      node.innerHTML = fmt(total);
    } else {
      node.innerHTML = fmt(shown) +
        "<span class='cs-legend-total'>/" + fmt(total) + "</span>";
    }
  }

  function legend() {
    var ctl = L.control({ position: "topright" });
    ctl.onAdd = function () {
      var div = L.DomUtil.create("div", "cs-control cs-legend");
      div.innerHTML =
        "<button class='cs-legend-toggle' type='button' aria-expanded='true'>" +
          "<span class='cs-legend-title'>Legend</span>" +
          "<span class='cs-legend-chev' aria-hidden='true'></span></button>" +
        "<div class='cs-legend-body'>" +
        "<label class='cs-legend-row' data-layer='scholar'>" +
          "<input type='checkbox' checked>" +
          "<span class='cs-swatch cs-swatch-scholar'></span>" +
          "<span class='cs-legend-label'>Cottrell Scholar</span>" +
          "<span class='cs-legend-count' data-count='scholar'></span></label>" +
        "<label class='cs-legend-row' data-layer='college'>" +
          "<input type='checkbox' checked>" +
          "<span class='cs-swatch cs-swatch-college'></span>" +
          "<span class='cs-legend-label'>College / university</span>" +
          "<span class='cs-legend-count' data-count='college'></span></label>" +
        "<p class='cs-legend-hint'>Tap a dot for detail. Numbers are clusters — zoom in to separate them.</p>" +
        "</div>";

      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);

      legendCount.scholar = div.querySelector("[data-count='scholar']");
      legendCount.college = div.querySelector("[data-count='college']");

      var toggle = div.querySelector(".cs-legend-toggle");
      toggle.addEventListener("click", function () {
        var open = div.classList.toggle("is-collapsed");
        toggle.setAttribute("aria-expanded", open ? "false" : "true");
      });
      // Start collapsed on small screens so the map is unobstructed.
      if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
        div.classList.add("is-collapsed");
        toggle.setAttribute("aria-expanded", "false");
      }

      div.querySelectorAll(".cs-legend-row").forEach(function (row) {
        var which = row.getAttribute("data-layer");
        var box = row.querySelector("input");
        box.addEventListener("change", function () {
          state.layerOn[which] = box.checked;
          var group = which === "scholar" ? scholarGroup : collegeGroup;
          if (box.checked) { map.addLayer(group); row.classList.remove("is-off"); }
          else { map.removeLayer(group); row.classList.add("is-off"); }
          renderResults();
        });
      });
      updateCounts();
      return div;
    };
    ctl.addTo(map);
  }

  // ----------------------------------------------------- radius overlay
  var circle = null, centerMarker = null, awaitingCenter = false;

  function metersFromMi(mi) { return mi * 1609.344; }

  function ensureOverlay() {
    if (!state.center) { return; }
    if (!circle) {
      circle = L.circle(state.center, {
        renderer: radiusRenderer, pane: "cs-radius",
        radius: metersFromMi(state.radiusMi),
        color: PAL.accent, weight: 1.5, opacity: 0.9,
        fillColor: PAL.accent, fillOpacity: 0.08, dashArray: "5 5",
        interactive: false
      }).addTo(map);
    } else {
      circle.setLatLng(state.center);
      circle.setRadius(metersFromMi(state.radiusMi));
    }
    if (!centerMarker) {
      centerMarker = L.marker(state.center, {
        pane: "cs-center", draggable: true, keyboard: false, zIndexOffset: 1000,
        icon: L.divIcon({ className: "cs-center-icon", html: "<span></span>", iconSize: [28, 28] }),
        title: "Drag to move the radius centre"
      }).addTo(map);
      centerMarker.on("drag", function () {
        state.center = centerMarker.getLatLng();
        if (circle) { circle.setLatLng(state.center); }
        applyFiltersDebounced();
      });
      centerMarker.on("dragend", applyFilters);
    } else {
      centerMarker.setLatLng(state.center);
    }
  }
  function clearOverlay() {
    if (circle) { map.removeLayer(circle); circle = null; }
    if (centerMarker) { map.removeLayer(centerMarker); centerMarker = null; }
  }

  function setCenter(latlng, fit) {
    state.center = L.latLng(latlng);
    ensureOverlay();
    if (els.clearCenter) { els.clearCenter.hidden = false; }
    if (fit && circle) { map.fitBounds(circle.getBounds().pad(0.15)); }
    applyFilters();
  }

  function enableRadius() {
    state.radiusOn = true;
    if (!state.center) { setCenter(map.getCenter(), false); }
    else { ensureOverlay(); applyFilters(); }
  }
  function disableRadius() {
    state.radiusOn = false;
    state.showAll = false;
    stopAwaitCenter();
    clearOverlay();
    applyFilters();
  }

  function startAwaitCenter() {
    awaitingCenter = true;
    mapEl.classList.add("cs-picking");
    if (els.hint) { els.hint.hidden = false; }
    if (els.setCenter) { els.setCenter.classList.add("is-active"); }
  }
  function stopAwaitCenter() {
    awaitingCenter = false;
    mapEl.classList.remove("cs-picking");
    if (els.hint) { els.hint.hidden = true; }
    if (els.setCenter) { els.setCenter.classList.remove("is-active"); }
  }
  map.on("click", function (e) {
    if (awaitingCenter) {
      stopAwaitCenter();
      setCenter(e.latlng, false);
    }
  });

  // ----------------------------------------------------- results list
  var RESULTS_INITIAL = 10;    // nearest few shown by default …
  var RESULTS_CAP = 500;       // … up to this many once the user expands the list

  function renderResults() {
    if (!els.results) { return; }
    if (!state.radiusOn || !state.center) {
      els.results.hidden = true;
      return;
    }
    els.results.hidden = false;

    var pool = [];
    if (state.layerOn.scholar) { pool = pool.concat(lastVis.scholar); }
    if (state.layerOn.college) { pool = pool.concat(lastVis.college); }
    pool.sort(function (a, b) { return a.dist - b.dist; });

    var total = pool.length;
    var limit = state.showAll ? Math.min(total, RESULTS_CAP) : Math.min(total, RESULTS_INITIAL);
    var shown = pool.slice(0, limit);
    renderResults._shown = shown;     // read by the delegated click handler
    var km = Math.round(state.radiusMi * 1.60934);
    els.resultsHead.textContent = total === 0
      ? "No institutions within " + state.radiusMi + " mi"
      : fmt(total) + (total === 1 ? " institution" : " institutions") +
        " within " + state.radiusMi + " mi (" + fmt(km) + " km)";

    var html = shown.map(function (rec, i) {
      var d = rec.data;
      var sub = place(d);
      var badge = rec.kind === "scholar"
        ? "<span class='cs-res-badge'>" + d.count + " scholar" + (d.count === 1 ? "" : "s") + "</span>"
        : "";
      return "<li><button type='button' class='cs-res-item' data-idx='" + i + "'>" +
        "<span class='cs-res-dot cs-res-dot-" + rec.kind + "'></span>" +
        "<span class='cs-res-text'>" +
          "<span class='cs-res-name'>" + esc(d.name) + "</span>" +
          "<span class='cs-res-sub'>" + (sub ? esc(sub) : "") + badge + "</span>" +
        "</span>" +
        "<span class='cs-res-dist'>" + rec.dist.toFixed(rec.dist < 10 ? 1 : 0) + " mi</span>" +
        "</button></li>";
    }).join("");

    // The tail that used to be a dead "+ N more" label is now a real control, so
    // the institutions beyond the first handful are actually reachable.
    if (!state.showAll && total > shown.length) {
      html += "<li class='cs-res-more'><button type='button' class='cs-res-showall'>" +
        "Show all " + fmt(total) + "</button></li>";
    } else if (state.showAll && total > RESULTS_CAP) {
      html += "<li class='cs-res-more cs-res-note'>Showing the nearest " + fmt(RESULTS_CAP) +
        " of " + fmt(total) + " — narrow the radius or filters to see the rest.</li>";
    } else if (state.showAll && total > RESULTS_INITIAL) {
      html += "<li class='cs-res-more'><button type='button' class='cs-res-showall' " +
        "data-collapse='1'>Show fewer</button></li>";
    }
    els.resultsList.innerHTML = html;
  }

  // -------------------------------------------------- active-filter meta line
  // Total match count + a "zoom to fit" affordance, shown whenever a search or a
  // type/size filter is narrowing the map. Radius mode has its own distance-
  // sorted list below, so we defer to that when it's on.
  function updateFilterMeta() {
    if (!els.searchMeta) { return; }
    var active = state.q || anyOn(state.types) || anyOn(state.sizes);
    if (!active || state.radiusOn) { els.searchMeta.hidden = true; return; }
    var n = lastVis.scholar.length + lastVis.college.length;
    els.searchMeta.hidden = false;
    els.searchMetaText.textContent = fmt(n) + (n === 1 ? " match" : " matches");
    els.searchFit.hidden = n === 0;
  }
  function fitToMatches() {
    var recs = lastVis.scholar.concat(lastVis.college);
    if (state.radiusOn) {
      recs = recs.filter(function (r) { return state.layerOn[r.kind]; });
    }
    if (!recs.length) { return; }
    var b = L.latLngBounds(recs.map(function (r) { return [r.lat, r.lon]; }));
    map.fitBounds(b.pad(0.2), { maxZoom: 12 });
  }

  // ------------------------------------------------------------ toolbar
  function buildToolbar() {
    var shell = mapEl.closest(".map-shell") || mapEl.parentNode;
    var bar = document.createElement("div");
    bar.className = "map-toolbar";
    bar.innerHTML =
      "<div class='mt-row'>" +
        "<span class='mt-search'>" +
          "<svg class='mt-search-ic' viewBox='0 0 20 20' aria-hidden='true'>" +
            "<circle cx='9' cy='9' r='6' fill='none' stroke='currentColor' stroke-width='2'/>" +
            "<line x1='13.5' y1='13.5' x2='18' y2='18' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
          "</svg>" +
          "<input id='mt-q' class='mt-input' type='search' inputmode='search' autocomplete='off' " +
            "placeholder='Search institutions, cities, scholars…' " +
            "aria-label='Search institutions, cities, and scholars'>" +
          "<button class='mt-clear' type='button' aria-label='Clear search' hidden>&times;</button>" +
        "</span>" +
        "<button class='mt-filter-btn' type='button' aria-expanded='false'>" +
          "<span class='mt-filter-ic' aria-hidden='true'></span>Filters" +
          "<span class='mt-filter-count' hidden></span></button>" +
        "<button class='mt-radius-btn' type='button' aria-expanded='false'>" +
          "<span class='mt-radius-ic' aria-hidden='true'></span>Radius</button>" +
      "</div>" +
      "<p class='mt-search-meta' hidden><span class='mt-search-meta-text'></span>" +
        "<button type='button' class='mt-fit' hidden>Zoom to fit</button></p>" +
      "<div class='mt-filter-panel' hidden>" +
        "<div class='mt-group'>" +
          "<p class='mt-group-label'>Institution type</p>" +
          "<div class='mt-chips mt-type-chips'></div>" +
        "</div>" +
        "<div class='mt-group'>" +
          "<p class='mt-group-label'>Size " +
            "<span class='mt-group-note'>— total enrollment, US campuses</span></p>" +
          "<div class='mt-chips mt-size-chips'></div>" +
        "</div>" +
        "<button type='button' class='mt-clearfilters' hidden>Clear filters</button>" +
      "</div>" +
      "<div class='mt-radius-panel' hidden>" +
        "<div class='mt-center-row'>" +
          "<button class='mt-setcenter' type='button'>Tap the map to set centre</button>" +
          "<button class='mt-geoloc' type='button'>Use my location</button>" +
          "<button class='mt-clearcenter' type='button' hidden>Recentre</button>" +
        "</div>" +
        "<label class='mt-slider'>" +
          "<span class='mt-slider-label'>Within <strong class='mt-dist'>100 mi</strong></span>" +
          "<input class='mt-range' type='range' min='10' max='500' step='10' value='100' " +
            "aria-label='Radius in miles'>" +
        "</label>" +
        "<p class='mt-geoerr' role='alert' hidden></p>" +
        "<div class='mt-results' aria-live='polite' hidden>" +
          "<p class='mt-results-head'></p>" +
          "<ol class='mt-results-list'></ol>" +
        "</div>" +
      "</div>" +
      "<p class='mt-hint' hidden>Tap anywhere on the map to drop the radius centre.</p>";

    shell.parentNode.insertBefore(bar, shell);

    els.input      = bar.querySelector(".mt-input");
    els.clear      = bar.querySelector(".mt-clear");
    els.filterBtn  = bar.querySelector(".mt-filter-btn");
    els.filterCount= bar.querySelector(".mt-filter-count");
    els.filterPanel= bar.querySelector(".mt-filter-panel");
    els.typeChips  = bar.querySelector(".mt-type-chips");
    els.sizeChips  = bar.querySelector(".mt-size-chips");
    els.clearFilters = bar.querySelector(".mt-clearfilters");
    els.radiusBtn  = bar.querySelector(".mt-radius-btn");
    els.panel      = bar.querySelector(".mt-radius-panel");
    els.setCenter  = bar.querySelector(".mt-setcenter");
    els.geoloc     = bar.querySelector(".mt-geoloc");
    els.clearCenter= bar.querySelector(".mt-clearcenter");
    els.range      = bar.querySelector(".mt-range");
    els.dist       = bar.querySelector(".mt-dist");
    els.geoErr     = bar.querySelector(".mt-geoerr");
    els.results    = bar.querySelector(".mt-results");
    els.resultsHead= bar.querySelector(".mt-results-head");
    els.resultsList= bar.querySelector(".mt-results-list");
    els.hint       = bar.querySelector(".mt-hint");
    els.searchMeta = bar.querySelector(".mt-search-meta");
    els.searchMetaText = bar.querySelector(".mt-search-meta-text");
    els.searchFit  = bar.querySelector(".mt-fit");

    // ---- search
    els.input.addEventListener("input", function () {
      state.q = els.input.value.trim().toLowerCase();
      els.clear.hidden = !els.input.value;
      applyFiltersDebounced();
    });
    els.clear.addEventListener("click", function () {
      els.input.value = ""; state.q = ""; els.clear.hidden = true;
      els.input.focus(); applyFilters();
    });
    els.searchFit.addEventListener("click", fitToMatches);

    // ---- radius toggle
    els.radiusBtn.addEventListener("click", function () {
      var on = els.panel.hasAttribute("hidden");
      if (on) {
        els.panel.removeAttribute("hidden");
        els.radiusBtn.setAttribute("aria-expanded", "true");
        els.radiusBtn.classList.add("is-on");
        enableRadius();
      } else {
        els.panel.setAttribute("hidden", "");
        els.radiusBtn.setAttribute("aria-expanded", "false");
        els.radiusBtn.classList.remove("is-on");
        disableRadius();
      }
    });

    // ---- centre selection
    els.setCenter.addEventListener("click", function () {
      if (awaitingCenter) { stopAwaitCenter(); } else { startAwaitCenter(); }
    });
    els.clearCenter.addEventListener("click", function () {
      clearOverlay();
      state.center = null;
      els.clearCenter.hidden = true;
      setCenter(map.getCenter(), false);
    });
    els.geoloc.addEventListener("click", function () {
      els.geoErr.hidden = true;
      if (!navigator.geolocation) {
        els.geoErr.hidden = false;
        els.geoErr.textContent = "Location isn't available in this browser.";
        return;
      }
      els.geoloc.classList.add("is-busy");
      els.geoloc.textContent = "Locating…";
      navigator.geolocation.getCurrentPosition(function (pos) {
        els.geoloc.classList.remove("is-busy");
        els.geoloc.textContent = "Use my location";
        setCenter([pos.coords.latitude, pos.coords.longitude], true);
      }, function (err) {
        els.geoloc.classList.remove("is-busy");
        els.geoloc.textContent = "Use my location";
        els.geoErr.hidden = false;
        els.geoErr.textContent = err && err.code === 1
          ? "Location permission was denied."
          : "Couldn't get your location.";
      }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
    });

    // ---- radius slider
    els.range.addEventListener("input", function () {
      state.radiusMi = +els.range.value;
      els.dist.textContent = state.radiusMi + " mi";
      if (circle) { circle.setRadius(metersFromMi(state.radiusMi)); }
      applyFiltersDebounced();
    });

    // ---- type & size filter chips
    function chipHTML(def) {
      var hint = def.hint ? " <span class='mt-chip-hint'>" + esc(def.hint) + "</span>" : "";
      var title = def.title ? " title='" + esc(def.title) + "'" : "";
      return "<button type='button' class='mt-chip' aria-pressed='false' " +
        "data-key='" + esc(def.key) + "'" + title + ">" + esc(def.label) + hint + "</button>";
    }
    els.typeChips.innerHTML = TYPE_FILTERS.map(chipHTML).join("");
    els.sizeChips.innerHTML = SIZE_FILTERS.map(chipHTML).join("");

    function toggleChip(chip, bag) {
      var key = chip.getAttribute("data-key");
      var on = !bag[key];
      if (on) { bag[key] = true; } else { delete bag[key]; }
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.classList.toggle("is-on", on);
      reflectFilters();
      applyFilters();
    }
    els.typeChips.addEventListener("click", function (e) {
      var chip = e.target.closest(".mt-chip");
      if (chip) { toggleChip(chip, state.types); }
    });
    els.sizeChips.addEventListener("click", function (e) {
      var chip = e.target.closest(".mt-chip");
      if (chip) { toggleChip(chip, state.sizes); }
    });

    // Keep the "Clear filters" link, the toolbar button's active state, and its
    // count badge in sync with how many chips are pressed.
    function reflectFilters() {
      var n = countOn(state.types) + countOn(state.sizes);
      els.clearFilters.hidden = n === 0;
      els.filterBtn.classList.toggle("is-on", n > 0);
      els.filterCount.hidden = n === 0;
      els.filterCount.textContent = n ? String(n) : "";
    }

    els.filterBtn.addEventListener("click", function () {
      var open = els.filterPanel.hasAttribute("hidden");
      if (open) {
        els.filterPanel.removeAttribute("hidden");
        els.filterBtn.setAttribute("aria-expanded", "true");
      } else {
        els.filterPanel.setAttribute("hidden", "");
        els.filterBtn.setAttribute("aria-expanded", "false");
      }
    });

    els.clearFilters.addEventListener("click", function () {
      state.types = {};
      state.sizes = {};
      els.filterPanel.querySelectorAll(".mt-chip").forEach(function (c) {
        c.setAttribute("aria-pressed", "false");
        c.classList.remove("is-on");
      });
      reflectFilters();
      applyFilters();
    });

    // ---- results list (delegated: items + the "show all / fewer" control)
    els.resultsList.addEventListener("click", function (e) {
      var toggle = e.target.closest(".cs-res-showall");
      if (toggle) {
        state.showAll = !toggle.hasAttribute("data-collapse");
        renderResults();
        return;
      }
      var item = e.target.closest(".cs-res-item");
      if (!item) { return; }
      var rec = renderResults._shown && renderResults._shown[+item.getAttribute("data-idx")];
      if (!rec) { return; }
      var group = rec.kind === "scholar" ? scholarGroup : collegeGroup;
      map.closePopup();
      group.zoomToShowLayer(rec.marker, function () { rec.marker.openPopup(); });
    });

    bar.classList.add("is-ready");
  }

  // ------------------------------------------------------ theme reactivity
  function retheme() {
    PAL = palette();
    tiles.setUrl(isDark() ? TILES.dark : TILES.light);
    collegeMarkers.forEach(function (m) {
      m.setStyle({ color: PAL.collegeRing, fillColor: PAL.college });
    });
    scholarMarkers.forEach(function (m) {
      m.setStyle({ color: PAL.scholarRing, fillColor: PAL.scholar });
    });
    if (circle) { circle.setStyle({ color: PAL.accent, fillColor: PAL.accent }); }
    collegeGroup.refreshClusters();
    scholarGroup.refreshClusters();
  }
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change")
                         : mq.addListener.bind(mq))(retheme);
  }

  // ------------------------------------------------------------- load data
  function note(text) {
    var el = document.getElementById("cs-map-note");
    if (el) { el.textContent = text; }
  }
  function getJSON(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) { throw new Error(url + " → " + r.status); }
      return r.json();
    });
  }

  Promise.all([
    getJSON(CFG.scholars),
    getJSON(CFG.colleges),
    getJSON(CFG.meta).catch(function () { return null; })
  ]).then(function (res) {
    var scholars = res[0], colleges = res[1], meta = res[2];

    addColleges(colleges);
    addScholars(scholars);
    totals.scholar = scholarMarkers.length;
    totals.college = collegeMarkers.length;

    // Colleges first so scholar dots draw (and resolve taps) on top of them.
    collegeGroup.addLayers(collegeMarkers);
    scholarGroup.addLayers(scholarMarkers);
    map.addLayer(collegeGroup);
    map.addLayer(scholarGroup);
    lastVis.scholar = INST.filter(function (r) { return r.kind === "scholar"; });
    lastVis.college = INST.filter(function (r) { return r.kind === "college"; });

    buildToolbar();
    legend();

    // Debug/smoke-test hook.
    window.__cs = {
      map: map, scholarGroup: scholarGroup, collegeGroup: collegeGroup,
      state: state, applyFilters: applyFilters, setCenter: setCenter,
      enableRadius: enableRadius, lastVis: lastVis, INST: INST, els: els
    };

    var parts = [
      fmt(scholars.length) + " Cottrell Scholar institutions",
      fmt(colleges.length) + " other colleges & universities"
    ];
    var tail = [];
    if (meta && meta.year_min) { tail.push("Scholars " + meta.year_min + "–" + meta.year_max); }
    tail.push("Data: RCSA, IPEDS (US Dept. of Education), OpenStreetMap");
    if (meta && meta.generated) { tail.push("updated " + meta.generated); }
    note(parts.join(" · ") + ".  " + tail.join(" · ") + ".");
  }).catch(function (err) {
    note("The map data could not be loaded (" + err.message + ").");
    if (window.console) { console.error("[cs-map]", err); }
  });
})();
