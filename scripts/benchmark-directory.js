// Measure the actual Directory listing/reconciliation implementation without UI
// or Git status work. Compare a saved baseline against the current checkout:
// node scripts/benchmark-directory.js --baseline ../.dev/<run>/directory-baseline.js --output ../.dev/<run>/results.json
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
}
const baselinePath = option("baseline");
assert(baselinePath, "Pass --baseline with the saved directory.js source");
const sources = {
  baseline: fs.readFileSync(path.resolve(baselinePath), "utf8"),
  current: fs.readFileSync(path.join(root, "lib", "directory.js"), "utf8"),
};
const runtime = require(
  path.join(root, "..", "lumine", "node_modules", "@lumine-code", "event-kit"),
);
const fsCompat = require("../lib/fs-compat");
const defaults = Object.fromEntries(
  Object.entries(require("../package.json").configSchema).map(([key, schema]) => [
    key,
    schema.default,
  ]),
);
const settings = { ...defaults };
global.lumine = { config: { get: (key) => settings[key.replace("tree-view.", "")] } };
const observer = { observe: () => ({ repository: null, dispose() {} }) };
function load(source, file, adapter) {
  const filename = path.join(root, "lib", file);
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = compiled.require.bind(compiled);
  compiled.require = (id) => {
    if (id === "lumine") return runtime;
    if (id === "./fs-compat") return adapter;
    if (id === "./helpers") return { repoForPath: () => null };
    if (id === "./repository-status-observer") return observer;
    if (id === "./file")
      return load(fs.readFileSync(path.join(root, "lib", "file.js"), "utf8"), "file.js", adapter);
    return originalRequire(id);
  };
  compiled._compile(source, filename);
  return compiled.exports;
}
function percentile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}
function summary(values) {
  return { medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samplesMs: values };
}
function namesFor(count) {
  return Array.from({ length: count }, (_, index) => {
    const number = (index * 7919) % count;
    return `${index % 3 === 0 ? "Module" : "component"}-${number}.${["js", "test.js", "d.ts", "json"][index % 4]}`;
  });
}
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-benchmark-"));
const report = {
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0].model,
  sourceSha256: Object.fromEntries(
    Object.entries(sources).map(([label, source]) => [
      label,
      crypto.createHash("sha256").update(source).digest("hex"),
    ]),
  ),
  methodology:
    "Alternating baseline/current order, 3 warmups, 15 samples. Listing CPU uses cached native Stats and no disk reads; filesystem reload uses actual readdir/lstat. Git observers and UI are excluded. Filesystem cache is warm.",
  results: [],
};
try {
  for (const count of [100, 1000, 10000]) {
    const directoryPath = path.join(temporaryRoot, String(count));
    fs.mkdirSync(directoryPath);
    const names = namesFor(count);
    for (let index = 0; index < names.length; index++) {
      const target = path.join(directoryPath, names[index]);
      if (index % 5 === 0) fs.mkdirSync(target);
      else fs.writeFileSync(target, "benchmark\n");
    }
    const stats = new Map(
      names.map((name) => [
        path.join(directoryPath, name),
        fs.lstatSync(path.join(directoryPath, name)),
      ]),
    );
    for (const sortMethod of ["default", "natural"]) {
      for (const sortFoldersBeforeFiles of [true, false]) {
        Object.assign(settings, { sortMethod, sortFoldersBeforeFiles });
        for (const mode of ["listing-cpu", "filesystem-reload"]) {
          const adapters = Object.fromEntries(
            Object.keys(sources).map((label) => [
              label,
              mode === "listing-cpu"
                ? {
                    ...fsCompat,
                    readdirSync: () => names.slice(),
                    lstatSyncNoException: (fullPath) => stats.get(fullPath),
                  }
                : fsCompat,
            ]),
          );
          const directories = Object.fromEntries(
            Object.entries(sources).map(([label, source]) => {
              const Directory = load(source, "directory.js", adapters[label]);
              const directory = new Directory({
                name: "root",
                fullPath: directoryPath,
                isRoot: true,
                useSyncFS: true,
                ignoredNames: { matches: () => false },
              });
              directory.reload();
              return [label, directory];
            }),
          );
          const samples = { baseline: [], current: [] };
          let expected;
          for (let iteration = -3; iteration < 15; iteration++) {
            for (const label of iteration % 2 === 0
              ? ["baseline", "current"]
              : ["current", "baseline"]) {
              const directory = directories[label];
              const start = performance.now();
              const listing = mode === "listing-cpu" ? directory.getEntries() : directory.reload();
              const elapsed = performance.now() - start;
              const entries = mode === "listing-cpu" ? listing : directory.getEntries();
              const orderedNames = entries.map((entry) =>
                typeof entry === "string" ? entry : entry.name,
              );
              if (!expected) expected = orderedNames;
              assert.deepEqual(orderedNames, expected, `${label} changed ordering`);
              assert.equal(directory.entries.size, count);
              if (iteration >= 0) samples[label].push(elapsed);
            }
          }
          for (const directory of Object.values(directories)) directory.destroy();
          const result = {
            count,
            sortMethod,
            sortFoldersBeforeFiles,
            mode,
            baseline: summary(samples.baseline),
            current: summary(samples.current),
          };
          result.improvementPercent =
            100 * (1 - result.current.medianMs / result.baseline.medianMs);
          report.results.push(result);
          console.log(
            `${mode} ${count} ${sortMethod} folders=${sortFoldersBeforeFiles}: ${result.baseline.medianMs.toFixed(3)} -> ${result.current.medianMs.toFixed(3)} ms (${result.improvementPercent.toFixed(1)}%)`,
          );
        }
      }
    }
  }
  const output = path.resolve(option("output", path.join(temporaryRoot, "results.json")));
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Results: ${output}`);
} finally {
  // Only this process's newly created fixture directory is removed.
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
