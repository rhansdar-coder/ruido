# How to put this online

Written for someone who has never pushed a repository. Every command is
copy-paste. If a step fails, read the troubleshooting section at the bottom
before changing anything.

**Two routes.** The one below is GitHub Pages: free, permanent URL, and it runs
the test suite on every push. There is also a built-in one-command publish in
this app that hands you a shareable link without installing anything — useful if
you want the site live before setting up a GitHub account. The artifact it
publishes is the same `_site/` that Step 0 builds.

**What is already done.** The repository is initialised — `git init` has run and
the branch is already `main`. Git is installed. You do not need to run `git init`
again. Only some files are staged so far; Step 4 stages everything, which is the
normal way to do a first commit.

---

## Step 0 · Prove the site you are about to publish is complete

Do this before pushing, not after. The dashboard loads each network's figures
with `fetch`, and if one of those files is missing from the deployed copy the
page does not break — it keeps whatever number was last painted and looks
perfectly healthy. A stale figure that looks live is the one failure this
project cannot afford, because the entire method is "these numbers are current".

```bash
npm run site:check   # verify the manifest against app.js, write nothing
npm run site         # assemble _site/ — exactly what gets published
```

`npm run site` derives the file list from the paths `app.js` actually fetches,
so it refuses to build when a measurement the dashboard loads is absent. It also
fails if a `data/measurement*.json` exists that nothing loads, because a claim
no page reads is not a published claim. Both cases are tested (`tests/site.test.mjs`),
so the guard cannot be removed without a red test.

The site is **two pages** and both ship: `index.html` is the landing and
`app.html` is the instrument, and each links to the other. `_site/` is a build
output — it is in `.gitignore` and it is wiped and rewritten on every `npm run
site`. Editing a page and publishing without re-running the build publishes the
previous version of that page, which is the same silent failure as a missing
measurement and looks exactly as healthy. This is not hypothetical: a fix to the
hero's noise band was in the source and still visible on the served site, because
`_site/app.js` had not been rebuilt.

---

## Step 1 · Tell git who you are

Git stamps every commit with a name and an email. Without this it refuses to
commit. Run these once, with your real details — this becomes public.

```bash
git config user.name "Tu Nombre"
git config user.email "tu@email.com"
```

## Step 2 · Create a GitHub account

If you have one, skip this. Otherwise: github.com → Sign up. Free is fine.

Username advice, since it is hard to change later: pick something you would be
happy to see next to a project in two years. Avoid a name tied to one token.

## Step 3 · Create the repository on GitHub

1. github.com → the **+** button, top right → **New repository**
2. **Repository name:** `ruido`
3. **Public** — required for free GitHub Pages, and for a project whose whole
   pitch is that its numbers are reproducible
4. **Leave every checkbox empty.** Do not add a README, .gitignore or license —
   the project already has all three, and ticking them creates a conflict you
   would have to resolve before your first push.
5. **Create repository**

Leave that page open. It shows a URL like:

```
https://github.com/TU_USUARIO/ruido.git
```

## Step 4 · Connect and push

Back in the terminal, in the `ruido` folder. Replace `TU_USUARIO` with yours.

```bash
git add -A
git commit -m "Ruido v0.1: anonymity measurement and cover traffic"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/ruido.git
git push -u origin main
```

What each line does:

- `git add -A` — stages every file. Already done once, run again to pick up new ones.
- `git commit` — saves a snapshot locally, with a message describing it.
- `git branch -M main` — makes sure the branch is called `main`.
- `git remote add` — tells git where "origin" (GitHub) is.
- `git push -u origin main` — uploads. `-u` remembers the pairing so future
  pushes are just `git push`.

GitHub will ask for credentials. It no longer accepts your account password —
it wants either a **Personal Access Token** or a browser login. If a window
opens, log in there. If it asks for a password in the terminal, you need a
token: GitHub → Settings → Developer settings → Personal access tokens → Tokens
(classic) → Generate new token → tick `repo` → generate → paste that as the
password.

## Step 5 · Turn on the public site

1. Your repo on GitHub → **Settings** → **Pages** (left sidebar)
2. Under **Source**, choose **GitHub Actions** — not "Deploy from a branch"
3. **Then trigger the workflow.** This step is not optional, and it is the one
   everybody skips. Choosing the source only tells Pages *where* to look; it does
   not deploy anything. If you have not pushed since turning it on, the site is
   still a 404 and the only run you can see is an older one that failed for want
   of the setting. Go to **Actions** → *Deploy dashboard to Pages* → **Run
   workflow**, or re-run the failed run. One click.

From then on the workflow runs on every push to `main` and publishes the
dashboard.

The workflow does not list the files itself. It calls `node scripts/build-site.mjs`
— the same script Step 0 runs — so what you verified locally is byte-for-byte
what CI publishes. If that script fails in CI, the deploy stops rather than
shipping an incomplete site.

It also runs `npm test` **before** building, and the build waits on it. A deploy
that goes green over a red suite is the same class of failure as a stale figure:
it looks healthy. This paragraph described that check before the workflow
actually had it, which is exactly the kind of claim this project is supposed to
refuse to make — so the workflow was fixed rather than the sentence.

To check that yourself without waiting for CI, run the suite against a clean
checkout of exactly what you are about to push:

```bash
git checkout-index -a -f --prefix=/tmp/clean-clone/
cd /tmp/clean-clone && npm test
```

To find the URL: **Actions** tab → the latest run → it prints the address at the
top of the deploy step. It looks like:

```
https://TU_USUARIO.github.io/ruido/
```

First deploy takes a minute or two. Reload the page after that.

## Step 6 · Check it

```bash
npm test             # 223 tests must pass
npm run verify:journey   # the four steps over real HTTP, with a spawned provider
npm run measure      # prints M1, M3, anonymity sets, cost per bit
npm run web          # dashboard at http://127.0.0.1:8080
```

If the public site and your local dashboard disagree, something is wrong — they
run identical code. That is the point of the layout.

---

## Optional · publish to npm

The name `ruido` is free on npm (checked 2026-09-11).

`package.json` currently has `"private": true`, which makes `npm publish` refuse
to run. That is deliberate: it stops an accidental publish. When you actually
want to publish, remove that line, then:

```bash
npm login
npm publish --access public
```

Do this only when the version number means something. npm versions are
permanent — you cannot overwrite one, only publish the next.

---

## What not to do

- **Never commit a key.** Ruido never touches a pool key, and the fastest way to
  break that promise is a stray `.env` or `.key` file. `.gitignore` already
  blocks the obvious ones.
- **Do not force-push** (`git push --force`) once other people can see the repo.
- **Do not put a seed phrase anywhere near this folder.**

## Troubleshooting

**"Author identity unknown"** → Step 1 was skipped.

**"failed to push, fetch first"** → GitHub created a file you do not have
(usually because a checkbox in Step 3 was ticked). Fix:
```bash
git pull --rebase origin main
git push -u origin main
```

**Pages shows 404** → Two causes, and they look identical from the outside.

*No deployment has run.* Enabling Pages does not deploy anything — the source
setting only says where to look. If the only run in the Actions tab is older than
the moment you enabled Pages, nothing has been deployed since. Go to **Actions** →
*Deploy dashboard to Pages* → **Run workflow**.

*A deployment ran and failed.* Open it and read which job failed. `deploy`
failing while `test` and `build` are green means Pages was not enabled yet when
it ran; fix the setting and re-run. If `test` itself is red, that is a real
failure and nothing should be published — that is the check working.

**The dashboard is blank** → You opened `index.html` by double-clicking. That
will not work; ES modules cannot load from `file://`. Use `npm run web`, which
serves both pages.

**A change you made is not on the site** → You are looking at `_site/`, or at a
deployed copy built before the change. `_site/` is a build output: run
`npm run site` and reload. This is the one that wastes the most time, because a
stale artifact renders perfectly and the fix looks like it did nothing.

**One network shows old numbers, the rest are fine** → That network's
`data/measurement*.json` did not make it into the artifact. This is the silent
one: nothing looks broken. Run `npm run site:check`; it names the file.

**"command not found: npm"** → Node is not installed or the terminal was opened
before installing it. Close and reopen the terminal.
