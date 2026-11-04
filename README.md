# dep-gate

Looks up every package your project declares (and every name you give it) in npm and PyPI **before anything is installed**, and tells you which ones do not exist, are brand new, run a script on install, are deprecated, or look like a typo of a famous package.

```
npx github:tick-ai/dep-gate
```

```
$ npx github:tick-ai/dep-gate
npm:fresh-thing warn new first published 2026-05-28T09:14:02.511Z (3 days before 2026-06-01T00:00:00.000Z), less than 30 days
npm:fresh-thing warn install-script version 0.1.0 runs a command when installed (postinstall: node setup.js)
npm:left-pad warn deprecated version 1.3.0 is deprecated: use String.prototype.padStart()
npm:lodahs error missing lodahs does not exist on npm
npm:lodahs warn lookalike name is one edit away from the well-known package lodash
pypi:reqeusts error missing reqeusts does not exist on PyPI
pypi:reqeusts warn lookalike name is one edit away from the well-known package requests
dep-gate: 5 packages, 2 errors, 5 warnings, 0 info, 0 not checked
```

The exit code is `1` (two errors), so a CI step that runs it fails. Nothing was installed: dep-gate only reads the registries' documents.

(This output was produced by running the tool on a small project with offline `file://` registry fixtures, with `--now 2026-06-01`; against the real registries the first lines depend on what is published at the time.)

## Why

Coding agents add dependencies in seconds, and some of the names they write do not exist yet. That is how an invented or mistyped name becomes a package someone registers with malware in it: the next `npm install` or `pip install` fetches it. Other additions are real but risky: a package published last week, one that runs a script the moment it is installed, one that is deprecated, one whose name is a typo of a famous package.

dep-gate is the command a team puts in CI: one command, exact findings, few false alarms.

## Run it

Plain Node 22, nothing to install.

```
npx github:tick-ai/dep-gate                  # check the current directory
npx github:tick-ai/dep-gate path/to/project  # a folder, a package.json or a requirements .txt
npx github:tick-ai/dep-gate --pkg left-pad --pkg pypi:requests
node dep-gate.mjs ...                        # the same, from a clone of this repository
```

dep-gate is not on npm yet, so `npx dep-gate` does not work; use the `github:` form above or a clone.

```
node dep-gate.mjs [path] [--pkg <name>]... [--registry <url>] [--pypi <url>] [--min-age <days>]
                  [--now <ISO time>] [--fail-on error|warn|info|none] [--json]
```

Every option that takes a value is written `--option value` (two arguments); `--option=value` is an unknown option. A value is missing when there is no next argument or the next one starts with `--`. Options may come before or after the path. A repeated option other than `--pkg` takes its last value. `--help` (or `-h`) prints the usage and exits 0.

### What is checked

* **`path`** (at most one). A folder: its `package.json` and its `requirements.txt` are both read, whichever exist. A file: read as `package.json` when its name is `package.json`, as a requirements file when its name ends in `.txt`. With no `path` and no `--pkg`, the path is `.`. With no `path` and at least one `--pkg`, no file is read.
* **`--pkg <name>`** (repeatable): an npm package. `--pkg pypi:<name>` is a PyPI package; `--pkg npm:<name>` is the same as `--pkg <name>`.
* **`package.json`**: the keys of `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`. An `npm:` alias (`"foo": "npm:bar@^1"`) looks up the real package (`bar`). Specs that do not come from the registry (`file:`, `link:`, `workspace:`, `git:`, `git+…:`, `github:`, `gitlab:`, `bitbucket:`, `http(s):`, `portal:`, `patch:`, `exec:`, anything containing a `/` such as `user/repo`, and non-string specs) are skipped and counted in `skipped`.
* **`requirements.txt`**: backslash continuations are joined, comments (`#` at the start of a line or after whitespace) and environment markers (from the first `;`) are cut, option lines (starting with `-`) are ignored, extras (`name[extra]`) are dropped, and a name may be followed by a version operator (`===`, `==`, `~=`, `!=`, `>=`, `<=`, `>`, `<`). Lines that are not a plain requirement (URLs, paths, `name @ url`) are skipped and counted. PyPI names are normalised (`Python_Dateutil` is `python-dateutil`).

The version a requirement pins is never looked up: dep-gate judges the package's **latest** version.

### Registries

* `--registry <url>`: npm, default `https://registry.npmjs.org`.
* `--pypi <url>`: PyPI JSON API, default `https://pypi.org/pypi`.
* A URL must start with `http://`, `https://` or `file://`.
* `http(s)`: npm is `GET <registry>/<name>` (the `/` of a scoped name written `%2f`), PyPI is `GET <pypi>/<name>/json`. A `200` with a JSON object is the document; a `404` means the package does not exist; anything else, a network error or a wait of more than 30 seconds means the registry could not be reached for that package. At most 8 lookups are in flight at once.
* `file://<folder>`: the document of `<name>` is the file `<folder>/<name>.json` (`<folder>/@scope/name.json` for a scoped name). A missing file means the package does not exist. This form runs offline, which is handy in CI and in tests.

## What it finds

Each finding has a `kind`, a `severity` and a `message`. A package that exists gets these, in this order; a package that does not exist gets only `missing` and `lookalike`.

| kind | severity | meaning |
| --- | --- | --- |
| `missing` | error | The package does not exist (HTTP 404, a missing file, or a name that cannot be a package name). This is the one that matters most: an invented name is a name someone can register. |
| `new` | warn | First published less than `--min-age` days (default 30) before `--now`. Exactly `--min-age` days old is not new. The message holds the age; `created` and `ageDays` are in the JSON. |
| `install-script` | warn | npm only. The latest version has a `preinstall`, `install` or `postinstall` script: installing it runs that command. One finding per package, holding the commands. Other scripts and older versions are not findings. |
| `deprecated` | warn | npm only. The latest version is deprecated; the message holds the deprecation text. A deprecated older version is not a finding. |
| `lookalike` | warn | The name is one edit (insert, delete, replace, swap of neighbours) from a well-known package and is not itself well-known. Applies to packages that are found or missing, and holds the well-known name. Well-known names shorter than 5 characters are never matched. The lists (127 npm names, 88 PyPI names) are in `dep-gate.mjs`. |
| `no-repository` | info | npm: the latest version declares no repository. PyPI: no home page and no project URL. |

Not findings: a package that is old, popular, unscoped, or has no `scripts`; anything about an older version; anything about a version a requirement pins.

## Output

### Plain

One line per finding, beginning with `<registry>:<name>`, then the severity, the kind and the message:

```
npm:lodahs warn lookalike name is one edit away from the well-known package lodash
```

A package that could not be looked up gets `not checked: <registry>:<name> (<reason>)`, and a line on stderr names every package that was not checked. Last comes a summary line starting with `dep-gate:` with the number of packages, errors, warnings, info findings and packages not checked (and the number of skipped entries, when there are any). With nothing found, the summary alone is printed.

### `--json`

Exactly one JSON object on stdout:

```json
{
  "tool": "dep-gate",
  "version": "0.1.0",
  "now": "2026-06-01T00:00:00.000Z",
  "minAge": 30,
  "skipped": 0,
  "packages": [
    {
      "name": "lodahs",
      "registry": "npm",
      "version": "1.0.0",
      "status": "found",
      "sources": ["dependencies"],
      "findings": [
        { "kind": "lookalike", "severity": "warn", "message": "...", "of": "lodash" }
      ]
    }
  ],
  "unchecked": [],
  "counts": { "error": 0, "warn": 1, "info": 0 }
}
```

* `now` is the clock used; `--now` takes an ISO time (`2026-06-01`, `2026-06-01T12:00`, `2026-06-01T12:00:00Z`, `2026-06-01T12:00:00+02:00`; no zone means UTC). Useful to make a run repeatable.
* `minAge` is `--min-age`, a number of days written with digits, optionally with a decimal part (`0`, `7`, `0.5`).
* `skipped` counts the `package.json` entries and requirements lines that were skipped.
* `packages` lists every package, npm first and then PyPI, each group sorted by name. `version` is the latest version looked at (or `null`). `status` is `found`, `missing`, or `unchecked` (the registry could not be reached; then `version` is `null`, there are no findings and a `reason` string says why). `sources` are the places it came from, among `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `requirements.txt` and `--pkg`.
* Extra fields on findings: `new` has `created` and `ageDays`; `install-script` has `scripts`; `deprecated` has `deprecated`; `lookalike` has `of`.
* `unchecked` is `"<registry>:<name>"` for each unchecked package; `counts` is the number of findings of each severity.

With `--json` the object is printed whatever the exit code, except for a usage error (2).

## Exit codes

| code | meaning |
| --- | --- |
| `0` | No finding at or above `--fail-on`. |
| `1` | A finding at or above `--fail-on` (`info` < `warn` < `error`; default `error`; `none` never fails on findings). |
| `2` | Usage error: unknown option, option with its value missing, bad `--fail-on`, `--min-age`, `--now` or registry URL, more than one path, a path that does not exist, a folder with neither `package.json` nor `requirements.txt` (when no `--pkg`), a file that is neither `package.json` nor `.txt`, a `package.json` that is not a JSON object, or `--pkg` with an empty name. A message goes to stderr and nothing to stdout. |
| `3` | At least one package could not be checked. This wins over 0 and 1: the answer is not complete. |

## In CI (GitHub Actions)

```yaml
name: dep-gate
on: [pull_request]

jobs:
  dep-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # exits 1 on a missing package (error); use --fail-on warn to also stop new, install-script,
      # deprecated and lookalike packages. Exit 3 means a registry could not be reached.
      - run: npx github:tick-ai/dep-gate --fail-on warn
```

## What it does not do

* It does not read lock files, only `package.json` and requirements files.
* It does not judge pinned versions: a requirement's pin is never looked up; dep-gate judges the latest version of the package.
* It does not evaluate environment markers: a requirement is checked whatever its marker says.
* It cannot tell a malicious package from a harmless one. It reports facts about the registry's document (does it exist, how old, what scripts, is it deprecated, how close is its name to a famous one); a clean run is not a proof of safety, and a finding is not a proof of malice.
* It never installs, runs or downloads a package, and it only follows `http(s)` URLs you give it as registries (the default ones are npm and PyPI).

## Where it came from

Built by agents on TickHub, as TickHub job `516dc1a5-f2c6-49bc-91dc-1e07a5cd0379`. The job, the hand-ins and the receipt are on TickHub's public log: https://tick.company/hub/#/job/516dc1a5-f2c6-49bc-91dc-1e07a5cd0379. `docs/the-job.md` is the job as it was given.

AI does the work. Tick makes it trustworthy. https://tick.company

## Licence

Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.
