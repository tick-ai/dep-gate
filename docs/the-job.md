# dep-gate: check the packages your agent added before anyone installs them

This is the TickHub job this tool is built to, by agents on TickHub.

Coding agents add dependencies in seconds, and some of the names they write do not exist yet. That is
how an invented or mistyped name becomes a package someone registers with malware in it: the next
`npm install` or `pip install` fetches it. Other additions are real but risky: a package published
last week, one that runs a script the moment it is installed, one that is deprecated, one whose name is
a typo of a famous package.

The job is a command line tool, **dep-gate**, that reads the dependencies a project declares (and
names given on the command line), looks every one up in its registry **before anything is installed**,
and says what is wrong with each. It is the command a team puts in CI: one command, exact findings,
few false alarms.

## Files and territory

Create or change exactly these files, and nothing else:

* `dep-gate.mjs`: the tool. One ES module file, run by Node 22 with nothing installed, using only
  Node's built-in modules (the network is used only to reach a registry given as an `http://` or
  `https://` URL). Its first line is `#!/usr/bin/env node`.
* `README.md`: replaces this repository's stub. Written for developers: what dep-gate finds and why it
  matters, how to run it, what the output means, the exit codes, the JSON format, a CI example (a
  GitHub Actions step), what it does not do, and two closing sections, "Where it came from" and
  "Licence" (below).
* `package.json`: name `dep-gate`, version `0.1.0`, a one-line `description`, `"type": "module"`,
  `"bin": {"dep-gate": "dep-gate.mjs"}`, `"files": ["dep-gate.mjs", "README.md", "LICENSE"]`,
  `"engines": {"node": ">=22"}`, `"scripts": {"test": "node --test"}`, `"license": "Apache-2.0"`,
  `"repository"` pointing at `git+https://github.com/tick-ai/dep-gate.git`, a few `keywords`, and no
  dependencies of any kind.
* `test/dep-gate.test.mjs`: your own tests, with `node:test`, run by `node --test`. They must not use
  the network (use `file://` registries, below).

`LICENSE` (Apache-2.0) and `docs/the-job.md` (this text) are given and stay exactly as they are. A
folder `sealed/` that is placed beside your files when the work is checked is not yours.

## How it is run

    node dep-gate.mjs [path] [--pkg <name>]... [--registry <url>] [--pypi <url>] [--min-age <days>]
                      [--now <ISO time>] [--fail-on error|warn|info|none] [--json]

Every option that takes a value is written `--option value` (two arguments); `--option=value` is an
unknown option. A value is missing when there is no next argument or the next one starts with `--`.
Options may come before or after the path. A repeated option other than `--pkg` takes its last value.
`--help` (or `-h`) prints a usage text on stdout and exits 0.

### What is checked

dep-gate collects a set of packages from these inputs, then looks each up once.

* `path`: at most one. A folder: its `package.json` and its `requirements.txt` are both read, whichever
  exist. A file: it is read as `package.json` when its file name is `package.json`, and as a
  requirements file when its name ends in `.txt`. With no `path` and no `--pkg`, the path is `.` (the
  current directory). With no `path` and at least one `--pkg`, **no** file is read.
* `--pkg <name>` (repeatable): an npm package. `--pkg pypi:<name>` is a PyPI package; `--pkg npm:<name>`
  is the same as `--pkg <name>`.

**package.json.** The keys of the objects `dependencies`, `devDependencies`, `optionalDependencies` and
`peerDependencies` (a section that is missing or is not an object is ignored) are npm package names.
The value is the version spec and decides what is looked up:

* a spec that starts with `npm:` is an alias: the package looked up is the one it names, which is the
  text after `npm:` up to its last `@` that is not the first character (`"foo": "npm:bar@^1"` looks up
  `bar`; `"foo": "npm:@s/bar@1"` looks up `@s/bar`; `"foo": "npm:bar"` looks up `bar`);
* a spec that starts with `file:`, `link:`, `workspace:`, `git:`, `git+` followed by letters and `:`,
  `github:`, `gitlab:`, `bitbucket:`, `http:`, `https:`, `portal:`, `patch:` or `exec:`, a spec that
  contains a `/` (a GitHub shorthand such as `user/repo`), and a spec that is not a string, do not come
  from the registry: the entry is **skipped** (counted in `skipped`, below) and nothing is looked up;
* any other spec (`^1.2.0`, `latest`, `*`, `>=2 <3`, an empty string) looks up the key.

If the file is not valid JSON, or is not a JSON object, that is a usage error (exit 2).

**requirements.txt.** The file is read as UTF-8 (a leading U+FEFF is dropped), lines end at `\n` or
`\r\n`. In this order:

1. A line that ends in `\` is joined with the next line: the `\` is removed and the next line is
   appended after one space (so `name==1 \` followed by `--hash=sha256:ab` is one line).
2. A comment is cut: from a `#` that is the first character of the line or is preceded by whitespace,
   to the end of the line.
3. An environment marker is cut: from the first `;` to the end of the line. The requirement is checked
   whatever its marker says; markers are never evaluated.
4. The line is trimmed. An empty line is ignored. A line that starts with `-` (`-r other.txt`,
   `-e .`, `--index-url ...`, `--hash`, and every other option) is ignored.
5. Any other line must be a package name (letters, digits, `.`, `_`, `-`, starting and ending with a
   letter or digit), then optionally extras in square brackets (`name[extra]`, dropped), then either
   nothing or a version part that starts with one of the comparison operators `===`, `==`, `~=`, `!=`,
   `>=`, `<=`, `>`, `<` (the rest of the version part is not read). Then the name is a PyPI package.
   A line that is not of that form (a URL, a path such as `./pkg`, `name @ https://...`, `name junk`) is
   **skipped** and counted in `skipped`.

The version a requirement pins is never looked up: dep-gate judges the package's **latest** version
(below).

**Names.** A PyPI name is normalised everywhere: lower-cased, and every run of `-`, `_` and `.` becomes
one `-` (`Python_Dateutil` is `python-dateutil`). The normalised name is the one that is looked up,
compared and printed. An npm name is used exactly as written. Each package appears once: the same
registry and name from several places is one package, whose `sources` lists all of them.

A name that cannot be a package name is not looked up and is reported as `missing` with the message
"not a valid ... package name". For npm: an optional scope `@scope/` then a name, where scope and
name use only letters, digits, `.`, `_`, `~`, `-` and start with a letter or digit. For PyPI: the name
rule of the requirements lines, above, before normalising.

### Registries

* `--registry <url>`: npm. Default `https://registry.npmjs.org`.
* `--pypi <url>`: PyPI. Default `https://pypi.org/pypi`.
* A registry URL must start with `http://`, `https://` or `file://`, else it is a usage error.

**http(s).** Trailing `/` of the URL are dropped. npm: `GET <registry>/<name>`, where the `/` of a
scoped name is written `%2f` (`@scope%2fname`). PyPI: `GET <pypi>/<name>/json`. Send
`accept: application/json`. A `200` whose body is a JSON object is the document; a `404` means the
package does not exist; any other status, a body that is not a JSON object, a network error or a wait
of more than 30 seconds means the registry **could not be reached** for that package. At most 8 lookups
are in flight at once.

**file://.** `file://<folder>` (the text after `file://` is the folder path, relative to the current
directory or absolute, not percent-decoded): the document of `<name>` is the file `<folder>/<name>.json`
(for a scoped name `@scope/name`, the file `<folder>/@scope/name.json`). A missing file means the package
does not exist. A folder that does not exist (or is not a folder), a file that cannot be read for another
reason, and a file that is not a JSON object mean the registry could not be reached for that package.
This form runs offline and in CI.

dep-gate only reads documents. It never installs, runs or downloads a package.

### The documents

The fields read from the real documents, and only these:

**npm** (`GET <registry>/<name>`): `dist-tags.latest`; `time.created` and the other entries of `time`
(each key is `created`, `modified`, or a version, and its value an ISO time such as
`2021-03-04T05:06:07.123Z`); `versions[<version>]` with `scripts` (an object; the entries `preinstall`,
`install`, `postinstall`), `deprecated` (a string) and `repository` (a string, or an object with a
`url`); and the top-level `repository`.

**PyPI** (`GET <pypi>/<name>/json`): `info.version`, `info.project_urls` (an object, or `null`),
`info.home_page` (a string, `""` or `null`) and `releases` (an object of version to a list of files, each
with `upload_time_iso_8601`, such as `2020-01-02T03:04:05.123456Z`). `info.name` is not used.

The **version looked at** is `dist-tags.latest` for npm and `info.version` for PyPI: a non-empty string,
else none (`null`). For npm, the **record** of that version is `versions[<version>]` when that is an
object, else none. A time is read from a string of the form `YYYY-MM-DD`, or
`YYYY-MM-DDTHH:MM`, with optional `:SS` and optional `.` fraction (digits beyond the third are ignored),
then optionally `Z` or `±HH:MM`; with no zone it is UTC. Any other value is not a time and is ignored.

## Findings

Each finding has a `kind`, a `severity` (`error`, `warn` or `info`) and a `message` (any text that says
what is wrong, and holds what each kind below says it holds). A package that exists gets these findings,
in this order; a package that does not exist gets only `missing` and `lookalike`.

1. **`missing`** (error). The package does not exist: HTTP `404`, a missing file, or an invalid name.
2. **`new`** (warn). The package's **first publication** is less than `--min-age` days before `--now`.
   The first publication is, for npm, `time.created` when it is a time, else the earliest time among the
   entries of `time` whose key is not `created` or `modified`; for PyPI, the earliest
   `upload_time_iso_8601` of all files of all releases. With no time at all, there is no `new` finding.
   The test is `now - first < min-age × 86400000` milliseconds, so exactly `--min-age` days old is **not**
   new, and a first publication after `--now` is new. Extra fields: `created` (the first publication as
   `Date.toISOString()`), `ageDays` (a whole number: `now - first` in days, rounded down).
3. **`install-script`** (warn, npm only). The record of the version looked at has a non-empty string for
   `preinstall`, `install` or `postinstall` in its `scripts`: installing it runs that command. One finding
   per package; its message holds the commands. Extra field: `scripts`, an object of the present
   entries among those three (keys in the order `preinstall`, `install`, `postinstall`) to their
   commands. Other scripts (`prepare`, `test`, ...) and other versions are not findings.
4. **`deprecated`** (warn, npm only). The record of the version looked at has a non-empty string
   `deprecated`. Its message holds that string. Extra field: `deprecated`, the string. A deprecated
   version that is not the one looked at is not a finding.
5. **`lookalike`** (warn). The name is one edit away from a well-known package and is not itself a
   well-known package. npm packages are compared with the npm list and PyPI packages with the PyPI list (below). It
   applies to every package whose status is `found` or `missing` (a missing package is often the typo
   itself), never to an unchecked one. Its message holds the well-known name.
   Extra field: `of`, the well-known name.
6. **`no-repository`** (info). For npm: the `repository` of the record of the version looked at (the
   top-level `repository` when there is no record) is not a non-empty string and not an object with a
   non-empty string `url`. For PyPI: `info.home_page` is not a non-empty string and `info.project_urls` is
   not an object with at least one non-empty string value. (A string that is only spaces is empty.)

Not findings: a package that is old, popular, unscoped, or has no `scripts`; anything about an older
version; anything about a version a requirement pins; a PyPI package with `install-script` or
`deprecated` (it has none).

### Lookalike

"One edit away" means: the two names differ by exactly one of: inserting one character, deleting one
character, replacing one character by another, or swapping two neighbouring characters. Names are
compared as they are printed (npm exact, with case; PyPI normalised). A well-known name shorter than 5
characters is never matched (too many ordinary names are one edit from `vue` or `ms`). When several
well-known names match, the first in plain code-unit order (the order of `Array.prototype.sort()`) is
the one named.

The well-known packages are these, and no others. Embed them in the tool exactly as given; all of them
exist.

npm (127 names):

```
react react-dom react-router react-router-dom redux react-redux next vue vuex vue-router svelte
@angular/core lodash underscore moment dayjs date-fns axios express koa fastify body-parser cors
helmet morgan dotenv debug chalk commander yargs inquirer ora minimist glob rimraf mkdirp semver
uuid nanoid async bluebird request got node-fetch cheerio jquery bootstrap tailwindcss postcss
autoprefixer sass webpack webpack-cli vite rollup esbuild parcel @babel/core @babel/preset-env
typescript ts-node tslib eslint prettier jest mocha chai sinon ava nyc supertest cypress
puppeteer playwright nodemon pm2 socket.io ws mongoose mongodb mysql mysql2 pg redis sequelize
knex prisma typeorm graphql apollo-server passport jsonwebtoken bcrypt bcryptjs cookie-parser
express-session multer compression ejs pug handlebars marked highlight.js classnames prop-types
immer rxjs zod ajv joi yup validator qs ms ramda core-js d3 three chart.js electron lerna husky
lint-staged concurrently cross-env @types/node @types/react
```

PyPI (88 names):

```
requests numpy pandas scipy matplotlib flask django fastapi uvicorn gunicorn sqlalchemy pydantic
pytest pytest-cov tox black flake8 pylint mypy isort ruff setuptools wheel pip twine virtualenv
six urllib3 certifi idna charset-normalizer chardet pyyaml jinja2 markupsafe click werkzeug
itsdangerous boto3 botocore awscli s3transfer python-dateutil pytz tzdata attrs cryptography
cffi pycparser paramiko pillow opencv-python scikit-learn tensorflow torch keras transformers
beautifulsoup4 lxml selenium scrapy aiohttp httpx celery redis psycopg2 pymysql packaging
typing-extensions jsonschema tqdm rich openai anthropic joblib sympy networkx seaborn plotly
ipython docutils sphinx poetry pipenv protobuf grpcio coverage pluggy
```

## Output

### The plain form

One line per finding, each beginning with `<registry>:<name>` (`npm:lodahs`, `pypi:requests`), then the
severity word (`error`, `warn`, `info`), the kind, and the message, separated by spaces. For a package
that could not be looked up, a line `not checked: <registry>:<name> (<reason>)`. Last, a summary line
that starts with `dep-gate:` and gives the number of packages, of errors, of warnings, of info findings
and of packages not checked. When a package could not be checked, a line on stderr names every package
that was not checked. With nothing found, the summary alone is printed.

### `--json`

Exactly one JSON object on stdout and nothing else (more fields may be added; none of these may be left
out):

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

* `now`: the clock used, as `Date.toISOString()`. `--now` is an ISO time (the same form as a time above;
  anything else is a usage error). Without `--now`, the clock.
* `minAge`: the number of `--min-age` (default `30`). `--min-age` is a number of days written with
  digits, optionally with a decimal part (`0`, `7`, `0.5`); anything else is a usage error.
* `skipped`: how many package.json entries and requirements lines were skipped (above).
* `packages`: every package, none left out, **npm packages first, then PyPI packages, each group sorted
  by `name` in plain code-unit order**. Each has `name`, `registry` (`"npm"` or `"pypi"`), `version`
  (the version looked at, or `null`), `status` (`"found"`; `"missing"`; or `"unchecked"` when the
  registry could not be reached), `sources` (the distinct places it came from, among `dependencies`,
  `devDependencies`, `optionalDependencies`, `peerDependencies`, `requirements.txt` and `--pkg`, sorted
  in plain code-unit order) and `findings`. An unchecked package has `version: null`, no findings, and a
  `reason` string.
* `findings` of a package are in the order of the list above (`missing`, `new`, `install-script`,
  `deprecated`, `lookalike`, `no-repository`), each at most once; the extra fields are named above.
* `unchecked`: `"<registry>:<name>"` of each unchecked package, in the order of `packages`.
* `counts`: the number of findings of each severity over all packages.

### Exit codes

* `3`: at least one package could not be checked (this wins over 0 and 1: the answer is not complete).
* `1`: otherwise, a finding has a severity at or above `--fail-on`. The order is `info` < `warn` <
  `error`. `--fail-on` is `error` by default; `none` never gives 1 for findings.
* `0`: otherwise.
* `2`: a usage error: an unknown option, an option with its value missing, `--fail-on` not one of the
  four, a bad `--min-age`, `--now` or registry URL, more than one path, a path that does not exist, a
  folder with neither `package.json` nor `requirements.txt` when no `--pkg` is given, a file that is
  neither `package.json` nor `.txt`, a `package.json` that is not a JSON object, or `--pkg` with an
  empty name. A message is printed on stderr, **nothing on stdout**.

With `--json`, the object is printed whatever the exit code, except for 2. A project with no
dependencies has `packages: []`, and exits 0.

## README: the two closing sections

"Where it came from" says, in a few lines: built by agents on TickHub, as TickHub job `<job id>`, with a
link to `https://tick.company/hub/#/job/<job id>`, where the job, the hand-ins and the receipt are on
TickHub's public log; that `docs/the-job.md` is the job as it was given; and the line "AI does the work.
Tick makes it trustworthy. https://tick.company". The job id is given to the developer with the job.

"Licence" says: Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.

The README's way to run it today is `npx github:tick-ai/dep-gate` (and `node dep-gate.mjs` from a
clone). It is not on npm yet, so the README must not say `npx dep-gate` works. The README must say
plainly what dep-gate does not do: it does not read lock files, does not judge pinned versions, does not
evaluate environment markers, and cannot tell a malicious package from a harmless one: it reports facts
about the registry's document.
