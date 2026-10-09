const path = require("path");
const fs = require("./fs-compat");

// Read filesystem facts without creating models or publishing partial results.
// Workers write at readdir indices so I/O completion cannot change stable ties.
module.exports = async function readDirectoryEntries(
  directory,
  {
    isCurrent = () => true,
    concurrency = 16,
    isPathIgnored = (fullPath) => directory.isPathIgnored(fullPath),
    squashDirectoryNames = lumine.config.get("tree-view.squashDirectoryNames"),
  } = {},
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Directory reader concurrency must be a positive integer");
  }
  if (!isCurrent()) return [];

  await directory.loadRealPathPromise();
  if (!isCurrent()) return [];

  let names;
  try {
    names = await fs.promises.readdir(directory.path);
  } catch {
    return [];
  }
  if (!isCurrent()) return [];

  const entries = new Array(names.length);
  let nextIndex = 0;
  async function worker() {
    while (isCurrent() && nextIndex < names.length) {
      const index = nextIndex++;
      const name = names[index];
      const fullPath = path.join(directory.path, name);
      const ignored = isPathIgnored(fullPath);
      if (!isCurrent()) return;
      if (ignored) continue;

      let stat = await statNoException("lstat", fullPath);
      if (!isCurrent()) return;
      if (!stat) continue;
      const symlink = stat.isSymbolicLink();
      if (symlink) {
        stat = await statNoException("stat", fullPath);
        if (!isCurrent()) return;
        if (!stat) continue;
      }

      const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
      if (!kind) continue;
      const entry = { name, fullPath, stat, symlink, kind };
      const existing = directory.entries?.get(name);
      if (directory.hasEntryOfKind(name, kind)) {
        // Reload keeps the same models and paths. Their fresh stat above still
        // filters missing entries and broken links, but preparation is only
        // needed for a new model that will consume its result.
        entry.realPath = existing.realPath ?? path.join(directory.realPath, name);
        if (kind === "directory") {
          if (existing.path !== fullPath) entry.directoryPath = existing.path;
          if (existing.squashedNames) entry.squashedNames = existing.squashedNames;
        }
        entries[index] = entry;
        continue;
      }
      let resolvedPath = fullPath;
      if (kind === "directory" && squashDirectoryNames) {
        const squashed = await squashDirectory(name, fullPath, isCurrent);
        if (!isCurrent()) return;
        if (squashed) {
          entry.directoryPath = squashed.directoryPath;
          entry.squashedNames = squashed.squashedNames;
          resolvedPath = squashed.directoryPath;
        }
      }

      if (symlink || entry.directoryPath) {
        entry.realPath = await realPathOrOriginal(resolvedPath, isCurrent);
        if (!isCurrent()) return;
      } else {
        // The parent is already canonical. Ordinary children need no separate
        // realpath request, which also keeps model construction free of I/O.
        entry.realPath = path.join(directory.realPath, name);
      }
      entries[index] = entry;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, () => worker()));
  return isCurrent() ? entries.filter(Boolean) : [];
};

async function statNoException(method, fullPath) {
  try {
    return await fs.promises[method](fullPath);
  } catch {
    return false;
  }
}

async function realPathOrOriginal(fullPath, isCurrent) {
  try {
    return await fs.promises.realpath(fullPath);
  } catch (error) {
    if (isCurrent() && !fs.isMissingPathError(error)) {
      console.warn(`tree-view: could not resolve real path for ${fullPath}: ${error.message}`);
    }
    return fullPath;
  }
}

async function squashDirectory(name, fullPath, isCurrent) {
  const names = [name];
  let directoryPath = fullPath;
  while (isCurrent()) {
    let contents;
    try {
      contents = await fs.promises.readdir(directoryPath);
    } catch {
      break;
    }
    if (!isCurrent() || contents.length !== 1) break;

    const nextPath = path.join(directoryPath, contents[0]);
    const stat = await statNoException("stat", nextPath);
    if (!isCurrent() || !stat || !stat.isDirectory()) break;

    names.push(path.relative(directoryPath, nextPath));
    directoryPath = nextPath;
  }

  if (names.length < 2) return null;
  return {
    directoryPath,
    squashedNames: [names.slice(0, -1).join(path.sep) + path.sep, names[names.length - 1]],
  };
}
