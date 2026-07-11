# Cottrell Lectureship Series — website

A [Hugo](https://gohugo.io) website advertising a lectureship series funded by the
**Research Corporation for Science Advancement (RCSA)** as **a Cottrell Collaborative
project**. Each visit brings a **teacher-scholar** to a region to give **two talks** in a
single trip — one hosted by a Cottrell Scholar, the other by a regional partner at a nearby
college or university. Each visit is shown as **two linked boxes** — one per talk, each
with its host.

Built with the skills in <https://github.com/lawrenceleejr/skills_larry> (`static-site`,
`typography`, `git-workflow`, `docker-run`).

## Add or edit a visit

Each visit is **one Markdown file** in [`content/lectures/`](content/lectures/). Copy an
existing example and edit the front matter — all the details live there:

```yaml
---
title: "Dr. Jane Rivera — Spring 2026 Colloquia"
date: 2026-03-12            # SORT KEY: pairs are shown newest first. Use the primary colloquium's date.
speaker:                    # exactly one speaker per pair
  name: "Dr. Jane Rivera"
  affiliation: "University of the Midwest"
  role: "Cottrell Scholar 2021"
  field: "Physical Chemistry"
  photo: "/images/rivera.jpg"   # OPTIONAL — omit for an initials monogram
  website: "https://example.edu/rivera"
colloquia:                  # the two linked talks (one per host)
  - kind: "Colloquium"
    institution: "State University"
    coords: [40.00, -83.02]   # OPTIONAL — [lat, lon] to pin this host on the map; omit to
                              # place it by matching the institution name to the map data
    host: { name: "Dr. Alex Chen", role: "Cottrell Scholar 2019", affiliation: "State University" }
    title: "Watching Molecules Move in Real Time"
    date: 2026-03-12T16:00:00
    location: "Chemistry Building, Room 100"
    link: "https://example.edu/colloquium"   # optional
    abstract: |
      One or more paragraphs describing the colloquium.
  - kind: "Colloquium"
    institution: "Riverside Liberal Arts College"
    host: { name: "Dr. Blair Okafor", role: "Cottrell Scholar 2020", affiliation: "Riverside Liberal Arts College" }
    title: "Watching Molecules Move in Real Time"
    date: 2026-03-13T15:00:00
    location: "Science Center Auditorium"
    abstract: |
      The paired talk at the nearby institution.
---

Optional speaker bio in Markdown (shown on the visit's own page).
```

- **Ordering** is automatic: newest `date` first.
- **Map pins** — each host institution is flagged on the [Map](content/map.md) with a teal
  pin. It's placed automatically when the `institution` name matches a campus in the map
  data; otherwise, or to override, give the colloquium an explicit `coords: [lat, lon]`.
- **Headshots** are optional — drop an image in [`static/images/`](static/images/) and set
  `speaker.photo`, or omit it for a monogram.
- Series-wide text (title, tagline, funder, contact email) lives in
  [`hugo.toml`](hugo.toml). The About page is [`content/about.md`](content/about.md).

> The shipped content is **placeholder examples**. Replace it with the real lineup.

## The Scholars & Institutions map

The [**Map**](content/map.md) page (`/map/`) plots **every college and university in the US
and Canada** as a dot, and highlights — in terracotta — every institution that is home to a
**Cottrell Scholar**. It's a quick way to see which nearby campuses could pair up for a
collaborative lectureship. Institutions that have **hosted a visit** in the series carry a
prominent **teal pin** on top, whose popup links back to the talks. Click any dot for
details (a scholar campus lists its scholars, their award years and disciplines); the legend
toggles each layer — hosts, scholar campuses, and the grey college dots — on or off. The map is [Leaflet](https://leafletjs.com), self-hosted in
[`static/vendor/leaflet/`](static/vendor/leaflet/) (no CDN); only the background map tiles
load from the network at view time.

### Update the scholars each year (one command)

The scholar list comes straight from RCSA's
[awardee dashboard](https://rescorp.org/cottrell-scholars/awardee-dashboard/). To refresh it:

```sh
python3 scripts/build_map_data.py     # needs Python 3 + internet; no extra packages
git add data static && git commit -m "Refresh Cottrell Scholars map data" && git push
```

That single script pulls the current scholars, pulls the US institution list from
[IPEDS](https://nces.ed.gov/ipeds/datacenter/), geocodes the Canadian universities (cached
after the first run), matches every scholar to a campus, and rewrites the three data files
the map reads. It prints a summary and — importantly — **names any institution it couldn't
recognise** so nothing silently vanishes from the map.

Handful of useful flags: `--offline` (skip the network and use the saved
`data/cottrell_scholars.json`, which you can also hand-edit), `--include-2yr` (also show
two-year / community colleges), `--ipeds PATH` (use an IPEDS `HDxxxx.zip` you downloaded).

### If the script reports an unrecognised institution

RCSA occasionally spells a school differently from IPEDS (e.g. `Ohio State University` vs.
IPEDS's `Ohio State University-Main Campus`). Add one line to the `ALIASES` map near the top
of [`scripts/build_map_data.py`](scripts/build_map_data.py) mapping the RCSA name to the
official one, then re-run. New Canadian universities go in the `CANADA_UNIVERSITIES` list in
the same file. Everything is plain data at the top of one script — no other files to touch.

### What gets written (all committed, so the site build needs no network)

| File | What it is |
| --- | --- |
| [`static/data/scholars.json`](static/data/) | scholar campuses + the scholars at each (the terracotta dots) |
| [`static/data/colleges.json`](static/data/) | every other US + Canada college/university (the grey dots) |
| [`static/data/meta.json`](static/data/) | counts, year range and build date shown under the map |
| [`data/cottrell_scholars.json`](data/) | the raw scholar list pulled from RCSA (durable backup / hand-edit source) |
| [`scripts/geocode_cache.json`](scripts/) | cached lat/lon so re-runs are fast and coordinates stay stable |

## Run locally

Uses Docker (Hugo Extended, pinned) with a host fallback — see [`run.sh`](run.sh):

```sh
./run.sh serve     # live-reload dev server at http://localhost:1313/
./run.sh build     # one-off build into ./public
FORCE_HOST=1 ./run.sh build   # use a locally-installed hugo instead of Docker
```

## Build & deploy (GitHub Pages)

CI is [`.github/workflows/pages.yml`](.github/workflows/pages.yml):

- **Every push / PR builds** the site (a check on any branch).
- **Only `main` deploys** to GitHub Pages.

To publish:

1. In the repo: **Settings → Pages → Source: GitHub Actions** (one-time).
2. Merge this branch into **`main`** (open a PR when ready).
3. The site publishes at **https://lawrenceleejr.github.io/CottrellLectureship/**.

Feature-branch builds stay green even before step 1: `configure-pages` is best-effort
(`continue-on-error`), and the build falls back to the `baseURL` in `hugo.toml`. On `main`,
`configure-pages` supplies the authoritative Pages URL.

## Fonts

Type is a **single typeface — Fraunces** — used across the whole site at two weights
(400 for text, 600 for headings and emphasis). Hierarchy comes from size, italic, and
tracking rather than a second family. It is self-hosted in
[`static/fonts/`](static/fonts/) so builds need no network, and was generated with the
`typography` skill's `get_fonts.py`:

```sh
python3 get_fonts.py --out static/fonts "Fraunces:wght@400;600"
# then collapse doubled quotes the tool emits in font-family:  sed -i "s/''/'/g" static/fonts/fonts.css
```
