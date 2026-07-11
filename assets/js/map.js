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

  // Friendly labels for RCSA's institution-type codes.
  var TYPE_LABEL = {
    "R1": "R1 doctoral university — very high research",
    "R2": "R2 doctoral university — high research",
    "R3": "R3 doctoral / professional university",
    "PUI": "Primarily undergraduate institution",
    "Comp": "Master's / comprehensive university",
    "2 yr": "Two-year college",
    "Foreign": "University (Canada)",
    "Research inst. / observatory": "Research institute / observatory"
  };

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
  function scholarPopup(d) {
    var list = d.scholars.map(function (s) {
      var meta = [s.year, s.discipline].filter(Boolean).join(" · ");
      return "<li><span class='cs-pop-sch-name'>" + esc(s.name) + "</span>" +
             (meta ? " <span class='cs-pop-sch-meta'>— " + esc(meta) + "</span>" : "") + "</li>";
    }).join("");
    var type = TYPE_LABEL[d.type] || d.type || "";
    var n = d.count;
    return "<div class='cs-pop'>" +
      "<p class='cs-pop-name'>" + esc(d.name) + "</p>" +
      (place(d) ? "<p class='cs-pop-meta'>" + esc(place(d)) + (type ? " · " + esc(type) : "") + "</p>"
                : (type ? "<p class='cs-pop-meta'>" + esc(type) + "</p>" : "")) +
      "<span class='cs-pop-tag'>" + n + " Cottrell Scholar" + (n === 1 ? "" : "s") + "</span>" +
      "<ul class='cs-pop-scholars'>" + list + "</ul>" +
      "</div>";
  }
  function collegePopup(d) {
    return "<div class='cs-pop'>" +
      "<p class='cs-pop-name'>" + esc(d.name) + "</p>" +
      (place(d) ? "<p class='cs-pop-meta'>" + esc(place(d)) + "</p>" : "") +
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
    var parts = [d.name, d.city, d.state, d.country];
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
                  hay: haystack(d, "college"), dist: null });
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
                  hay: haystack(d, "scholar", extra), dist: null });
    });
  }

  // --------------------------------------------------------- filter state
  var state = {
    q: "",
    radiusOn: false,
    center: null,        // L.LatLng
    radiusMi: 100,
    layerOn: { scholar: true, college: true }
  };
  var lastVis = { scholar: [], college: [] };  // cached results of last apply
  var totals = { scholar: 0, college: 0 };

  function passes(rec) {
    if (state.q && rec.hay.indexOf(state.q) === -1) { return false; }
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
    updateSearchMeta();
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
    var shown = pool.slice(0, 10);
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
    if (total > shown.length) {
      html += "<li class='cs-res-more'>+ " + fmt(total - shown.length) + " more</li>";
    }
    els.resultsList.innerHTML = html;

    els.resultsList.querySelectorAll(".cs-res-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var rec = shown[+btn.getAttribute("data-idx")];
        if (!rec) { return; }
        var group = rec.kind === "scholar" ? scholarGroup : collegeGroup;
        map.closePopup();
        group.zoomToShowLayer(rec.marker, function () { rec.marker.openPopup(); });
      });
    });
  }

  // ----------------------------------------------------- search meta line
  function updateSearchMeta() {
    if (!els.searchMeta) { return; }
    if (!state.q) { els.searchMeta.hidden = true; return; }
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
        "<button class='mt-radius-btn' type='button' aria-expanded='false'>" +
          "<span class='mt-radius-ic' aria-hidden='true'></span>Radius</button>" +
      "</div>" +
      "<p class='mt-search-meta' hidden><span class='mt-search-meta-text'></span>" +
        "<button type='button' class='mt-fit' hidden>Zoom to fit</button></p>" +
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
