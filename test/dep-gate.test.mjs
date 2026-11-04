import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const TOOL = fileURLToPath(new URL('../dep-gate.mjs', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const NOW = '2026-06-01T00:00:00Z';
const DAY = 86400000;

// ------------------------------------------------------------------ helpers

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dep-gate-test-')));
  const sb = {
    root,
    npm: join(root, 'npm'),
    pypi: join(root, 'pypi'),
    proj: join(root, 'proj'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  mkdirSync(sb.npm);
  mkdirSync(sb.pypi);
  mkdirSync(sb.proj);
  return sb;
}

function put(dir, rel, content) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function spawnArgs(sb, args) {
  const has = (f) => args.includes(f);
  const full = [...args];
  if (sb && !has('--registry')) full.push('--registry', `file://${sb.npm}`);
  if (sb && !has('--pypi')) full.push('--pypi', `file://${sb.pypi}`);
  if (!has('--now')) full.push('--now', NOW);
  return full;
}

function run(sb, args, { cwd } = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...spawnArgs(sb, args)], { encoding: 'utf8', cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function runJson(sb, args, opts) {
  const r = run(sb, [...args, '--json'], opts);
  assert.ok(r.out.trim().startsWith('{'), `stdout is not JSON: ${r.out} / ${r.err}`);
  return { ...r, json: JSON.parse(r.out) };
}

// an npm document
function npmDoc(o = {}) {
  const { latest = '1.0.0', created, times, scripts, deprecated, topRepo, versions } = o;
  // `repository: undefined` means "no repository", so the default applies only when the key is absent
  const repository = 'repository' in o ? o.repository : 'git+https://example.com/x.git';
  const time = {};
  if (created) time.created = created;
  if (times) Object.assign(time, times);
  const record = {};
  if (scripts) record.scripts = scripts;
  if (deprecated !== undefined) record.deprecated = deprecated;
  if (repository !== undefined) record.repository = repository;
  const doc = {
    'dist-tags': { latest },
    time,
    versions: versions ?? { [latest]: record },
  };
  if (topRepo !== undefined) doc.repository = topRepo;
  return doc;
}

const OLD = '2015-01-01T00:00:00.000Z';

function pypiDoc({ version = '1.0', uploads = ['2015-01-01T00:00:00.000000Z'], home_page = 'https://example.com', project_urls = null } = {}) {
  const releases = {};
  uploads.forEach((u, i) => { releases[`0.${i}`] = [{ upload_time_iso_8601: u }]; });
  return { info: { name: 'x', version, home_page, project_urls }, releases };
}

function pkgOf(json, registry, name) {
  const p = json.packages.find((x) => x.registry === registry && x.name === name);
  assert.ok(p, `package ${registry}:${name} not in ${JSON.stringify(json.packages.map((x) => x.name))}`);
  return p;
}

const kinds = (p) => p.findings.map((f) => f.kind);

function withBox(fn) {
  return async (t) => {
    const sb = sandbox();
    try { await fn(sb, t); } finally { sb.cleanup(); }
  };
}

// ------------------------------------------------------------------ the shape of the tool

test('the file starts with the node shebang and package.json says what the job says', () => {
  const text = readFileSync(TOOL, 'utf8');
  assert.equal(text.split('\n')[0], '#!/usr/bin/env node');
  assert.equal(PKG.name, 'dep-gate');
  assert.equal(PKG.version, '0.1.0');
  assert.equal(PKG.type, 'module');
  assert.deepEqual(PKG.bin, { 'dep-gate': 'dep-gate.mjs' });
  assert.deepEqual(PKG.files, ['dep-gate.mjs', 'README.md', 'LICENSE']);
  assert.deepEqual(PKG.engines, { node: '>=22' });
  assert.deepEqual(PKG.scripts, { test: 'node --test' });
  assert.equal(PKG.license, 'Apache-2.0');
  assert.equal(PKG.repository.url, 'git+https://github.com/tick-ai/dep-gate.git');
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(PKG[k], undefined);
});

test('the embedded well-known lists have 127 npm and 88 PyPI names', () => {
  const text = readFileSync(TOOL, 'utf8');
  const grab = (name) => {
    const m = new RegExp(`const ${name} = \`([^\`]*)\``).exec(text);
    return m[1].split(/\s+/).filter(Boolean);
  };
  assert.equal(grab('WELL_KNOWN_NPM').length, 127);
  assert.equal(grab('WELL_KNOWN_PYPI').length, 88);
});

// ------------------------------------------------------------------ help and usage errors

test('--help and -h print usage on stdout and exit 0', () => {
  for (const flag of ['--help', '-h']) {
    const r = run(null, [flag]);
    assert.equal(r.code, 0);
    assert.match(r.out, /Usage:/);
    assert.match(r.out, /--fail-on/);
    assert.equal(r.err, '');
  }
});

test('usage errors: message on stderr, nothing on stdout, exit 2', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: {} });
  put(sb.root, 'weird.cfg', 'x');
  put(sb.root, 'package.json', '{ not json');
  mkdirSync(join(sb.root, 'empty'));
  const cases = {
    'unknown option': ['--frobnicate'],
    'unknown short option': ['-x'],
    '--option=value is unknown': ['--min-age=5'],
    'missing value at end': ['--pkg'],
    'missing value before option': ['--registry', '--json'],
    'bad --fail-on': ['--fail-on', 'bogus', sb.proj],
    'bad --min-age letters': ['--min-age', 'abc', sb.proj],
    'bad --min-age negative': ['--min-age', '-1', sb.proj],
    'bad --min-age exponent': ['--min-age', '1e3', sb.proj],
    'bad --min-age trailing dot': ['--min-age', '5.', sb.proj],
    'bad --now': ['--now', 'yesterday', sb.proj],
    'bad --now month': ['--now', '2026-13-01', sb.proj],
    'bad --now day': ['--now', '2026-02-30', sb.proj],
    'bad --now space form': ['--now', '2026-06-01 10:00', sb.proj],
    'bad registry url': ['--registry', 'ftp://x', sb.proj],
    'bad pypi url': ['--pypi', '/tmp/x', sb.proj],
    'two paths': [sb.proj, sb.proj],
    'path does not exist': [join(sb.root, 'nope')],
    'folder with nothing': [join(sb.root, 'empty')],
    'file that is neither': [join(sb.root, 'weird.cfg')],
    'package.json that is not JSON': [join(sb.root, 'package.json')],
    'package.json array': (() => { put(sb.root, 'arr/package.json', '[]'); return [join(sb.root, 'arr')]; })(),
    '--pkg with empty name': ['--pkg', ''],
    '--pkg pypi: with empty name': ['--pkg', 'pypi:'],
    '--pkg npm: with empty name': ['--pkg', 'npm:'],
  };
  for (const [what, args] of Object.entries(cases)) {
    const r = run(sb, args);
    assert.equal(r.code, 2, `${what}: exit ${r.code}\n${r.err}`);
    assert.equal(r.out, '', `${what}: stdout must be empty`);
    assert.ok(r.err.trim().length > 0, `${what}: stderr must say something`);
  }
  // --json does not change that
  const j = run(sb, ['--json', '--fail-on', 'bogus']);
  assert.equal(j.code, 2);
  assert.equal(j.out, '');
  // an option with no next argument at all
  for (const opt of ['--pkg', '--registry', '--pypi', '--min-age', '--now', '--fail-on']) {
    const r = run(null, [opt]);
    assert.equal(r.code, 2, opt);
    assert.equal(r.out, '', opt);
    assert.ok(r.err.length > 0, opt);
  }
}));

test('a folder with neither file is fine when --pkg is given, and then reads no file', withBox((sb) => {
  mkdirSync(join(sb.root, 'empty'));
  put(sb.npm, 'lodash.json', npmDoc({ created: OLD }));
  const r = runJson(sb, [join(sb.root, 'empty'), '--pkg', 'lodash']);
  assert.equal(r.code, 0);
  assert.equal(r.json.packages.length, 1);
}));

test('--min-age accepts 0, 7, 0.5; --now accepts date, zone-less and offset forms', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: {} });
  for (const v of ['0', '7', '0.5', '30.25']) {
    const r = runJson(sb, [sb.proj, '--min-age', v]);
    assert.equal(r.code, 0);
    assert.equal(r.json.minAge, Number(v));
  }
  const nows = {
    '2026-06-01': '2026-06-01T00:00:00.000Z',
    '2026-06-01T12:30': '2026-06-01T12:30:00.000Z',
    '2026-06-01T12:30:15': '2026-06-01T12:30:15.000Z',
    '2026-06-01T12:30:15.123456': '2026-06-01T12:30:15.123Z',
    '2026-06-01T12:30:15.5Z': '2026-06-01T12:30:15.500Z',
    '2026-06-01T12:30:15Z': '2026-06-01T12:30:15.000Z',
    '2026-06-01T12:30:15+02:00': '2026-06-01T10:30:15.000Z',
    '2026-06-01T01:00-03:30': '2026-06-01T04:30:00.000Z',
    '2024-02-29': '2024-02-29T00:00:00.000Z',
  };
  for (const [given, want] of Object.entries(nows)) {
    const r = runJson(sb, [sb.proj, '--now', given]);
    assert.equal(r.code, 0, given);
    assert.equal(r.json.now, want, given);
  }
  const noNow = spawnSync(process.execPath, [TOOL, sb.proj, '--json'], { encoding: 'utf8' });
  const before = Date.now();
  assert.ok(Math.abs(Date.parse(JSON.parse(noNow.stdout).now) - before) < 60000);
}));

test('options may come before or after the path; a repeated option takes its last value', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: {} });
  const a = runJson(sb, ['--min-age', '3', sb.proj, '--min-age', '9']);
  assert.equal(a.json.minAge, 9);
  const b = runJson(sb, [sb.proj, '--fail-on', 'none', '--fail-on', 'warn']);
  assert.equal(b.code, 0);
}));

// ------------------------------------------------------------------ JSON shape

test('--json prints exactly one object with all required fields', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: { lodahs: '^1' } });
  put(sb.npm, 'lodahs.json', npmDoc({ created: OLD }));
  const r = run(sb, [sb.proj, '--json']);
  assert.equal(r.code, 0); // a warn does not fail --fail-on error
  const json = JSON.parse(r.out); // throws unless stdout is exactly one JSON value
  assert.equal(json.tool, 'dep-gate');
  assert.equal(json.version, '0.1.0');
  assert.equal(json.now, '2026-06-01T00:00:00.000Z');
  assert.equal(json.minAge, 30);
  assert.equal(json.skipped, 0);
  assert.deepEqual(json.unchecked, []);
  assert.deepEqual(json.counts, { error: 0, warn: 1, info: 0 });
  assert.deepEqual(json.packages, [{
    name: 'lodahs',
    registry: 'npm',
    version: '1.0.0',
    status: 'found',
    sources: ['dependencies'],
    findings: [{ kind: 'lookalike', severity: 'warn', message: json.packages[0].findings[0].message, of: 'lodash' }],
  }]);
  assert.match(json.packages[0].findings[0].message, /lodash/);
}));

test('a project with no dependencies has packages: [] and exits 0', withBox((sb) => {
  put(sb.proj, 'package.json', { name: 'x' });
  const r = runJson(sb, [sb.proj]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.packages, []);
  assert.deepEqual(r.json.counts, { error: 0, warn: 0, info: 0 });
  const plain = run(sb, [sb.proj]);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /^dep-gate: 0 packages, 0 errors, 0 warnings, 0 info, 0 not checked\n$/);
}));

// ------------------------------------------------------------------ findings: missing

test('a package with no document is a missing error; nothing else but lookalike', withBox((sb) => {
  const r = runJson(sb, ['--pkg', 'left-padd', '--pkg', 'pypi:no-such-thing']);
  assert.equal(r.code, 1);
  const p = pkgOf(r.json, 'npm', 'left-padd');
  assert.equal(p.status, 'missing');
  assert.equal(p.version, null);
  assert.deepEqual(kinds(p), ['missing']);
  assert.equal(p.findings[0].severity, 'error');
  assert.deepEqual(r.json.counts, { error: 2, warn: 0, info: 0 });
  assert.equal(pkgOf(r.json, 'pypi', 'no-such-thing').status, 'missing');
}));

test('scoped names are read from <folder>/@scope/name.json', withBox((sb) => {
  put(sb.npm, '@babel/ok-thing.json', npmDoc({ created: OLD }));
  const r = runJson(sb, ['--pkg', '@babel/ok-thing', '--pkg', '@babel/absent']);
  assert.equal(pkgOf(r.json, 'npm', '@babel/ok-thing').status, 'found');
  assert.deepEqual(kinds(pkgOf(r.json, 'npm', '@babel/absent')), ['missing']);
}));

test('invalid names are missing with "not a valid ... package name" and never looked up', withBox((sb) => {
  // files that would answer if it were looked up
  put(sb.npm, '-bad.json', npmDoc({ created: OLD }));
  put(sb.npm, 'a b.json', npmDoc({ created: OLD }));
  const bad = ['-bad', 'a b', '@scope', '@/x', '@s/-x', 'x/y/z', 'sp!ce', '.hidden', '_under'];
  const args = bad.flatMap((n) => ['--pkg', n]);
  args.push('--pkg', 'pypi:bad_name_', '--pkg', 'pypi:-x', '--pkg', 'pypi:a b');
  const r = runJson(sb, args);
  assert.equal(r.code, 1);
  for (const n of bad) {
    const p = pkgOf(r.json, 'npm', n);
    assert.equal(p.status, 'missing', n);
    assert.equal(p.findings[0].kind, 'missing');
    assert.match(p.findings[0].message, /not a valid .* package name/, n);
  }
  for (const n of ['bad-name-', '-x', 'a b']) {
    const p = pkgOf(r.json, 'pypi', n);
    assert.equal(p.status, 'missing', n);
    assert.match(p.findings[0].message, /not a valid .* package name/, n);
  }
  // an invalid name is not unchecked even when the registry folder does not exist
  const r2 = runJson(sb, ['--pkg', '-bad', '--registry', `file://${join(sb.root, 'nofolder')}`]);
  assert.equal(r2.code, 1);
  assert.equal(r2.json.packages[0].status, 'missing');
}));

test('valid names with dots, underscores, tildes and digits are looked up', withBox((sb) => {
  put(sb.npm, '@a.b/c_d~e-1.json', npmDoc({ created: OLD }));
  put(sb.npm, 'socket.io-x.json', npmDoc({ created: OLD }));
  const r = runJson(sb, ['--pkg', '@a.b/c_d~e-1', '--pkg', 'socket.io-x']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.packages.map((p) => p.status), ['found', 'found']);
}));

// ------------------------------------------------------------------ findings: new

test('new: age against --min-age, exactly min-age days is not new', withBox((sb) => {
  const now = Date.parse(NOW);
  const iso = (ms) => new Date(ms).toISOString();
  put(sb.npm, 'edge-exact.json', npmDoc({ created: iso(now - 30 * DAY) }));
  put(sb.npm, 'edge-inside.json', npmDoc({ created: iso(now - 30 * DAY + 1) }));
  put(sb.npm, 'edge-future.json', npmDoc({ created: iso(now + 2 * DAY) }));
  put(sb.npm, 'edge-week.json', npmDoc({ created: iso(now - 7.5 * DAY) }));
  const r = runJson(sb, ['--pkg', 'edge-exact', '--pkg', 'edge-inside', '--pkg', 'edge-future', '--pkg', 'edge-week']);
  assert.deepEqual(kinds(pkgOf(r.json, 'npm', 'edge-exact')), []);
  const inside = pkgOf(r.json, 'npm', 'edge-inside').findings[0];
  assert.equal(inside.kind, 'new');
  assert.equal(inside.severity, 'warn');
  assert.equal(inside.ageDays, 29);
  assert.equal(inside.created, iso(now - 30 * DAY + 1));
  const week = pkgOf(r.json, 'npm', 'edge-week').findings[0];
  assert.equal(week.ageDays, 7);
  assert.match(week.message, /7/);
  const future = pkgOf(r.json, 'npm', 'edge-future').findings[0];
  assert.equal(future.kind, 'new');
  assert.equal(future.ageDays, -2);
  // --min-age changes the verdict
  const r2 = runJson(sb, ['--pkg', 'edge-week', '--pkg', 'edge-exact', '--min-age', '7']);
  assert.deepEqual(kinds(pkgOf(r2.json, 'npm', 'edge-week')), []);
  const r3 = runJson(sb, ['--pkg', 'edge-exact', '--min-age', '30.5']);
  assert.deepEqual(kinds(pkgOf(r3.json, 'npm', 'edge-exact')), ['new']);
  const r0 = runJson(sb, ['--pkg', 'edge-inside', '--pkg', 'edge-future', '--min-age', '0']);
  assert.deepEqual(kinds(pkgOf(r0.json, 'npm', 'edge-inside')), []);
  assert.deepEqual(kinds(pkgOf(r0.json, 'npm', 'edge-future')), ['new']);
}));

test('new: npm reads time.created, else the earliest version time; ignores modified and junk', withBox((sb) => {
  put(sb.npm, 'a-created.json', npmDoc({ created: '2026-05-30T00:00:00.000Z', times: { '0.0.1': '2010-01-01T00:00:00.000Z' } }));
  put(sb.npm, 'b-versions.json', npmDoc({ times: { modified: '2026-05-31T00:00:00.000Z', '1.0.0': '2026-05-28T00:00:00.000Z', '0.9.0': '2026-05-20T00:00:00.000Z', '0.8.0': 'not a time' } }));
  put(sb.npm, 'c-badcreated.json', npmDoc({ created: 'garbage', times: { '1.0.0': '2026-05-25' } }));
  put(sb.npm, 'd-notime.json', npmDoc({ times: { modified: '2026-05-31T00:00:00.000Z' } }));
  put(sb.npm, 'e-notimes-at-all.json', { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { repository: 'x' } } });
  put(sb.npm, 'f-oldversions.json', npmDoc({ times: { modified: '2026-05-31T00:00:00.000Z', '1.0.0': '2014-01-01T00:00:00Z' } }));
  const names = ['a-created', 'b-versions', 'c-badcreated', 'd-notime', 'e-notimes-at-all', 'f-oldversions'];
  const r = runJson(sb, names.flatMap((n) => ['--pkg', n]));
  const f = (n) => pkgOf(r.json, 'npm', n).findings.find((x) => x.kind === 'new');
  assert.equal(f('a-created').created, '2026-05-30T00:00:00.000Z');
  assert.equal(f('b-versions').created, '2026-05-20T00:00:00.000Z');
  assert.equal(f('b-versions').ageDays, 12);
  assert.equal(f('c-badcreated').created, '2026-05-25T00:00:00.000Z');
  assert.equal(f('d-notime'), undefined);
  assert.equal(f('e-notimes-at-all'), undefined);
  assert.equal(f('f-oldversions'), undefined);
}));

test('new: time formats are read as documented (fraction, zone, no zone)', withBox((sb) => {
  put(sb.npm, 'zone-off.json', npmDoc({ created: '2026-05-31T23:00:00+02:00' })); // 21:00Z on May 31
  put(sb.npm, 'zone-less.json', npmDoc({ created: '2026-05-31T12:00' }));
  put(sb.npm, 'frac.json', npmDoc({ created: '2026-05-31T12:00:00.123456789Z' }));
  put(sb.npm, 'datenly.json', npmDoc({ created: '2026-05-31' }));
  const r = runJson(sb, ['--pkg', 'zone-off', '--pkg', 'zone-less', '--pkg', 'frac', '--pkg', 'datenly']);
  const c = (n) => pkgOf(r.json, 'npm', n).findings.find((x) => x.kind === 'new').created;
  assert.equal(c('zone-off'), '2026-05-31T21:00:00.000Z');
  assert.equal(c('zone-less'), '2026-05-31T12:00:00.000Z');
  assert.equal(c('frac'), '2026-05-31T12:00:00.123Z');
  assert.equal(c('datenly'), '2026-05-31T00:00:00.000Z');
}));

test('new: PyPI uses the earliest upload time of all files of all releases', withBox((sb) => {
  put(sb.pypi, 'fresh-lib.json', {
    info: { version: '2.0', home_page: 'https://x.example' },
    releases: {
      '2.0': [{ upload_time_iso_8601: '2026-05-30T10:00:00.000000Z' }, { upload_time_iso_8601: '2026-05-29T10:00:00.000000Z' }],
      '1.0': [{ upload_time_iso_8601: '2026-05-10T10:00:00.123456Z' }, { nothing: true }],
      '0.5': [],
      '0.4': 'junk',
    },
  });
  put(sb.pypi, 'no-files.json', { info: { version: '1', home_page: 'https://x.example' }, releases: {} });
  const r = runJson(sb, ['--pkg', 'pypi:fresh-lib', '--pkg', 'pypi:no-files']);
  const f = pkgOf(r.json, 'pypi', 'fresh-lib').findings[0];
  assert.equal(f.kind, 'new');
  assert.equal(f.created, '2026-05-10T10:00:00.123Z');
  assert.equal(f.ageDays, 21);
  assert.deepEqual(kinds(pkgOf(r.json, 'pypi', 'no-files')), []);
}));

// ------------------------------------------------------------------ install-script, deprecated

test('install-script: one finding with the commands, only preinstall/install/postinstall of the latest version', withBox((sb) => {
  put(sb.npm, 'all-three.json', npmDoc({ created: OLD, scripts: { postinstall: 'node post.js', preinstall: 'node pre.js', install: 'node-gyp rebuild', test: 'jest', prepare: 'tsc' } }));
  put(sb.npm, 'only-test.json', npmDoc({ created: OLD, scripts: { test: 'jest', prepare: 'tsc', prepublish: 'x', postpublish: 'y' } }));
  put(sb.npm, 'empty-str.json', npmDoc({ created: OLD, scripts: { install: '', postinstall: 5 } }));
  put(sb.npm, 'old-only.json', npmDoc({
    created: OLD, latest: '2.0.0',
    versions: { '1.0.0': { scripts: { postinstall: 'evil' }, repository: 'x' }, '2.0.0': { scripts: { test: 'x' }, repository: 'x' } },
  }));
  put(sb.npm, 'no-record.json', { 'dist-tags': { latest: '3.0.0' }, versions: { '1.0.0': { scripts: { postinstall: 'evil' } } }, time: { created: OLD }, repository: 'x' });
  const r = runJson(sb, ['--pkg', 'all-three', '--pkg', 'only-test', '--pkg', 'empty-str', '--pkg', 'old-only', '--pkg', 'no-record']);
  const f = pkgOf(r.json, 'npm', 'all-three').findings;
  assert.deepEqual(f.map((x) => x.kind), ['install-script']);
  assert.equal(f[0].severity, 'warn');
  assert.deepEqual(f[0].scripts, { preinstall: 'node pre.js', install: 'node-gyp rebuild', postinstall: 'node post.js' });
  assert.deepEqual(Object.keys(f[0].scripts), ['preinstall', 'install', 'postinstall']);
  for (const c of ['node pre.js', 'node-gyp rebuild', 'node post.js']) assert.ok(f[0].message.includes(c), c);
  for (const n of ['only-test', 'empty-str', 'old-only', 'no-record']) assert.deepEqual(kinds(pkgOf(r.json, 'npm', n)), [], n);
}));

test('deprecated: the latest version only; its message holds the text', withBox((sb) => {
  put(sb.npm, 'dep-latest.json', npmDoc({ created: OLD, deprecated: 'use dep-newer instead' }));
  put(sb.npm, 'dep-old.json', npmDoc({
    created: OLD, latest: '2.0.0',
    versions: { '1.0.0': { deprecated: 'old and bad', repository: 'x' }, '2.0.0': { repository: 'x' } },
  }));
  put(sb.npm, 'dep-empty.json', npmDoc({ created: OLD, deprecated: '' }));
  put(sb.npm, 'dep-nonstring.json', npmDoc({ created: OLD, deprecated: true }));
  const r = runJson(sb, ['--pkg', 'dep-latest', '--pkg', 'dep-old', '--pkg', 'dep-empty', '--pkg', 'dep-nonstring']);
  const f = pkgOf(r.json, 'npm', 'dep-latest').findings;
  assert.deepEqual(f.map((x) => x.kind), ['deprecated']);
  assert.equal(f[0].severity, 'warn');
  assert.equal(f[0].deprecated, 'use dep-newer instead');
  assert.ok(f[0].message.includes('use dep-newer instead'));
  for (const n of ['dep-old', 'dep-empty', 'dep-nonstring']) assert.deepEqual(kinds(pkgOf(r.json, 'npm', n)), [], n);
}));

test('PyPI packages never get install-script or deprecated', withBox((sb) => {
  put(sb.pypi, 'py-thing.json', { ...pypiDoc(), scripts: { postinstall: 'x' }, deprecated: 'x', versions: { '1.0': { deprecated: 'x', scripts: { install: 'y' } } } });
  const r = runJson(sb, ['--pkg', 'pypi:py-thing']);
  assert.deepEqual(kinds(pkgOf(r.json, 'pypi', 'py-thing')), []);
}));

// ------------------------------------------------------------------ lookalike

test('lookalike: insert, delete, replace and swap are one edit away', withBox((sb) => {
  const cases = {
    lodashh: 'lodash', // insert
    lodsh: 'lodash', // delete
    lodazh: 'lodash', // replace
    loadsh: 'lodash', // swap
    expres: 'express',
    'reactt': 'react',
    '@types/nod': '@types/node',
    'Lodash': 'lodash',
    'react-dom2': 'react-dom',
  };
  for (const n of Object.keys(cases)) put(sb.npm, `${n}.json`, npmDoc({ created: OLD }));
  const r = runJson(sb, Object.keys(cases).flatMap((n) => ['--pkg', n]));
  for (const [n, of] of Object.entries(cases)) {
    const f = pkgOf(r.json, 'npm', n).findings.filter((x) => x.kind === 'lookalike');
    assert.equal(f.length, 1, n);
    assert.equal(f[0].severity, 'warn');
    assert.equal(f[0].of, of, n);
    assert.ok(f[0].message.includes(of), n);
  }
}));

test('lookalike: not for listed names, two-edit names, or names near short listed names', withBox((sb) => {
  const names = ['lodash', 'express', 'react', 'lodasxy', 'loadshx', 'vuee', 'vu', 'mss', 'axi', 'qss', 'ws2', 'pgg', 'cors', 'unrelated-thing'];
  for (const n of names) put(sb.npm, `${n}.json`, npmDoc({ created: OLD }));
  const r = runJson(sb, names.flatMap((n) => ['--pkg', n]));
  for (const n of names) assert.deepEqual(kinds(pkgOf(r.json, 'npm', n)), [], n);
  assert.equal(r.code, 0);
}));

test('lookalike: names are compared as printed; the first well-known name in code-unit order wins', withBox((sb) => {
  // "sasss" is one insert from "sass", but "sass" has only 4 letters and is never matched
  for (const n of ['sasss', 'reacd', 'chartjs', 'jsonwebtokem']) put(sb.npm, `${n}.json`, npmDoc({ created: OLD }));
  const r = runJson(sb, ['--pkg', 'sasss', '--pkg', 'reacd', '--pkg', 'chartjs', '--pkg', 'jsonwebtokem']);
  assert.deepEqual(kinds(pkgOf(r.json, 'npm', 'sasss')), []);
  assert.equal(pkgOf(r.json, 'npm', 'reacd').findings[0].of, 'react');
  assert.equal(pkgOf(r.json, 'npm', 'chartjs').findings[0].of, 'chart.js');
  assert.equal(pkgOf(r.json, 'npm', 'jsonwebtokem').findings[0].of, 'jsonwebtoken');
  // two well-known names match: "mysql" and "mysql2" are listed; "mysqk" is one edit from mysql only,
  // "mysql22" from mysql2 only; "mysqlx" from mysql (insert) and mysql2 (replace) -> mysql < mysql2
  put(sb.npm, 'mysqlx.json', npmDoc({ created: OLD }));
  const r2 = runJson(sb, ['--pkg', 'mysqlx']);
  assert.equal(pkgOf(r2.json, 'npm', 'mysqlx').findings[0].of, 'mysql');
}));

test('lookalike: PyPI uses the PyPI list and normalised names', withBox((sb) => {
  put(sb.pypi, 'reqeusts.json', pypiDoc());
  put(sb.pypi, 'numpyy.json', pypiDoc());
  put(sb.pypi, 'python-dateutl.json', pypiDoc());
  put(sb.pypi, 'lodahs.json', pypiDoc()); // an npm-list neighbour, not a PyPI one
  put(sb.pypi, 'expresz.json', pypiDoc()); // one edit from an npm well-known name, but this is PyPI
  const r = runJson(sb, ['--pkg', 'pypi:reqeusts', '--pkg', 'pypi:NumPyy', '--pkg', 'pypi:Python_DateUtl', '--pkg', 'pypi:lodahs', '--pkg', 'pypi:expresz']);
  assert.equal(pkgOf(r.json, 'pypi', 'reqeusts').findings[0].of, 'requests');
  assert.equal(pkgOf(r.json, 'pypi', 'numpyy').findings[0].of, 'numpy');
  assert.equal(pkgOf(r.json, 'pypi', 'python-dateutl').findings[0].of, 'python-dateutil');
  assert.deepEqual(kinds(pkgOf(r.json, 'pypi', 'lodahs')), []);
  assert.deepEqual(kinds(pkgOf(r.json, 'pypi', 'expresz')), []);
  // and an npm name one edit from a PyPI-only name is not a lookalike
  put(sb.npm, 'reqeusts.json', npmDoc({ created: OLD }));
  const n = runJson(sb, ['--pkg', 'reqeusts']);
  assert.deepEqual(kinds(pkgOf(n.json, 'npm', 'reqeusts')), []);
}));

test('lookalike also applies to missing packages, and never to unchecked ones', withBox((sb) => {
  const r = runJson(sb, ['--pkg', 'lodahs', '--pkg', 'pypi:reqests']);
  assert.deepEqual(kinds(pkgOf(r.json, 'npm', 'lodahs')), ['missing', 'lookalike']);
  assert.deepEqual(kinds(pkgOf(r.json, 'pypi', 'reqests')), ['missing', 'lookalike']);
  const bad = join(sb.root, 'no-such-folder');
  const u = runJson(sb, ['--pkg', 'lodahs', '--registry', `file://${bad}`]);
  assert.equal(u.json.packages[0].status, 'unchecked');
  assert.deepEqual(u.json.packages[0].findings, []);
}));

// ------------------------------------------------------------------ no-repository

test('no-repository (npm): judged on the latest version record', withBox((sb) => {
  put(sb.npm, 'repo-string.json', npmDoc({ created: OLD, repository: 'github:a/b' }));
  put(sb.npm, 'repo-object.json', npmDoc({ created: OLD, repository: { type: 'git', url: 'git+https://x/y.git' } }));
  put(sb.npm, 'repo-none.json', npmDoc({ created: OLD, repository: undefined }));
  put(sb.npm, 'repo-blank.json', npmDoc({ created: OLD, repository: '   ' }));
  put(sb.npm, 'repo-objblank.json', npmDoc({ created: OLD, repository: { type: 'git', url: '  ' } }));
  put(sb.npm, 'repo-objnourl.json', npmDoc({ created: OLD, repository: { type: 'git' } }));
  put(sb.npm, 'repo-top-only.json', npmDoc({ created: OLD, repository: undefined, topRepo: { url: 'https://x' } }));
  put(sb.npm, 'repo-old-only.json', npmDoc({
    created: OLD, latest: '2.0.0',
    versions: { '1.0.0': { repository: 'x' }, '2.0.0': {} },
  }));
  put(sb.npm, 'repo-no-record.json', { 'dist-tags': { latest: '9.9.9' }, time: { created: OLD }, versions: {}, repository: 'https://top' });
  put(sb.npm, 'repo-no-record-no-top.json', { 'dist-tags': { latest: '9.9.9' }, time: { created: OLD }, versions: {} });
  const names = ['repo-string', 'repo-object', 'repo-none', 'repo-blank', 'repo-objblank', 'repo-objnourl', 'repo-top-only', 'repo-old-only', 'repo-no-record', 'repo-no-record-no-top'];
  const r = runJson(sb, names.flatMap((n) => ['--pkg', n]));
  const want = {
    'repo-string': false, 'repo-object': false, 'repo-none': true, 'repo-blank': true, 'repo-objblank': true,
    'repo-objnourl': true, 'repo-top-only': true, 'repo-old-only': true, 'repo-no-record': false, 'repo-no-record-no-top': true,
  };
  for (const n of names) {
    const p = pkgOf(r.json, 'npm', n);
    assert.equal(kinds(p).includes('no-repository'), want[n], n);
    if (want[n]) assert.equal(p.findings.find((f) => f.kind === 'no-repository').severity, 'info');
  }
  assert.equal(pkgOf(r.json, 'npm', 'repo-no-record').version, '9.9.9');
}));

test('no-repository (PyPI): home_page or any project URL', withBox((sb) => {
  put(sb.pypi, 'p-home.json', pypiDoc({ home_page: 'https://h', project_urls: null }));
  put(sb.pypi, 'p-urls.json', pypiDoc({ home_page: '', project_urls: { Source: 'https://s', Docs: '' } }));
  put(sb.pypi, 'p-urls-only-empty.json', pypiDoc({ home_page: null, project_urls: { Source: '', Docs: '  ' } }));
  put(sb.pypi, 'p-null.json', pypiDoc({ home_page: null, project_urls: null }));
  put(sb.pypi, 'p-blank.json', pypiDoc({ home_page: '   ', project_urls: {} }));
  put(sb.pypi, 'p-noinfo.json', { releases: {} });
  const names = ['p-home', 'p-urls', 'p-urls-only-empty', 'p-null', 'p-blank', 'p-noinfo'];
  const r = runJson(sb, names.flatMap((n) => ['--pkg', `pypi:${n}`]));
  const want = { 'p-home': false, 'p-urls': false, 'p-urls-only-empty': true, 'p-null': true, 'p-blank': true, 'p-noinfo': true };
  for (const n of names) assert.equal(kinds(pkgOf(r.json, 'pypi', n)).includes('no-repository'), want[n], n);
}));

test('the version looked at: dist-tags.latest and info.version, or null', withBox((sb) => {
  put(sb.npm, 'has-latest.json', npmDoc({ created: OLD, latest: '4.5.6' }));
  put(sb.npm, 'no-tags.json', { time: { created: OLD }, repository: 'x' });
  put(sb.npm, 'empty-latest.json', { 'dist-tags': { latest: '' }, time: { created: OLD }, repository: 'x' });
  put(sb.pypi, 'has-ver.json', pypiDoc({ version: '7.8' }));
  put(sb.pypi, 'no-ver.json', { info: {}, releases: {} });
  const r = runJson(sb, ['--pkg', 'has-latest', '--pkg', 'no-tags', '--pkg', 'empty-latest', '--pkg', 'pypi:has-ver', '--pkg', 'pypi:no-ver']);
  assert.equal(pkgOf(r.json, 'npm', 'has-latest').version, '4.5.6');
  assert.equal(pkgOf(r.json, 'npm', 'no-tags').version, null);
  assert.equal(pkgOf(r.json, 'npm', 'empty-latest').version, null);
  assert.equal(pkgOf(r.json, 'pypi', 'has-ver').version, '7.8');
  assert.equal(pkgOf(r.json, 'pypi', 'no-ver').version, null);
}));

test('findings of a package come in the documented order, each at most once', withBox((sb) => {
  put(sb.npm, 'lodahs.json', npmDoc({
    created: '2026-05-30T00:00:00Z', scripts: { install: 'a', postinstall: 'b' }, deprecated: 'gone', repository: undefined,
  }));
  const r = runJson(sb, ['--pkg', 'lodahs']);
  assert.deepEqual(kinds(r.json.packages[0]), ['new', 'install-script', 'deprecated', 'lookalike', 'no-repository']);
  assert.deepEqual(r.json.counts, { error: 0, warn: 4, info: 1 });
}));

// ------------------------------------------------------------------ package.json

test('package.json: all four sections, aliases, skipped specs, sources', withBox((sb) => {
  put(sb.proj, 'package.json', {
    dependencies: {
      alpha: '^1.2.0', beta: 'latest', gamma: '*', delta: '>=2 <3', eps: '',
      al1: 'npm:realone@^1', al2: 'npm:@s/real@1', al3: 'npm:bare', al4: 'npm:@s/scoped-bare',
      f1: 'file:../x', f2: 'link:../y', f3: 'workspace:*', f4: 'git:github.com/a/b', f5: 'git+https://x/y.git',
      f6: 'git+ssh://git@x/y.git', f7: 'github:a/b', f8: 'gitlab:a/b', f9: 'bitbucket:a/b', f10: 'http://x/y.tgz',
      f11: 'https://x/y.tgz', f12: 'portal:../p', f13: 'patch:x@1#./p', f14: 'exec:./gen.js', f15: 'user/repo',
      f16: 'user/repo#semver:^1', f17: 5, f18: null, f19: ['x'], f20: { a: 1 },
    },
    devDependencies: { alpha: '^2', dev1: '1.0.0' },
    optionalDependencies: { opt1: '1' },
    peerDependencies: { peer1: '>=1', alpha: '*' },
    scripts: { x: 'y' },
  });
  const r = runJson(sb, [sb.proj, '--fail-on', 'none']);
  assert.equal(r.code, 0);
  const names = r.json.packages.map((p) => p.name);
  assert.deepEqual(names, ['@s/real', '@s/scoped-bare', 'alpha', 'beta', 'dev1', 'delta', 'eps', 'gamma', 'bare', 'opt1', 'peer1', 'realone'].sort());
  assert.equal(r.json.skipped, 20);
  assert.deepEqual(pkgOf(r.json, 'npm', 'alpha').sources, ['dependencies', 'devDependencies', 'peerDependencies']);
  assert.deepEqual(pkgOf(r.json, 'npm', 'dev1').sources, ['devDependencies']);
  assert.deepEqual(pkgOf(r.json, 'npm', 'opt1').sources, ['optionalDependencies']);
  assert.deepEqual(pkgOf(r.json, 'npm', 'peer1').sources, ['peerDependencies']);
  for (const alias of ['al1', 'al2', 'al3', 'al4']) assert.equal(names.includes(alias), false, alias);
}));

test('package.json: sections that are missing or not objects are ignored', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: ['a', 'b'], devDependencies: 'x', optionalDependencies: null, peerDependencies: 5 });
  const r = runJson(sb, [sb.proj]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.packages, []);
  assert.equal(r.json.skipped, 0);
}));

test('package.json: given as a file path, and the current directory is the default', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: { fromfile: '1' } });
  put(sb.proj, 'requirements.txt', 'frompy\n');
  const byFile = runJson(sb, [join(sb.proj, 'package.json')]);
  assert.deepEqual(byFile.json.packages.map((p) => `${p.registry}:${p.name}`), ['npm:fromfile']);
  const byCwd = runJson(sb, [], { cwd: sb.proj });
  assert.deepEqual(byCwd.json.packages.map((p) => `${p.registry}:${p.name}`), ['npm:fromfile', 'pypi:frompy']);
  // relative file:// registries are relative to the current directory
  mkdirSync(join(sb.proj, 'reg'));
  put(join(sb.proj, 'reg'), 'fromfile.json', npmDoc({ created: OLD }));
  const rel = spawnSync(process.execPath, [TOOL, '--registry', 'file://reg', '--pypi', 'file://nowhere', '--now', NOW, '--json'], { cwd: sb.proj, encoding: 'utf8' });
  const j = JSON.parse(rel.stdout);
  assert.equal(j.packages[0].status, 'found');
  assert.equal(j.packages[1].status, 'unchecked');
  assert.equal(rel.status, 3);
}));

test('package.json named by file name: a differently named .json is not read as one', withBox((sb) => {
  put(sb.root, 'other.json', { dependencies: { a: '1' } });
  const r = run(sb, [join(sb.root, 'other.json')]);
  assert.equal(r.code, 2);
}));

// ------------------------------------------------------------------ requirements.txt

test('requirements.txt: comments, options, markers, extras, operators, continuations, normalisation', withBox((sb) => {
  const lines = [
    '﻿# a comment',
    '',
    '-r other.txt',
    '-e .',
    '--index-url https://example.com/simple',
    '--hash=sha256:abcd',
    'requests==2.31.0',
    'Python_Dateutil>=2.8 # trailing comment',
    'Flask[async,dotenv]~=2.0',
    'SQL.Alchemy_x === 1.0',
    'pkg-a!=1.0',
    'pkg-b<=3',
    'pkg-c>1',
    'pkg-d<2',
    'pkg-e',
    'pkg-f ; python_version < "3.8"',
    'pkg-g>=1 ; sys_platform == "win32"',
    'pkg-h==1 \\',
    '    --hash=sha256:ab \\',
    '    --hash=sha256:cd',
    'pkg-i#notacomment',
    'pkg-j >= 1',
    'pkg-k[x]',
    'a',
    '9lives',
    // skipped
    'https://example.com/pkg.tar.gz',
    './local/pkg',
    'pkg-url @ https://example.com/pkg.zip',
    'name junk',
    'pkg-l (>=1)',
    '-bad',
    '_leading',
    'trailing_',
  ];
  put(sb.proj, 'requirements.txt', lines.join('\r\n') + '\r\n');
  const r = runJson(sb, [sb.proj, '--fail-on', 'none']);
  const names = r.json.packages.map((p) => p.name);
  assert.deepEqual(names, [
    '9lives', 'a', 'flask', 'pkg-a', 'pkg-b', 'pkg-c', 'pkg-d', 'pkg-e', 'pkg-f', 'pkg-g', 'pkg-h',
    'pkg-j', 'pkg-k', 'python-dateutil', 'requests', 'sql-alchemy-x',
  ].sort());
  assert.ok(r.json.packages.every((p) => p.registry === 'pypi'));
  assert.ok(r.json.packages.every((p) => p.sources.length === 1 && p.sources[0] === 'requirements.txt'));
  // skipped: pkg-i#notacomment ('#' without whitespace before it is not a comment), the URL, ./local/pkg,
  // "pkg-url @ ...", "name junk", "pkg-l (>=1)", _leading, trailing_ ; the "-" lines are ignored, not counted
  assert.equal(r.json.skipped, 8);
}));

test('requirements.txt: the rules one by one', withBox((sb) => {
  const text = [
    'cont-a==1 \\',
    '--hash=sha256:ab',
    '# comment-only-name',
    'cmt-b # cmt-c',
    'cmt-d\t# tab comment',
    'nocomment#x',
    'mark-e ; extra == "x" # not read',
    'wrongorder # c ; marker',
    '  spaced-f  ',
    'dots.and_under-g==1',
    'tilde-h ~= 1.4',
    'extras-i [a, b] >= 1',
    'extras-bad[a',
    'pin-j==1.0.0',
  ].join('\n');
  put(sb.proj, 'requirements.txt', text);
  const r = runJson(sb, [join(sb.proj, 'requirements.txt'), '--fail-on', 'none']);
  assert.deepEqual(r.json.packages.map((p) => p.name), [
    'cmt-b', 'cmt-d', 'cont-a', 'dots-and-under-g', 'extras-i', 'mark-e', 'pin-j', 'spaced-f', 'tilde-h', 'wrongorder',
  ]);
  // skipped: "nocomment#x" and "extras-bad[a"
  assert.equal(r.json.skipped, 2);
}));

test('requirements.txt: a backslash continuation swallows the next line, even a comment', withBox((sb) => {
  put(sb.proj, 'requirements.txt', 'first==1 \\\nsecond==2\nthird==3 \\\n# fourth==4\nfifth==5\n');
  const r = runJson(sb, [sb.proj, '--fail-on', 'none']);
  assert.deepEqual(r.json.packages.map((p) => p.name), ['fifth', 'first', 'third']);
}));

test('requirements.txt: given as a .txt file of any name, source is requirements.txt', withBox((sb) => {
  put(sb.root, 'dev-requirements.txt', 'somepkg==1\n');
  const r = runJson(sb, [join(sb.root, 'dev-requirements.txt')]);
  assert.deepEqual(r.json.packages.map((p) => [p.name, p.sources]), [['somepkg', ['requirements.txt']]]);
}));

test('PyPI names are normalised everywhere and merged', withBox((sb) => {
  put(sb.proj, 'requirements.txt', 'Python_Dateutil==2\npython.dateutil\nPYTHON--dateutil\n');
  put(sb.pypi, 'python-dateutil.json', pypiDoc());
  const r = runJson(sb, [sb.proj, '--pkg', 'pypi:Python..Dateutil']);
  assert.equal(r.json.packages.length, 1);
  assert.equal(r.json.packages[0].name, 'python-dateutil');
  assert.deepEqual(r.json.packages[0].sources, ['--pkg', 'requirements.txt']);
  assert.equal(r.json.packages[0].status, 'found');
}));

// ------------------------------------------------------------------ --pkg, merging, sorting

test('--pkg: npm default, npm: prefix, pypi: prefix; no file read when no path is given', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: { fromfile: '1' } });
  put(sb.npm, 'one.json', npmDoc({ created: OLD }));
  put(sb.npm, 'two.json', npmDoc({ created: OLD }));
  put(sb.pypi, 'three.json', pypiDoc());
  const r = runJson(sb, ['--pkg', 'one', '--pkg', 'npm:two', '--pkg', 'pypi:three', '--pkg', 'one'], { cwd: sb.proj });
  assert.deepEqual(r.json.packages.map((p) => `${p.registry}:${p.name}`), ['npm:one', 'npm:two', 'pypi:three']);
  assert.deepEqual(r.json.packages[0].sources, ['--pkg']);
  assert.equal(r.code, 0);
}));

test('--pkg with a path reads the path too; same package merges its sources', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: { shared: '1' }, devDependencies: { shared: '2' } });
  put(sb.npm, 'shared.json', npmDoc({ created: OLD }));
  const r = runJson(sb, [sb.proj, '--pkg', 'shared']);
  assert.equal(r.json.packages.length, 1);
  assert.deepEqual(r.json.packages[0].sources, ['--pkg', 'dependencies', 'devDependencies']);
}));

test('packages: npm first, then PyPI, each sorted by plain code-unit order', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: { zeta: '1', Beta: '1', alpha: '1', '@scope/x': '1', '9nine': '1' } });
  put(sb.proj, 'requirements.txt', 'zzz\naaa\nMmm\n');
  const r = runJson(sb, [sb.proj, '--fail-on', 'none']);
  assert.deepEqual(r.json.packages.map((p) => `${p.registry}:${p.name}`), [
    'npm:9nine', 'npm:@scope/x', 'npm:Beta', 'npm:alpha', 'npm:zeta', 'pypi:aaa', 'pypi:mmm', 'pypi:zzz',
  ]);
}));

test('an alias looks up the real package', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: { aliased: 'npm:real-pkg@^1', other: 'npm:@s/scoped' } });
  put(sb.npm, 'real-pkg.json', npmDoc({ created: OLD }));
  put(sb.npm, '@s/scoped.json', npmDoc({ created: OLD }));
  const r = runJson(sb, [sb.proj]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.packages.map((p) => [p.name, p.status]), [['@s/scoped', 'found'], ['real-pkg', 'found']]);
}));

// ------------------------------------------------------------------ plain output

test('plain output: one line per finding starting with registry:name, then a summary', withBox((sb) => {
  put(sb.proj, 'package.json', { dependencies: { lodahs: '1', gone: '1', 'left-pad': '1' }, devDependencies: { git: 'github:a/b' } });
  put(sb.proj, 'requirements.txt', 'requests\nnumpyy\n');
  put(sb.npm, 'lodahs.json', npmDoc({ created: '2026-05-25T00:00:00Z', scripts: { postinstall: 'node steal.js' }, repository: undefined }));
  put(sb.npm, 'left-pad.json', npmDoc({ created: OLD, deprecated: 'no longer maintained' }));
  put(sb.pypi, 'requests.json', pypiDoc());
  put(sb.pypi, 'numpyy.json', pypiDoc({ home_page: null, project_urls: {} }));
  const r = run(sb, [sb.proj]);
  assert.equal(r.code, 1);
  assert.equal(r.err, '');
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines.length, 9);
  assert.match(lines[0], /^npm:gone error missing /);
  assert.match(lines[1], /^npm:left-pad warn deprecated .*no longer maintained/);
  assert.match(lines[2], /^npm:lodahs warn new /);
  assert.match(lines[3], /^npm:lodahs warn install-script .*node steal\.js/);
  assert.match(lines[4], /^npm:lodahs warn lookalike .*lodash/);
  assert.match(lines[5], /^npm:lodahs info no-repository /);
  assert.match(lines[6], /^pypi:numpyy warn lookalike .*numpy/);
  assert.match(lines[7], /^pypi:numpyy info no-repository /);
  const summary = lines[lines.length - 1];
  assert.match(summary, /^dep-gate: /);
  assert.deepEqual(summary.match(/\d+/g).map(Number).slice(0, 5), [5, 1, 5, 2, 0]);
  assert.match(summary, /1 skipped/);
}));

test('plain output with nothing found is the summary alone', withBox((sb) => {
  put(sb.npm, 'fine.json', npmDoc({ created: OLD }));
  put(sb.pypi, 'fine-too.json', pypiDoc());
  const r = run(sb, ['--pkg', 'fine', '--pkg', 'pypi:fine-too']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'dep-gate: 2 packages, 0 errors, 0 warnings, 0 info, 0 not checked\n');
  assert.equal(r.err, '');
}));

test('plain output keeps one finding on one line even when the registry text has newlines', withBox((sb) => {
  put(sb.npm, 'multi.json', npmDoc({ created: OLD, deprecated: 'line one\nline two\u001b[31m' }));
  const r = run(sb, ['--pkg', 'multi']);
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(!r.out.includes('\u001b'));
  assert.match(lines[0], /^npm:multi warn deprecated .*line one line two/);
}));

// ------------------------------------------------------------------ exit codes

test('--fail-on decides between exit 0 and 1', withBox((sb) => {
  put(sb.npm, 'only-info.json', npmDoc({ created: OLD, repository: undefined }));
  put(sb.npm, 'only-warn.json', npmDoc({ created: OLD, deprecated: 'x' }));
  const table = [
    // pkg, fail-on, exit
    ['only-info', 'error', 0], ['only-info', 'warn', 0], ['only-info', 'info', 1], ['only-info', 'none', 0],
    ['only-warn', 'error', 0], ['only-warn', 'warn', 1], ['only-warn', 'info', 1], ['only-warn', 'none', 0],
    ['no-such-pkg', 'error', 1], ['no-such-pkg', 'warn', 1], ['no-such-pkg', 'info', 1], ['no-such-pkg', 'none', 0],
  ];
  for (const [pkg, level, want] of table) {
    const r = run(sb, ['--pkg', pkg, '--fail-on', level]);
    assert.equal(r.code, want, `${pkg} --fail-on ${level}`);
  }
  // default is error
  assert.equal(run(sb, ['--pkg', 'only-warn']).code, 0);
  assert.equal(run(sb, ['--pkg', 'no-such-pkg']).code, 1);
}));

test('exit 3: unreachable registry or unreadable document, listed on stdout and stderr; wins over 1', withBox((sb) => {
  put(sb.npm, 'broken.json', '{ this is not json');
  put(sb.npm, 'array.json', '[1,2]');
  put(sb.npm, 'isadir.json/inner.txt', 'x');
  put(sb.npm, 'fine.json', npmDoc({ created: OLD }));
  const r = runJson(sb, ['--pkg', 'broken', '--pkg', 'array', '--pkg', 'isadir', '--pkg', 'fine', '--pkg', 'absent-pkg']);
  assert.equal(r.code, 3);
  assert.deepEqual(r.json.unchecked, ['npm:array', 'npm:broken', 'npm:isadir']);
  for (const n of ['array', 'broken', 'isadir']) {
    const p = pkgOf(r.json, 'npm', n);
    assert.equal(p.status, 'unchecked');
    assert.equal(p.version, null);
    assert.deepEqual(p.findings, []);
    assert.equal(typeof p.reason, 'string');
    assert.ok(p.reason.length > 0);
  }
  assert.equal(pkgOf(r.json, 'npm', 'absent-pkg').status, 'missing'); // the missing error would give 1, 3 wins
  assert.deepEqual(r.json.counts, { error: 1, warn: 0, info: 0 });
  assert.match(r.err, /npm:array/);
  assert.match(r.err, /npm:broken/);
  assert.match(r.err, /npm:isadir/);
  assert.ok(!r.err.includes('npm:fine'));

  const plain = run(sb, ['--pkg', 'broken', '--pkg', 'pypi:whatever']);
  assert.equal(plain.code, 3);
  assert.match(plain.out, /^not checked: npm:broken \(.+\)$/m);
  assert.match(plain.out, /^dep-gate: 2 packages, 1 error, 0 warnings, 0 info, 1 not checked$/m);
  assert.match(plain.err, /npm:broken/);
  // --fail-on none does not hide an unchecked package
  assert.equal(run(sb, ['--pkg', 'broken', '--fail-on', 'none']).code, 3);
}));

test('exit 3: a registry folder that does not exist (or is a file) means unchecked, not missing', withBox((sb) => {
  put(sb.root, 'afile', 'x');
  for (const folder of [join(sb.root, 'nope'), join(sb.root, 'afile')]) {
    const r = runJson(sb, ['--pkg', 'anything', '--pkg', 'pypi:anything', '--registry', `file://${folder}`, '--pypi', `file://${folder}`]);
    assert.equal(r.code, 3);
    assert.deepEqual(r.json.unchecked, ['npm:anything', 'pypi:anything']);
  }
}));

test('exit 3: an unreachable http registry (connection refused)', withBox((sb) => {
  // port 1 on loopback: nothing listens; no traffic leaves the machine
  const r = runJson(sb, ['--pkg', 'anything', '--registry', 'http://127.0.0.1:1']);
  assert.equal(r.code, 3);
  assert.deepEqual(r.json.unchecked, ['npm:anything']);
}));

test('file:// registries accept absolute paths with three slashes', withBox((sb) => {
  put(sb.npm, 'abs.json', npmDoc({ created: OLD }));
  const r = runJson(sb, ['--pkg', 'abs', '--registry', `file://${sb.npm}`]);
  assert.equal(r.json.packages[0].status, 'found');
}));

// ------------------------------------------------------------------ http (loopback only)

function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('http registries: URLs, 404 is missing, other statuses are unreachable (loopback server)', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, accept: req.headers.accept });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
    if (req.url === '/npm/ok-pkg') return send(200, JSON.stringify(npmDoc({ created: OLD })));
    if (req.url === '/npm/@sc%2fok') return send(200, JSON.stringify(npmDoc({ created: OLD })));
    if (req.url === '/npm/boom') return send(500, '{}');
    if (req.url === '/npm/html') return send(200, '<html>');
    if (req.url === '/npm/array') return send(200, '[]');
    if (req.url === '/pypi/ok-py/json') return send(200, JSON.stringify(pypiDoc()));
    return send(404, '{"error":"not found"}');
  });
  const listening = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => resolve(true));
  });
  if (!listening) { t.skip('cannot listen on loopback here'); return; }
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await runAsync([
      '--registry', `${base}/npm///`, '--pypi', `${base}/pypi/`, '--now', NOW, '--json',
      '--pkg', 'ok-pkg', '--pkg', '@sc/ok', '--pkg', 'nada', '--pkg', 'boom', '--pkg', 'html', '--pkg', 'array',
      '--pkg', 'pypi:ok-py', '--pkg', 'pypi:Nada_Py',
    ]);
    assert.equal(r.code, 3);
    const json = JSON.parse(r.out);
    const st = (reg, n) => json.packages.find((p) => p.registry === reg && p.name === n).status;
    assert.equal(st('npm', 'ok-pkg'), 'found');
    assert.equal(st('npm', '@sc/ok'), 'found');
    assert.equal(st('npm', 'nada'), 'missing');
    assert.equal(st('npm', 'boom'), 'unchecked');
    assert.equal(st('npm', 'html'), 'unchecked');
    assert.equal(st('npm', 'array'), 'unchecked');
    assert.equal(st('pypi', 'ok-py'), 'found');
    assert.equal(st('pypi', 'nada-py'), 'missing');
    assert.ok(seen.every((s) => s.accept === 'application/json'));
    assert.ok(seen.some((s) => s.url === '/npm/@sc%2fok'));
    assert.ok(seen.some((s) => s.url === '/pypi/nada-py/json'));
    assert.equal(seen.filter((s) => s.url === '/npm/ok-pkg').length, 1);
  } finally {
    server.close();
  }
});
