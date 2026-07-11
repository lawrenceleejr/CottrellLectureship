#!/usr/bin/env python3
"""
Build the data that powers the Scholars & Institutions map.

Run this once a year (or whenever the Cottrell Scholar list changes) to refresh
the map. It produces two data files the map reads at runtime:

    static/data/colleges.json   every US + Canada college/university  (grey dots)
    static/data/scholars.json   institutions that have a Cottrell Scholar (accent
                                dots) + the scholars at each one

Every record in both files carries a "type" (R1/R2/R3/Comp/PUI/2 yr/Special/
Foreign, from the Carnegie classification) and, where IPEDS reports it, a "size"
(enrollment band 1-5). The map's filter toolbar reads both.

...plus a couple of durable side files:

    data/cottrell_scholars.json   the raw scholar list pulled from RCSA (a backup
                                  you can hand-edit if the RCSA page ever changes)
    scripts/geocode_cache.json    cached lat/lon so re-runs are fast and stable
    static/data/meta.json         counts + build date shown on the page

------------------------------------------------------------------------------
Typical yearly update
------------------------------------------------------------------------------
    python3 scripts/build_map_data.py

That's it. The script:
  1. pulls the current Cottrell Scholars from the RCSA awardee dashboard,
  2. pulls the US institution list from IPEDS (US Dept. of Education),
  3. geocodes the Canadian universities (cached after the first run),
  4. matches each scholar to an institution and writes the two JSON files.

Then commit the changed files:  git add data static && git commit && git push

------------------------------------------------------------------------------
Handy options
------------------------------------------------------------------------------
  --offline            don't hit the network for scholars; use the committed
                       data/cottrell_scholars.json instead (edit that file to
                       add/remove scholars by hand, then re-run with --offline).
  --ipeds PATH         use a IPEDS "HDxxxx.zip" you downloaded yourself instead
                       of fetching it (https://nces.ed.gov/ipeds/datacenter/).
  --include-2yr        also include 2-year / community colleges in the base map
                       (default: 4-year degree-granting institutions only).

If a NEW scholar turns up at an institution the script can't recognise, it says
so loudly at the end and tells you exactly which alias to add — see ALIASES below.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile

# --------------------------------------------------------------------------- paths
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATIC_DATA = os.path.join(ROOT, "static", "data")
DATA_DIR = os.path.join(ROOT, "data")
GEOCODE_CACHE = os.path.join(HERE, "geocode_cache.json")
RAW_SCHOLARS = os.path.join(DATA_DIR, "cottrell_scholars.json")

# --------------------------------------------------------------------------- sources
RCSA_DASHBOARD = "https://rescorp.org/cottrell-scholars/awardee-dashboard/"
# IPEDS "HD" (institutional directory) — clean names, coordinates, level flags.
IPEDS_YEARS = [2024, 2023, 2022]
IPEDS_URL = "https://nces.ed.gov/ipeds/datacenter/data/HD{year}.zip"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
UA = "CottrellLectureshipMap/1.0 (github.com/lawrenceleejr/CottrellLectureship)"

# --------------------------------------------------------------------------- Canada
# IPEDS is US-only, so the Canadian universities are listed here (from the
# authoritative Wikipedia "List of universities in Canada"). To add one, drop a
# "Name | City | Province" line in — it will be geocoded and cached automatically.
CANADA_UNIVERSITIES = """
Alberta University of the Arts | Calgary | Alberta
Athabasca University | Athabasca | Alberta
University of Alberta | Edmonton | Alberta
University of Calgary | Calgary | Alberta
University of Lethbridge | Lethbridge | Alberta
MacEwan University | Edmonton | Alberta
Mount Royal University | Calgary | Alberta
Capilano University | North Vancouver | British Columbia
Emily Carr University of Art and Design | Vancouver | British Columbia
Kwantlen Polytechnic University | Surrey | British Columbia
Royal Roads University | Victoria | British Columbia
Simon Fraser University | Burnaby | British Columbia
Thompson Rivers University | Kamloops | British Columbia
University of British Columbia | Vancouver | British Columbia
University of Northern British Columbia | Prince George | British Columbia
University of the Fraser Valley | Abbotsford | British Columbia
University of Victoria | Victoria | British Columbia
Vancouver Island University | Nanaimo | British Columbia
Brandon University | Brandon | Manitoba
University College of the North | The Pas | Manitoba
University of Manitoba | Winnipeg | Manitoba
University of Winnipeg | Winnipeg | Manitoba
Université de Saint-Boniface | Winnipeg | Manitoba
Mount Allison University | Sackville | New Brunswick
St. Thomas University | Fredericton | New Brunswick
University of New Brunswick | Fredericton | New Brunswick
Université de Moncton | Moncton | New Brunswick
Memorial University of Newfoundland | St. John's | Newfoundland and Labrador
Acadia University | Wolfville | Nova Scotia
Cape Breton University | Sydney | Nova Scotia
Dalhousie University | Halifax | Nova Scotia
Mount Saint Vincent University | Halifax | Nova Scotia
NSCAD University | Halifax | Nova Scotia
St. Francis Xavier University | Antigonish | Nova Scotia
Saint Mary's University | Halifax | Nova Scotia
Université Sainte-Anne | Church Point | Nova Scotia
University of King's College | Halifax | Nova Scotia
Algoma University | Sault Ste. Marie | Ontario
Brock University | St. Catharines | Ontario
Carleton University | Ottawa | Ontario
Lakehead University | Thunder Bay | Ontario
Laurentian University | Sudbury | Ontario
McMaster University | Hamilton | Ontario
Nipissing University | North Bay | Ontario
OCAD University | Toronto | Ontario
Ontario Tech University | Oshawa | Ontario
Queen's University at Kingston | Kingston | Ontario
Royal Military College of Canada | Kingston | Ontario
Toronto Metropolitan University | Toronto | Ontario
Trent University | Peterborough | Ontario
University of Guelph | Guelph | Ontario
University of Ottawa | Ottawa | Ontario
University of Toronto | Toronto | Ontario
University of Toronto Scarborough | Scarborough | Ontario
University of Waterloo | Waterloo | Ontario
Western University | London | Ontario
University of Windsor | Windsor | Ontario
Wilfrid Laurier University | Waterloo | Ontario
York University | Toronto | Ontario
University of Prince Edward Island | Charlottetown | Prince Edward Island
Bishop's University | Sherbrooke | Quebec
Concordia University | Montreal | Quebec
École de technologie supérieure | Montreal | Quebec
HEC Montréal | Montreal | Quebec
Institut national de la recherche scientifique | Quebec City | Quebec
McGill University | Montreal | Quebec
Polytechnique Montréal | Montreal | Quebec
Université de Montréal | Montreal | Quebec
Université de Sherbrooke | Sherbrooke | Quebec
Université du Québec à Chicoutimi | Chicoutimi | Quebec
Université du Québec à Montréal | Montreal | Quebec
Université du Québec à Rimouski | Rimouski | Quebec
Université du Québec à Trois-Rivières | Trois-Rivières | Quebec
Université du Québec en Abitibi-Témiscamingue | Rouyn-Noranda | Quebec
Université du Québec en Outaouais | Gatineau | Quebec
Université Laval | Quebec City | Quebec
University of Regina | Regina | Saskatchewan
University of Saskatchewan | Saskatoon | Saskatchewan
Yukon University | Whitehorse | Yukon
""".strip()

# Canadian province code -> full name (RCSA uses "QB" for Quebec).
PROVINCES = {"BC": "British Columbia", "ON": "Ontario", "QB": "Quebec", "QC": "Quebec",
             "AB": "Alberta", "MB": "Manitoba", "NB": "New Brunswick",
             "NL": "Newfoundland and Labrador", "NS": "Nova Scotia", "PE": "Prince Edward Island",
             "SK": "Saskatchewan", "YT": "Yukon", "NT": "Northwest Territories", "NU": "Nunavut"}

# --------------------------------------------------------------------------- aliases
# The RCSA scholar list and the IPEDS/Canada institution lists sometimes spell the
# same school differently (usually IPEDS's "-Main Campus" style names). Map the
# RCSA name -> the exact institution name here. If the script reports an UNMATCHED
# institution at the end, add a line here (RCSA name : official name) and re-run.
ALIASES = {
    # --- United States (RCSA name -> exact IPEDS name) --------------------------
    "Arizona State University": "Arizona State University Campus Immersion",
    "College of William & Mary": "William & Mary",
    "Colorado State University": "Colorado State University-Fort Collins",
    "Columbia University": "Columbia University in the City of New York",
    "Embry-Riddle Aeronautical University (Arizona)": "Embry-Riddle Aeronautical University-Prescott",
    "Georgia Institute of Technology": "Georgia Institute of Technology-Main Campus",
    "Humboldt State University": "California State Polytechnic University-Humboldt",
    "Hunter College, CUNY": "CUNY Hunter College",
    "Kent State University": "Kent State University at Kent",
    "Louisiana State University": "Louisiana State University and Agricultural & Mechanical College",
    "Miami University of Ohio": "Miami University-Oxford",
    "New Mexico State University": "New Mexico State University-Main Campus",
    "North Carolina State University": "North Carolina State University at Raleigh",
    "Ohio State University": "Ohio State University-Main Campus",
    "Pennsylvania State University": "Pennsylvania State University-Main Campus",
    "Purdue University": "Purdue University-Main Campus",
    "SUNY Potsdam": "SUNY College at Potsdam",
    "Stony Brook University SUNY": "Stony Brook University",
    "Texas A&M University": "Texas A&M University-College Station",
    "The City College of New York, CUNY": "CUNY City College",
    "Tulane University": "Tulane University of Louisiana",
    "University at Buffalo SUNY": "University at Buffalo",
    "University of Colorado Denver": "University of Colorado Denver/Anschutz Medical Campus",
    "University of Michigan": "University of Michigan-Ann Arbor",
    "University of Missouri": "University of Missouri-Columbia",
    "University of New Hampshire": "University of New Hampshire-Main Campus",
    "University of New Mexico": "University of New Mexico-Main Campus",
    "University of Oklahoma": "University of Oklahoma-Norman Campus",
    "University of Pittsburgh": "University of Pittsburgh-Pittsburgh Campus",
    "University of South Carolina": "University of South Carolina-Columbia",
    "University of Virginia": "University of Virginia-Main Campus",
    "University of Washington": "University of Washington-Seattle Campus",
    # --- Canada (RCSA name -> exact name in CANADA_UNIVERSITIES) ----------------
    "Queen's University": "Queen's University at Kingston",
    "University of Montreal": "Université de Montréal",
}

# Institutions that are not in IPEDS or the Canada list at all (research
# institutes, etc.). We geocode these by hand-provided query so they still appear.
FALLBACK_QUERY = {
    "Scripps Research Institute": "Scripps Research Institute, La Jolla, California, USA",
    "Research Foundation of CUNY- Advanced Science Research Center":
        "CUNY Advanced Science Research Center, New York",
}

# A few official names don't resolve well in the geocoder; give it a query that
# does. Keyed by the exact institution name being looked up (US or Canada list).
GEOCODE_OVERRIDE = {
    "Emily Carr University of Art and Design": "Emily Carr University, Vancouver, Canada",
    "Queen's University at Kingston": "Queen's University, Kingston, Ontario, Canada",
}


# =========================================================================== utils
def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def http_get(url: str, *, binary: bool = False, timeout: int = 90):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return raw if binary else raw.decode("utf-8", "replace")


def normalize(name: str) -> str:
    """Collapse a school name to a comparison key: lowercase, drop punctuation,
    unify '&'/'and' and 'saint'/'st', drop a leading 'the' and campus ' at '."""
    s = (name or "").lower().strip()
    s = s.replace("&", " and ").replace("’", "'")
    s = re.sub(r"\bsaint\b", "st", s)
    s = re.sub(r"\bst\.", "st", s)
    s = re.sub(r"^the\s+", "", s)
    s = s.replace(" at ", " ")
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


# =================================================================== geocode (cache)
class Geocoder:
    def __init__(self):
        self.cache = {}
        if os.path.exists(GEOCODE_CACHE):
            with open(GEOCODE_CACHE, encoding="utf-8") as fh:
                # ignore any stale nulls from older runs so they get retried
                self.cache = {k: v for k, v in json.load(fh).items() if v}
        self._last = 0.0
        self.new = 0

    def save(self):
        with open(GEOCODE_CACHE, "w", encoding="utf-8") as fh:
            json.dump(self.cache, fh, ensure_ascii=False, indent=1, sort_keys=True)

    def _query(self, query: str):
        # be polite: <=1 request/sec, per the Nominatim usage policy
        wait = 1.2 - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        params = urllib.parse.urlencode({"q": query, "format": "json", "limit": 1})
        try:
            data = json.loads(http_get(f"{NOMINATIM}?{params}", timeout=30))
        except Exception as exc:  # noqa: BLE001
            log(f"    ! geocode error for {query!r}: {exc}")
            data = []
        finally:
            self._last = time.time()
        if data:
            return {"lat": round(float(data[0]["lat"]), 5),
                    "lon": round(float(data[0]["lon"]), 5)}
        return None

    def lookup(self, key: str, query: str, *alts: str):
        """Geocode `query`, retrying (and falling back to the broader `alts`
        queries) on transient misses. Successful results are cached; failures are
        NOT cached, so a later re-run retries them."""
        if self.cache.get(key):
            return self.cache[key]
        # try the main query twice (transient misses), then each fallback once
        candidates = [query, query] + [a for a in alts if a and a != query]
        result = None
        for i, q in enumerate(candidates):
            result = self._query(q)
            if result:
                break
            if i < len(candidates) - 1:
                time.sleep(1.5)  # brief backoff before retrying
        if result:
            self.cache[key] = result
            self.new += 1
            self.save()  # persist as we go, so a crash never loses progress
        return result


# =================================================================== data: scholars
def fetch_scholars_online() -> list[dict]:
    log(f"  fetching scholars from {RCSA_DASHBOARD}")
    html = http_get(RCSA_DASHBOARD)
    m = re.search(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError("could not find the data island on the RCSA dashboard page")
    state = json.loads(m.group(1).strip())
    items = state["state"]["rcsaDataChart"]["items"]
    if not items:
        raise RuntimeError("RCSA dashboard returned an empty scholar list")
    return items


def load_scholars(offline: bool) -> list[dict]:
    if not offline:
        try:
            items = fetch_scholars_online()
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(RAW_SCHOLARS, "w", encoding="utf-8") as fh:
                json.dump(items, fh, ensure_ascii=False, indent=1)
            log(f"  {len(items)} scholars  (saved backup -> {os.path.relpath(RAW_SCHOLARS, ROOT)})")
            return items
        except Exception as exc:  # noqa: BLE001
            log(f"  ! online fetch failed ({exc}); falling back to committed backup")
    if not os.path.exists(RAW_SCHOLARS):
        raise SystemExit(f"no scholar data: {RAW_SCHOLARS} missing and online fetch unavailable")
    with open(RAW_SCHOLARS, encoding="utf-8") as fh:
        items = json.load(fh)
    log(f"  {len(items)} scholars  (from committed {os.path.relpath(RAW_SCHOLARS, ROOT)})")
    return items


# =============================================================== data: institutions
def find_ipeds_zip(explicit: str | None) -> bytes:
    if explicit:
        with open(explicit, "rb") as fh:
            return fh.read()
    for year in IPEDS_YEARS:
        url = IPEDS_URL.format(year=year)
        try:
            log(f"  fetching IPEDS {year} directory ...")
            raw = http_get(url, binary=True, timeout=120)
            if len(raw) > 10000:
                return raw
        except Exception as exc:  # noqa: BLE001
            log(f"    ! {year} unavailable ({exc})")
    raise SystemExit("could not download any IPEDS HD file; pass one with --ipeds PATH")


def _int(row: dict, key: str) -> int:
    try:
        return int(row.get(key, "") or -999)
    except ValueError:
        return -999


def _coords(row: dict):
    try:
        lat, lon = float(row["LATITUDE"]), float(row["LONGITUD"])
    except (KeyError, ValueError):
        return None
    if lat == 0 or lon == 0 or not (-90 < lat < 90) or not (-180 < lon < 0):
        return None
    return round(lat, 5), round(lon, 5)


# Carnegie 2021 Basic Classification (IPEDS "C21BASIC") -> the same compact
# institution vocabulary RCSA uses for scholar campuses, so every dot on the map
# sits on one scale. The mapping was validated by cross-tabulating it against
# RCSA's own institution_type label for all 209 Cottrell Scholar campuses:
# R1<->15, R2<->16, R3<->17, Comp<->18/19/20 and PUI<->21/22 line up almost
# perfectly. (Codes: 15 doctoral very-high research; 16 doctoral high research;
# 17 doctoral/professional; 18-20 master's; 14/21-23 baccalaureate; 1-13
# associate's / two-year; 24-33 special-focus, tribal, unclassified.)
def carnegie_type(code: int) -> str:
    if code == 15:               return "R1"
    if code == 16:               return "R2"
    if code == 17:               return "R3"
    if code in (18, 19, 20):     return "Comp"
    if code in (14, 21, 22, 23): return "PUI"
    if 1 <= code <= 13:          return "2 yr"
    if 24 <= code <= 33:         return "Special"
    return ""                    # -2 / not classified


# IPEDS INSTSIZE enrollment band, kept as the raw 1-5 code so the map can bucket
# and label it. Anything not reported (-1/-2) becomes None and is omitted.
#   1: <1,000   2: 1,000-4,999   3: 5,000-9,999   4: 10,000-19,999   5: 20,000+
def inst_size(code: int):
    return code if 1 <= code <= 5 else None


def load_us_institutions(ipeds_zip: bytes, include_2yr: bool) -> list[dict]:
    with zipfile.ZipFile(io.BytesIO(ipeds_zip)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        text = zf.read(name).decode("latin-1")
    import csv
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        if _int(row, "CYACTIVE") != 1 or _int(row, "DEGGRANT") != 1:
            continue
        if not include_2yr and _int(row, "ICLEVEL") != 1:  # 1 == 4-year
            continue
        coords = _coords(row)
        if not coords:
            continue
        out.append({"name": row["INSTNM"].strip(), "city": row["CITY"].strip(),
                    "state": row["STABBR"].strip(), "country": "US",
                    "lat": coords[0], "lon": coords[1],
                    "type": carnegie_type(_int(row, "C21BASIC")),
                    "size": inst_size(_int(row, "INSTSIZE"))})
    log(f"  {len(out)} US institutions from IPEDS "
        f"({'all degree-granting' if include_2yr else '4-year degree-granting'})")
    return out


def load_ca_institutions(geo: Geocoder) -> list[dict]:
    out = []
    for line in CANADA_UNIVERSITIES.splitlines():
        line = line.strip()
        if not line:
            continue
        name, city, prov = (p.strip() for p in line.split("|"))
        primary = GEOCODE_OVERRIDE.get(name, f"{name}, {city}, {prov}, Canada")
        hit = geo.lookup("CA::" + normalize(name), primary,
                         f"{name}, {city}, Canada", f"{city}, {prov}, Canada")
        if not hit:
            log(f"    ! could not geocode {name}; skipping")
            continue
        out.append({"name": name, "city": city, "state": prov, "country": "CA",
                    "lat": hit["lat"], "lon": hit["lon"],
                    "type": "Foreign", "size": None})
    log(f"  {len(out)} Canadian universities (geocoded)")
    return out


# =========================================================================== match
def aggregate_scholars(items: list[dict]) -> dict:
    """RCSA org name -> {records, type, state}. Cleans up obvious data typos."""
    groups: dict[str, dict] = {}
    for it in items:
        org = it["organization_name"].strip()
        g = groups.setdefault(org, {"records": [], "types": {}, "states": {}})
        g["records"].append({"name": it["full_name"], "year": it["year"],
                             "discipline": it["discipline"]})
        g["types"][it["organization_type"]] = g["types"].get(it["organization_type"], 0) + 1
        g["states"][it["organization_state"]] = g["states"].get(it["organization_state"], 0) + 1
    return groups


def build(args) -> None:
    os.makedirs(STATIC_DATA, exist_ok=True)
    geo = Geocoder()

    log("Scholars:")
    items = load_scholars(args.offline)
    groups = aggregate_scholars(items)

    log("Institutions:")
    base = load_us_institutions(find_ipeds_zip(args.ipeds), args.include_2yr)
    base += load_ca_institutions(geo)

    # Index institutions by normalized name (first spelling wins on rare collisions).
    index: dict[str, dict] = {}
    for inst in base:
        index.setdefault(normalize(inst["name"]), inst)

    log("Matching scholars to institutions:")
    # Attach scholar payloads onto the matched base institution (keyed by id()).
    scholars_by_inst: dict[int, dict] = {}
    used_alias, geocoded, unmatched = [], [], []

    for org, g in sorted(groups.items()):
        canonical = ALIASES.get(org, org)
        inst = index.get(normalize(canonical))
        if inst is None and canonical != org:
            used_alias.append(org)
        if inst is None:
            # Not in IPEDS/Canada — geocode a standalone dot so it still shows.
            state = max(g["states"], key=g["states"].get)
            country = "CA" if state in PROVINCES else "US"
            suffix = "Canada" if country == "CA" else "USA"
            place = PROVINCES.get(state, state)
            query = FALLBACK_QUERY.get(org, f"{org}, {place}, {suffix}")
            hit = geo.lookup("SCH::" + normalize(org), query,
                             f"{org}, {suffix}", f"{org}, {place}, {suffix}")
            if not hit:
                unmatched.append(org)
                continue
            inst = {"name": org, "city": "", "state": state, "country": country,
                    "lat": hit["lat"], "lon": hit["lon"], "_standalone": True}
            geocoded.append(org)
        elif ALIASES.get(org):
            used_alias.append(org)

        payload = scholars_by_inst.setdefault(
            id(inst), {"inst": inst, "records": [], "types": {}, "orgs": {}})
        payload["records"].extend(g["records"])
        payload["orgs"][org] = payload["orgs"].get(org, 0) + len(g["records"])
        for t, n in g["types"].items():
            payload["types"][t] = payload["types"].get(t, 0) + n

    # ---- assemble scholar-institution records --------------------------------
    scholar_insts = []
    scholar_ids = set()
    for payload in scholars_by_inst.values():
        inst = payload["inst"]
        scholar_ids.add(id(inst))
        recs = sorted(payload["records"], key=lambda r: (r["year"], r["name"]), reverse=True)
        inst_type = max(payload["types"], key=payload["types"].get) if payload["types"] else ""
        # Show the recognisable RCSA name (e.g. "Ohio State University", not the
        # IPEDS "Ohio State University-Main Campus"); keep the base coordinates.
        display = max(payload["orgs"], key=payload["orgs"].get) if payload["orgs"] else inst["name"]
        # Prefer RCSA's own type label; fall back to the matched IPEDS Carnegie
        # type for the rare campus RCSA left untyped. Enrollment size comes from
        # the matched IPEDS record (absent for standalone / Canadian campuses).
        rec = {"name": display, "city": inst["city"], "state": inst["state"],
               "country": inst["country"], "lat": inst["lat"], "lon": inst["lon"],
               "type": inst_type or inst.get("type", "")}
        if inst.get("size"):
            rec["size"] = inst["size"]
        rec["count"] = len(recs)
        rec["scholars"] = recs
        scholar_insts.append(rec)
    scholar_insts.sort(key=lambda x: (-x["count"], x["name"]))

    # ---- base colleges = every institution WITHOUT a current scholar ----------
    colleges = []
    for i in base:
        if id(i) in scholar_ids:
            continue
        rec = {"name": i["name"], "city": i["city"], "state": i["state"],
               "country": i["country"], "lat": i["lat"], "lon": i["lon"],
               "type": i.get("type", "")}
        if i.get("size"):
            rec["size"] = i["size"]
        colleges.append(rec)

    # ---- write ---------------------------------------------------------------
    years = [r["year"] for si in scholar_insts for r in si["scholars"] if r["year"]]
    meta = {
        "generated": _dt.date.today().isoformat(),
        "scholars_total": sum(si["count"] for si in scholar_insts),
        "scholar_institutions": len(scholar_insts),
        "colleges_total": len(colleges),
        "year_min": min(years) if years else None,
        "year_max": max(years) if years else None,
        "sources": {
            "scholars": RCSA_DASHBOARD,
            "us_institutions": "IPEDS, US Dept. of Education (nces.ed.gov/ipeds)",
            "ca_institutions": "List of universities in Canada (Wikipedia), geocoded via OpenStreetMap",
            "basemap_tiles": "OpenStreetMap contributors",
        },
    }
    _write(os.path.join(STATIC_DATA, "colleges.json"), colleges)
    _write(os.path.join(STATIC_DATA, "scholars.json"), scholar_insts)
    _write(os.path.join(STATIC_DATA, "meta.json"), meta)
    geo.save()

    # ---- report --------------------------------------------------------------
    log("")
    log("=" * 68)
    log(f"  scholars ............... {meta['scholars_total']}")
    log(f"  scholar institutions ... {meta['scholar_institutions']}")
    log(f"  base colleges .......... {meta['colleges_total']}")
    log(f"  years .................. {meta['year_min']}–{meta['year_max']}")
    log(f"  aliases used ........... {len(set(used_alias))}")
    log(f"  geocoded (not in IPEDS)  {len(geocoded)}: {', '.join(geocoded) or '-'}")
    if geo.new:
        log(f"  new geocodes cached .... {geo.new}")
    if unmatched:
        log("")
        log("  !! UNMATCHED institutions (they will NOT appear on the map):")
        for org in unmatched:
            log(f"       - {org!r}")
        log("     Add an alias for each in ALIASES (scripts/build_map_data.py) and re-run.")
    else:
        log("  unmatched .............. 0  ✓ every scholar is on the map")
    log("=" * 68)
    log(f"wrote {os.path.relpath(STATIC_DATA, ROOT)}/colleges.json, scholars.json, meta.json")


def _write(path: str, obj) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the Cottrell Scholars map data.")
    ap.add_argument("--offline", action="store_true",
                    help="use committed data/cottrell_scholars.json instead of fetching")
    ap.add_argument("--ipeds", metavar="PATH", help="path to an IPEDS HDxxxx.zip to use")
    ap.add_argument("--include-2yr", action="store_true",
                    help="include 2-year / community colleges in the base map")
    build(ap.parse_args())


if __name__ == "__main__":
    main()
