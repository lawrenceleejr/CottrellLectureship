/* =========================================================================
   Scholars & Institutions map.

   Draws every US + Canada college/university as a quiet grey dot, and every
   institution with a Cottrell Scholar as a terracotta dot. Two independently
   toggleable, clustered layers; click a dot for details.

   Data is produced by scripts/build_map_data.py and read at runtime from
   static/data/{colleges,scholars,meta}.json (URLs injected via window.CS_MAP).
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
      collegeRing: g("--dot-college-ring", "#faf7f2")
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
    scrollWheelZoom: true
  });

  var tiles = L.tileLayer(isDark() ? TILES.dark : TILES.light, {
    attribution: TILES.attribution,
    subdomains: TILES.subdomains,
    maxZoom: TILES.maxZoom,
    detectRetina: true
  }).addTo(map);

  // Keep scholar dots/clusters painted above the college layer.
  map.createPane("cs-scholar");
  map.getPane("cs-scholar").style.zIndex = 640;
  var collegeRenderer = L.canvas({ padding: 0.5 });
  var scholarRenderer = L.canvas({ padding: 0.5, pane: "cs-scholar" });

  // --------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function place(d) {
    return [d.city, d.state].filter(Boolean).join(", ");
  }
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

  var collegeMarkers = [];
  var scholarMarkers = [];

  function addColleges(rows) {
    var buf = [];
    rows.forEach(function (d) {
      if (typeof d.lat !== "number" || typeof d.lon !== "number") { return; }
      var m = L.circleMarker([d.lat, d.lon], {
        renderer: collegeRenderer,
        radius: 3.2, weight: 1,
        color: PAL.collegeRing, fillColor: PAL.college,
        opacity: 0.55, fillOpacity: 0.9
      });
      m.bindPopup(collegePopup(d), { closeButton: true, maxWidth: 280 });
      collegeMarkers.push(m);
      buf.push(m);
    });
    collegeGroup.addLayers(buf);
  }
  function addScholars(rows) {
    var buf = [];
    rows.forEach(function (d) {
      if (typeof d.lat !== "number" || typeof d.lon !== "number") { return; }
      var m = L.circleMarker([d.lat, d.lon], {
        renderer: scholarRenderer,
        radius: 5.5, weight: 1.5,
        color: PAL.scholarRing, fillColor: PAL.scholar,
        opacity: 1, fillOpacity: 1
      });
      m.bindPopup(scholarPopup(d), { closeButton: true, maxWidth: 300, minWidth: 220 });
      scholarMarkers.push(m);
      buf.push(m);
    });
    scholarGroup.addLayers(buf);
  }

  // ------------------------------------------------------------ legend
  function legend(counts) {
    var ctl = L.control({ position: "topright" });
    ctl.onAdd = function () {
      var div = L.DomUtil.create("div", "cs-control");
      div.innerHTML =
        "<p class='cs-legend-title'>Institutions</p>" +
        "<label class='cs-legend-row' data-layer='scholar'>" +
          "<input type='checkbox' checked>" +
          "<span class='cs-swatch cs-swatch-scholar'></span>" +
          "<span>Cottrell Scholar</span>" +
          "<span class='cs-legend-count'>" + counts.scholar + "</span></label>" +
        "<label class='cs-legend-row' data-layer='college'>" +
          "<input type='checkbox' checked>" +
          "<span class='cs-swatch cs-swatch-college'></span>" +
          "<span>College / university</span>" +
          "<span class='cs-legend-count'>" + counts.college + "</span></label>" +
        "<p class='cs-legend-hint'>Click a dot for detail. Numbers are clusters — zoom in to separate them.</p>";

      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);

      div.querySelectorAll(".cs-legend-row").forEach(function (row) {
        var which = row.getAttribute("data-layer");
        var box = row.querySelector("input");
        box.addEventListener("change", function () {
          var group = which === "scholar" ? scholarGroup : collegeGroup;
          if (box.checked) { map.addLayer(group); row.classList.remove("is-off"); }
          else { map.removeLayer(group); row.classList.add("is-off"); }
        });
      });
      return div;
    };
    ctl.addTo(map);
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
    map.addLayer(collegeGroup);
    map.addLayer(scholarGroup);

    legend({ scholar: scholars.length, college: colleges.length });

    // Small hook for debugging in the browser console (and smoke tests).
    window.__cs = { map: map, scholarGroup: scholarGroup, collegeGroup: collegeGroup };

    var fmt = function (n) { return n.toLocaleString("en-US"); };
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
