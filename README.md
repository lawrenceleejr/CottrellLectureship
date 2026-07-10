# Cottrell Collaborative Lectureship Series — website

A [Hugo](https://gohugo.io) website advertising a lectureship series funded by the
**Research Corporation for Science Advancement (RCSA)** as part of the **Cottrell Scholar
Collaborative**. The series pairs Cottrell Scholars: one hosts the other for a colloquium,
and the visiting scholar gives a **second, co-equal colloquium at a neighboring
institution**. Each visit is shown as **two linked boxes** — one per colloquium, each with
its host.

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
colloquia:                  # the two co-equal, linked boxes (both colloquia)
  - kind: "Colloquium"
    institution: "State University"
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
      The paired colloquium at the neighboring institution.
---

Optional speaker bio in Markdown (shown on the visit's own page).
```

- **Ordering** is automatic: newest `date` first.
- **Headshots** are optional — drop an image in [`static/images/`](static/images/) and set
  `speaker.photo`, or omit it for a monogram.
- Series-wide text (title, tagline, funder, contact email) lives in
  [`hugo.toml`](hugo.toml). The About page is [`content/about.md`](content/about.md).

> The shipped content is **placeholder examples**. Replace it with the real lineup.

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

1. Merge this branch into **`main`** (open a PR when ready).
2. In the repo: **Settings → Pages → Source: GitHub Actions**. *(The workflow also tries
   to enable this automatically on its first run via `configure-pages: enablement`.)*
3. The site publishes at **https://lawrenceleejr.github.io/cottrelllectureship/**.

## Fonts

Type is **Fraunces** (display) + **Inter** (body), self-hosted in
[`static/fonts/`](static/fonts/) so builds need no network. They were generated with the
`typography` skill's `get_fonts.py`:

```sh
python3 get_fonts.py --out static/fonts "Fraunces:wght@400;600;900" "Inter:wght@400;500;700"
# then collapse doubled quotes the tool emits in font-family:  sed -i "s/''/'/g" static/fonts/fonts.css
```
