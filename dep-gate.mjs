#!/usr/bin/env node
// dep-gate: check the packages your agent added before anyone installs them.
// Reads declared dependencies, looks each one up in its registry (npm or PyPI) and reports facts
// about the registry's document. It never installs, runs or downloads a package.
// Plain Node 22, built-in modules only.

import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const TOOL = 'dep-gate';
const VERSION = '0.1.0';
const DEFAULT_NPM = 'https://registry.npmjs.org';
const DEFAULT_PYPI = 'https://pypi.org/pypi';
const MAX_IN_FLIGHT = 8;
const TIMEOUT_MS = 30000;
const DAY_MS = 86400000;

const WELL_KNOWN_NPM = `
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
`.split(/\s+/).filter(Boolean);

const WELL_KNOWN_PYPI = `
requests numpy pandas scipy matplotlib flask django fastapi uvicorn gunicorn sqlalchemy pydantic
pytest pytest-cov tox black flake8 pylint mypy isort ruff setuptools wheel pip twine virtualenv
six urllib3 certifi idna charset-normalizer chardet pyyaml jinja2 markupsafe click werkzeug
itsdangerous boto3 botocore awscli s3transfer python-dateutil pytz tzdata attrs cryptography
cffi pycparser paramiko pillow opencv-python scikit-learn tensorflow torch keras transformers
beautifulsoup4 lxml selenium scrapy aiohttp httpx celery redis psycopg2 pymysql packaging
typing-extensions jsonschema tqdm rich openai anthropic joblib sympy networkx seaborn plotly
ipython docutils sphinx poetry pipenv protobuf grpcio coverage pluggy
`.split(/\s+/).filter(Boolean);

const KNOWN = {
  npm: new Set(WELL_KNOWN_NPM),
  pypi: new Set(WELL_KNOWN_PYPI),
};
const KNOWN_SORTED = {
  npm: WELL_KNOWN_NPM.filter((n) => n.length >= 5).sort(),
  pypi: WELL_KNOWN_PYPI.filter((n) => n.length >= 5).sort(),
};

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SEVERITY_RANK = { info: 1, warn: 2, error: 3 };
const FAIL_ON = { error: 3, warn: 2, info: 1, none: Infinity };

const USAGE = `dep-gate ${VERSION}: check the packages your agent added before anyone installs them.

Usage:
  dep-gate [path] [--pkg <name>]... [--registry <url>] [--pypi <url>] [--min-age <days>]
           [--now <ISO time>] [--fail-on error|warn|info|none] [--json]

  path               a folder (its package.json and requirements.txt are read), a package.json,
                     or a requirements .txt file. Default: the current directory, unless --pkg is given.
  --pkg <name>       also check this npm package (repeatable). pypi:<name> is a PyPI package,
                     npm:<name> is the same as <name>.
  --registry <url>   npm registry (http://, https:// or file://). Default ${DEFAULT_NPM}
  --pypi <url>       PyPI JSON API (http://, https:// or file://). Default ${DEFAULT_PYPI}
  --min-age <days>   a package first published less than this many days ago is "new". Default 30
  --now <ISO time>   the clock to use, e.g. 2026-06-01 or 2026-06-01T12:00:00Z. Default: now
  --fail-on <level>  exit 1 when a finding has this severity or worse: error (default), warn, info, none
  --json             print one JSON object instead of text
  -h, --help         print this text

Every option that takes a value is written "--option value". Exit codes:
  0 nothing at or above --fail-on     1 a finding at or above --fail-on
  2 usage error                       3 some package could not be checked (wins over 1)
`;

class UsageError extends Error {}

// ---------------------------------------------------------------- times

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

// Returns milliseconds since the epoch, or null when the value is not a time.
function parseTime(value) {
  if (typeof value !== 'string') return null;
  const m = TIME_RE.exec(value);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const h = m[4] === undefined ? 0 : +m[4];
  const mi = m[5] === undefined ? 0 : +m[5];
  const s = m[6] === undefined ? 0 : +m[6];
  const ms = m[7] === undefined ? 0 : +m[7].slice(0, 3).padEnd(3, '0');
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, ms);
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  let t = date.getTime();
  const zone = m[8];
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const oh = +zone.slice(1, 3), om = +zone.slice(4, 6);
    if (oh > 23 || om > 59) return null;
    t -= sign * (oh * 60 + om) * 60000;
  }
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------- names

const NPM_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PYPI_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function normalisePypi(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function oneEdit(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    const diff = [];
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diff.push(i);
        if (diff.length > 2) return false;
      }
    }
    if (diff.length === 1) return true; // replace
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]; // swap
  }
  const [long, short] = la > lb ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && long[i] === short[i]) i++;
  return long.slice(i + 1) === short.slice(i); // insert / delete
}

function lookalikeOf(registry, name) {
  if (KNOWN[registry].has(name)) return null;
  for (const known of KNOWN_SORTED[registry]) if (oneEdit(name, known)) return known;
  return null;
}

// ---------------------------------------------------------------- small helpers

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const nonBlank = (v) => typeof v === 'string' && v.trim().length > 0;

function readText(file) {
  const text = readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function statOrNull(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = {
    paths: [], pkgs: [], registry: DEFAULT_NPM, pypi: DEFAULT_PYPI, minAge: 30, now: null,
    failOn: 'error', json: false, help: false,
  };
  const valued = new Set(['--pkg', '--registry', '--pypi', '--min-age', '--now', '--fail-on']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--json') { o.json = true; continue; }
    if (valued.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`option ${a} needs a value (write: ${a} <value>)`);
      i++;
      switch (a) {
        case '--pkg': o.pkgs.push(v); break;
        case '--registry': o.registry = v; break;
        case '--pypi': o.pypi = v; break;
        case '--min-age': o.minAge = v; break;
        case '--now': o.now = v; break;
        case '--fail-on': o.failOn = v; break;
      }
      continue;
    }
    if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
    o.paths.push(a);
  }
  if (o.help) return o;
  if (!has(FAIL_ON, o.failOn)) throw new UsageError(`--fail-on must be one of error, warn, info, none (got "${o.failOn}")`);
  if (typeof o.minAge === 'string') {
    if (!/^\d+(\.\d+)?$/.test(o.minAge)) throw new UsageError(`--min-age must be a number of days such as 30 or 0.5 (got "${o.minAge}")`);
    o.minAge = Number(o.minAge);
  }
  if (o.now !== null) {
    const t = parseTime(o.now);
    if (t === null) throw new UsageError(`--now must be an ISO time such as 2026-06-01 or 2026-06-01T12:00:00Z (got "${o.now}")`);
    o.nowMs = t;
  } else {
    o.nowMs = Date.now();
  }
  for (const [flag, url] of [['--registry', o.registry], ['--pypi', o.pypi]]) {
    if (!/^(https?|file):\/\//.test(url)) throw new UsageError(`${flag} must start with http://, https:// or file:// (got "${url}")`);
  }
  if (o.paths.length > 1) throw new UsageError(`only one path may be given (got ${o.paths.length})`);
  return o;
}

// ---------------------------------------------------------------- collecting packages

class Collector {
  constructor() {
    this.map = new Map();
    this.skipped = 0;
  }

  add(registry, rawName, source) {
    const name = registry === 'pypi' ? normalisePypi(rawName) : rawName;
    const valid = registry === 'pypi' ? PYPI_NAME_RE.test(rawName) : NPM_NAME_RE.test(rawName);
    const key = `${registry}:${name}`;
    let p = this.map.get(key);
    if (!p) {
      p = { name, registry, valid, sources: new Set() };
      this.map.set(key, p);
    }
    p.sources.add(source);
  }
}

const SKIP_PREFIX = /^(?:file:|link:|workspace:|git:|git\+[A-Za-z]+:|github:|gitlab:|bitbucket:|http:|https:|portal:|patch:|exec:)/;

function readPackageJson(file, col) {
  let data;
  try {
    data = JSON.parse(readText(file));
  } catch (e) {
    throw new UsageError(`cannot read ${file} as JSON: ${e.message}`);
  }
  if (!isObject(data)) throw new UsageError(`${file} is not a JSON object`);
  for (const section of SECTIONS) {
    const deps = data[section];
    if (!isObject(deps)) continue;
    for (const [key, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('npm:')) {
        const rest = spec.slice(4);
        const at = rest.lastIndexOf('@');
        col.add('npm', at > 0 ? rest.slice(0, at) : rest, section);
      } else if (typeof spec !== 'string' || SKIP_PREFIX.test(spec) || spec.includes('/')) {
        col.skipped++;
      } else {
        col.add('npm', key, section);
      }
    }
  }
}

const REQ_RE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(?:(?:===|==|~=|!=|>=|<=|>|<).*)?$/;

function readRequirements(file, col) {
  let text;
  try {
    text = readText(file);
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${e.message}`);
  }
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    while (line.endsWith('\\') && i + 1 < raw.length) {
      line = line.slice(0, -1) + ' ' + raw[++i];
    }
    if (line.endsWith('\\')) line = line.slice(0, -1);
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '#' && (j === 0 || /\s/.test(line[j - 1]))) {
        line = line.slice(0, j);
        break;
      }
    }
    const semi = line.indexOf(';');
    if (semi >= 0) line = line.slice(0, semi);
    line = line.trim();
    if (line === '' || line.startsWith('-')) continue;
    const m = REQ_RE.exec(line);
    if (m) col.add('pypi', m[1], 'requirements.txt');
    else col.skipped++;
  }
}

function collect(opts) {
  const col = new Collector();
  let path = opts.paths[0];
  if (path === undefined && opts.pkgs.length === 0) path = '.';
  if (path !== undefined) {
    const st = statOrNull(path);
    if (!st) throw new UsageError(`path does not exist: ${path}`);
    if (st.isDirectory()) {
      const pj = join(path, 'package.json');
      const rq = join(path, 'requirements.txt');
      const hasPj = statOrNull(pj)?.isFile() ?? false;
      const hasRq = statOrNull(rq)?.isFile() ?? false;
      if (!hasPj && !hasRq && opts.pkgs.length === 0) {
        throw new UsageError(`no package.json or requirements.txt in ${path}`);
      }
      if (hasPj) readPackageJson(pj, col);
      if (hasRq) readRequirements(rq, col);
    } else if (basename(path) === 'package.json') {
      readPackageJson(path, col);
    } else if (path.endsWith('.txt')) {
      readRequirements(path, col);
    } else {
      throw new UsageError(`${path} is neither a package.json nor a .txt requirements file`);
    }
  }
  for (const spec of opts.pkgs) {
    let registry = 'npm';
    let name = spec;
    if (spec.startsWith('pypi:')) { registry = 'pypi'; name = spec.slice(5); }
    else if (spec.startsWith('npm:')) name = spec.slice(4);
    if (name === '') throw new UsageError(`--pkg needs a package name (got "${spec}")`);
    col.add(registry, name, '--pkg');
  }
  return col;
}

// ---------------------------------------------------------------- registries

function describeError(e) {
  return e?.cause?.code || e?.code || e?.message || String(e);
}

async function fetchFile(folder, name) {
  const st = statOrNull(folder);
  if (!st || !st.isDirectory()) return { state: 'unreachable', reason: `registry folder not found: ${folder}` };
  const file = join(folder, `${name}.json`);
  let text;
  try {
    text = readText(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreachable', reason: `cannot read ${file}: ${describeError(e)}` };
  }
  return parseDocument(text, file);
}

function parseDocument(text, where) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { state: 'unreachable', reason: `${where} is not JSON` };
  }
  if (!isObject(doc)) return { state: 'unreachable', reason: `${where} is not a JSON object` };
  return { state: 'ok', doc };
}

async function fetchHttp(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { state: 'missing' };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { state: 'unreachable', reason: `HTTP ${res.status} from ${url}` };
    }
    const text = await res.text();
    return parseDocument(text, `response from ${url}`);
  } catch (e) {
    if (ctl.signal.aborted) return { state: 'unreachable', reason: `no answer from ${url} within 30 seconds` };
    return { state: 'unreachable', reason: `network error for ${url}: ${describeError(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

function lookup(pkg, opts) {
  const base = pkg.registry === 'npm' ? opts.registry : opts.pypi;
  if (base.startsWith('file://')) return fetchFile(base.slice('file://'.length), pkg.name);
  const root = base.replace(/\/+$/, '');
  const url = pkg.registry === 'npm'
    ? `${root}/${pkg.name.replace('/', '%2f')}`
    : `${root}/${pkg.name}/json`;
  return fetchHttp(url);
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------- judging a document

function judgeNpm(doc) {
  const tags = isObject(doc['dist-tags']) ? doc['dist-tags'] : {};
  const version = nonEmpty(tags.latest) ? tags.latest : null;
  const versions = isObject(doc.versions) ? doc.versions : {};
  const record = version !== null && has(versions, version) && isObject(versions[version]) ? versions[version] : null;

  let first = null;
  const time = isObject(doc.time) ? doc.time : {};
  const created = parseTime(time.created);
  if (created !== null) {
    first = created;
  } else {
    for (const [k, v] of Object.entries(time)) {
      if (k === 'created' || k === 'modified') continue;
      const t = parseTime(v);
      if (t !== null && (first === null || t < first)) first = t;
    }
  }

  let scripts = null;
  if (record && isObject(record.scripts)) {
    for (const k of ['preinstall', 'install', 'postinstall']) {
      if (nonEmpty(record.scripts[k])) (scripts ??= {})[k] = record.scripts[k];
    }
  }
  const deprecated = record && nonEmpty(record.deprecated) ? record.deprecated : null;

  const repo = record ? record.repository : doc.repository;
  const hasRepo = nonBlank(repo) || (isObject(repo) && nonBlank(repo.url));
  return { version, first, scripts, deprecated, hasRepo };
}

function judgePypi(doc) {
  const info = isObject(doc.info) ? doc.info : {};
  const version = nonEmpty(info.version) ? info.version : null;
  let first = null;
  if (isObject(doc.releases)) {
    for (const files of Object.values(doc.releases)) {
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        const t = isObject(f) ? parseTime(f.upload_time_iso_8601) : null;
        if (t !== null && (first === null || t < first)) first = t;
      }
    }
  }
  const hasRepo = nonBlank(info.home_page)
    || (isObject(info.project_urls) && Object.values(info.project_urls).some(nonBlank));
  return { version, first, scripts: null, deprecated: null, hasRepo };
}

function finding(kind, severity, message, extra = {}) {
  return { kind, severity, message, ...extra };
}

function judge(pkg, result, opts) {
  const out = {
    name: pkg.name,
    registry: pkg.registry,
    version: null,
    status: 'found',
    sources: [...pkg.sources].sort(),
    findings: [],
  };
  const label = pkg.registry === 'npm' ? 'npm' : 'PyPI';
  if (result.state === 'unreachable') {
    out.status = 'unchecked';
    out.reason = result.reason;
    return out;
  }
  const f = out.findings;
  let facts = null;
  if (!pkg.valid) {
    out.status = 'missing';
    f.push(finding('missing', 'error', `not a valid ${label} package name`));
  } else if (result.state === 'missing') {
    out.status = 'missing';
    f.push(finding('missing', 'error', `${pkg.name} does not exist on ${label}`));
  } else {
    facts = pkg.registry === 'npm' ? judgeNpm(result.doc) : judgePypi(result.doc);
    out.version = facts.version;
  }
  if (facts) {
    if (facts.first !== null && opts.nowMs - facts.first < opts.minAge * DAY_MS) {
      const ageDays = Math.floor((opts.nowMs - facts.first) / DAY_MS);
      const created = new Date(facts.first).toISOString();
      f.push(finding('new', 'warn',
        `first published ${created} (${ageDays} days before ${new Date(opts.nowMs).toISOString()}), less than ${opts.minAge} days`,
        { created, ageDays }));
    }
    if (facts.scripts) {
      const cmds = Object.entries(facts.scripts).map(([k, v]) => `${k}: ${v}`).join('; ');
      f.push(finding('install-script', 'warn', `version ${facts.version} runs a command when installed (${cmds})`, { scripts: facts.scripts }));
    }
    if (facts.deprecated !== null) {
      f.push(finding('deprecated', 'warn', `version ${facts.version} is deprecated: ${facts.deprecated}`, { deprecated: facts.deprecated }));
    }
  }
  const of = lookalikeOf(pkg.registry, pkg.name);
  if (of !== null) f.push(finding('lookalike', 'warn', `name is one edit away from the well-known package ${of}`, { of }));
  if (facts && !facts.hasRepo) {
    f.push(finding('no-repository', 'info', pkg.registry === 'npm'
      ? 'no repository is declared for the latest version'
      : 'no home page or project URL is declared'));
  }
  return out;
}

// ---------------------------------------------------------------- output

const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderPlain(report) {
  const lines = [];
  for (const p of report.packages) {
    const id = `${p.registry}:${p.name}`;
    if (p.status === 'unchecked') {
      lines.push(clean(`not checked: ${id} (${p.reason})`));
      continue;
    }
    for (const x of p.findings) lines.push(clean(`${id} ${x.severity} ${x.kind} ${x.message}`));
  }
  const c = report.counts;
  let summary = `${TOOL}: ${plural(report.packages.length, 'package', 'packages')}, ${plural(c.error, 'error', 'errors')}, `
    + `${plural(c.warn, 'warning', 'warnings')}, ${c.info} info, ${report.unchecked.length} not checked`;
  if (report.skipped > 0) summary += `, ${report.skipped} skipped`;
  lines.push(summary);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- main

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const col = collect(opts);
  const pkgs = [...col.map.values()].sort((a, b) => {
    if (a.registry !== b.registry) return a.registry === 'npm' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const results = await pool(pkgs, MAX_IN_FLIGHT, async (p) => (p.valid ? lookup(p, opts) : { state: 'invalid' }));
  const packages = pkgs.map((p, i) => judge(p, results[i], opts));

  const counts = { error: 0, warn: 0, info: 0 };
  for (const p of packages) for (const x of p.findings) counts[x.severity]++;
  const unchecked = packages.filter((p) => p.status === 'unchecked').map((p) => `${p.registry}:${p.name}`);

  const report = {
    tool: TOOL,
    version: VERSION,
    now: new Date(opts.nowMs).toISOString(),
    minAge: opts.minAge,
    skipped: col.skipped,
    packages,
    unchecked,
    counts,
  };

  process.stdout.write(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderPlain(report));
  if (unchecked.length > 0) {
    process.stderr.write(clean(`${TOOL}: could not check ${unchecked.length} package${unchecked.length === 1 ? '' : 's'}: ${unchecked.join(', ')}`) + '\n');
    return 3;
  }
  const threshold = FAIL_ON[opts.failOn];
  const failing = packages.some((p) => p.findings.some((x) => SEVERITY_RANK[x.severity] >= threshold));
  return failing ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`${TOOL}: ${e.message}\nRun "${TOOL} --help" for usage.\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${TOOL}: unexpected error: ${e?.stack || e}\n`);
    process.exitCode = 70;
  }
}
