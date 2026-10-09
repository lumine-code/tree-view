const path = require("path");

const { Emitter, CompositeDisposable, watchDirectory } = require("lumine");
const fs = require("./fs-compat");
const File = require("./file");
const { repoForPath } = require("./helpers");
const repositoryStatusObserver = require("./repository-status-observer");

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

module.exports = class Directory {
  constructor({
    name,
    fullPath,
    symlink,
    expansionState,
    isRoot,
    ignoredNames,
    useSyncFS,
    stats,
    preparedEntry,
  }) {
    this.name = name;
    this.symlink = symlink;
    this.expansionState = expansionState;
    this.isRoot = isRoot;
    this.ignoredNames = ignoredNames;
    this.ignoredByName = ignoredNames?.matches(fullPath) ?? false;
    this.useSyncFS = useSyncFS;
    this.stats = stats;
    this.destroyed = false;
    this.emitter = new Emitter();

    if (preparedEntry) {
      fullPath = preparedEntry.directoryPath ?? fullPath;
      this.squashedNames = preparedEntry.squashedNames;
    } else if (lumine.config.get("tree-view.squashDirectoryNames") && !this.isRoot) {
      fullPath = this.squashDirectoryNames(fullPath);
    }

    this.path = fullPath;
    this.realPath = preparedEntry?.realPath ?? this.path;
    if (fs.isCaseInsensitive()) {
      this.lowerCasePath = this.path.toLowerCase();
      this.lowerCaseRealPath = this.realPath.toLowerCase();
    }

    if (this.isRoot == null) {
      this.isRoot = false;
    }

    if (this.expansionState == null) {
      this.expansionState = {};
    }

    if (this.expansionState.isExpanded == null) {
      this.expansionState.isExpanded = false;
    }

    if (!(this.expansionState.entries instanceof Map)) {
      const entries = Array.isArray(this.expansionState.entries)
        ? this.expansionState.entries
        : Object.entries(this.expansionState.entries ?? {});
      this.expansionState.entries = new Map(entries);
    }

    this.status = null;
    this.entries = new Map();

    this.repositoryStatusRegistration = repositoryStatusObserver.observe(this, {
      onSnapshot: (repository, { ignoredPathsChanged }) => {
        if (ignoredPathsChanged && lumine.config.get("tree-view.hideVcsIgnoredFiles")) {
          this.applyRepositoryChange(repository);
        } else {
          this.updateStatus(repository);
        }
      },
      onRepositoryChange: (repository) => this.applyRepositoryChange(repository),
    });
    this.updateStatus(this.repositoryStatusRegistration.repository);
    if (!preparedEntry) this.loadRealPath();
  }

  destroy() {
    this.destroyed = true;
    this.unwatch();
    this.repositoryStatusRegistration.dispose();
    this.emitter.emit("did-destroy");
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  onDidStatusChange(callback) {
    return this.emitter.on("did-status-change", callback);
  }

  onDidAddEntries(callback) {
    return this.emitter.on("did-add-entries", callback);
  }

  onDidRemoveEntries(callback) {
    return this.emitter.on("did-remove-entries", callback);
  }

  onDidCollapse(callback) {
    return this.emitter.on("did-collapse", callback);
  }

  onDidExpand(callback) {
    return this.emitter.on("did-expand", callback);
  }

  loadRealPathPromise() {
    return new Promise((resolve) => this.loadRealPath(resolve));
  }

  loadRealPath(callback = null) {
    if (this.useSyncFS) {
      this.realPath = fs.realpathSync(this.path);
      if (fs.isCaseInsensitive()) {
        this.lowerCaseRealPath = this.realPath.toLowerCase();
      }
      callback?.();
    } else {
      fs.realpath(this.path, (error, realPath) => {
        if (this.destroyed) {
          callback?.();
          return;
        }
        if (error) {
          // Resolving the real path is best-effort; keep the original path and
          // carry on rather than dropping the entry. A missing path is an
          // expected race with watcher-driven moves and removals.
          if (!fs.isMissingPathError(error)) {
            console.warn(
              `tree-view: could not resolve real path for ${this.path}: ${error.message}`,
            );
          }
          callback?.();
          return;
        }
        if (realPath && realPath !== this.path) {
          this.realPath = realPath;
          if (fs.isCaseInsensitive()) {
            this.lowerCaseRealPath = this.realPath.toLowerCase();
          }
          this.updateStatus();
        }
        callback?.();
      });
    }
  }

  // Repository discovery is coordinated and time-sliced for every loaded tree
  // model. Only a directory whose owner actually changed reaches this hook.
  applyRepositoryChange(repository) {
    this.updateStatus(repository);

    // Which entries belong in the tree at all is a question only
    // `hideVcsIgnoredFiles` asks the repository, so it is the one setting whose
    // answer a newly registered repository changes. `reload` is incremental —
    // it adds and removes what differs and leaves the rest alone — so the rows
    // that stay keep their views, their expansion and their place.
    if (this.expansionState.isExpanded && lumine.config.get("tree-view.hideVcsIgnoredFiles")) {
      if (this.useSyncFS) this.reload();
      else this.reloadAsync({ rescan: true }).catch((error) => console.error(error));
    }
  }

  // Update the status property of this directory using the repo.
  updateStatus(repo = repoForPath(this.path)) {
    let newStatus = null;
    if (repo != null && repo.isPathIgnoredCached(this.path)) {
      newStatus = "ignored";
    } else if (repo != null) {
      const summary = repo.getDirectoryStatusSummary(this.path);
      if (summary != null) {
        if (summary.conflicted) {
          newStatus = "conflicted";
        } else if (summary.modified) {
          newStatus = "modified";
        } else if (summary.added) {
          newStatus = "added";
        }
      }
    }

    if (newStatus !== this.status) {
      this.status = newStatus;
      this.emitter.emit("did-status-change", newStatus);
    }
  }

  // Is the given path ignored?
  isPathIgnored(filePath) {
    if (lumine.config.get("tree-view.hideVcsIgnoredFiles")) {
      const repo = repoForPath(this.path);
      if (repo && repo.isPathIgnoredCached(filePath)) return true;
    }

    if (lumine.config.get("tree-view.hideIgnoredNames")) {
      if (this.ignoredNames.matches(filePath)) return true;
    }

    return false;
  }

  // Does given full path start with the given prefix?
  isPathPrefixOf(prefix, fullPath) {
    return fullPath.indexOf(prefix) === 0 && fullPath[prefix.length] === path.sep;
  }

  isPathEqual(pathToCompare) {
    return this.path === pathToCompare || this.realPath === pathToCompare;
  }

  // Public: Does this directory contain the given path?
  //
  // See lumine.Directory::contains for more details.
  contains(pathToCheck) {
    if (!pathToCheck) return false;

    // Normalize forward slashes to back slashes on Windows
    if (process.platform === "win32") {
      pathToCheck = pathToCheck.replace(/\//g, "\\");
    }

    let directoryPath;
    if (fs.isCaseInsensitive()) {
      directoryPath = this.lowerCasePath;
      pathToCheck = pathToCheck.toLowerCase();
    } else {
      directoryPath = this.path;
    }

    if (this.isPathPrefixOf(directoryPath, pathToCheck)) return true;

    // Check real path
    if (this.realPath !== this.path) {
      if (fs.isCaseInsensitive()) {
        directoryPath = this.lowerCaseRealPath;
      } else {
        directoryPath = this.realPath;
      }

      return this.isPathPrefixOf(directoryPath, pathToCheck);
    }

    return false;
  }

  // Public: Stop watching this directory for changes.
  unwatch() {
    this.expansionGeneration = (this.expansionGeneration || 0) + 1;
    this.cancelExpansion?.();
    this.cancelExpansion = null;
    this.expansionPromise = null;
    this.cancelListing();
    this.watchGeneration = (this.watchGeneration || 0) + 1;
    this.watchSubscriptions?.dispose();
    this.watchSubscriptions = null;
    clearTimeout(this.watchReloadTimer);
    this.watchReloadTimer = null;
    this.watchSubscription = null;

    for (let [key, entry] of this.entries) {
      entry.destroy();
      this.entries.delete(key);
    }
  }

  // Public: Watch this directory for changes.
  async watch() {
    if (this.watchSubscriptions) return;
    const generation = (this.watchGeneration || 0) + 1;
    this.watchGeneration = generation;
    const subscriptions = new CompositeDisposable();
    this.watchSubscriptions = subscriptions;
    try {
      await this.loadRealPathPromise();
      if (this.destroyed || generation !== this.watchGeneration) return;
      const reconcile = () => {
        if (this.destroyed || generation !== this.watchGeneration) return;
        if (this.watchReloadTimer) return;
        this.watchReloadTimer = setTimeout(() => {
          this.watchReloadTimer = null;
          if (this.destroyed || generation !== this.watchGeneration) return;
          if (this.useSyncFS) {
            if (!fs.existsSync(this.path)) this.destroy();
            else this.reload();
          } else {
            fs.promises
              .access(this.path)
              .then(
                () => {
                  if (!this.destroyed && generation === this.watchGeneration) {
                    return this.reloadAsync({ rescan: true });
                  }
                },
                () => {
                  if (!this.destroyed && generation === this.watchGeneration) this.destroy();
                },
              )
              .catch((error) => console.error(error));
          }
        }, 100);
      };
      const watcher = watchDirectory(this.path);
      this.watchSubscription = watcher;
      subscriptions.add(
        watcher,
        watcher.onDidChange((events) => {
          if (events.some((event) => event.action !== "updated")) reconcile();
        }),
        watcher.onDidInvalidate(reconcile),
        watcher.onDidError((error) => console.error("Unable to watch tree directory", error)),
      );
      await watcher.ready;
      reconcile();
    } catch (error) {
      if (generation === this.watchGeneration) {
        if (!isAbortError(error)) console.error(error);
        subscriptions.dispose();
        this.watchSubscriptions = null;
        this.watchSubscription = null;
      }
    }
  }

  hasEntryOfKind(name, kind) {
    const entry = this.entries.get(name);
    return kind === "directory" ? entry instanceof Directory : entry instanceof File;
  }

  getEntries() {
    let names;
    try {
      names = fs.readdirSync(this.path);
    } catch {
      names = [];
    }
    sortEntriesByName(names);

    const files = [];
    const directories = [];

    for (let name of names) {
      const fullPath = path.join(this.path, name);
      if (this.isPathIgnored(fullPath)) continue;

      let stat = fs.lstatSyncNoException(fullPath);
      const symlink = typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink();
      if (symlink) {
        stat = fs.statSyncNoException(fullPath);
      }

      if (typeof stat.isDirectory === "function" && stat.isDirectory()) {
        if (this.hasEntryOfKind(name, "directory")) {
          // push a placeholder since this entry already exists but this helps
          // track the insertion index for the created views
          directories.push(name);
        } else {
          const expansionState = this.expansionState.entries.get(name);
          directories.push(
            new Directory({
              name,
              fullPath,
              symlink,
              expansionState,
              ignoredNames: this.ignoredNames,
              useSyncFS: this.useSyncFS,
              stats: flattenStats(stat),
            }),
          );
        }
      } else if (typeof stat.isFile === "function" && stat.isFile()) {
        if (this.hasEntryOfKind(name, "file")) {
          // push a placeholder since this entry already exists but this helps
          // track the insertion index for the created views
          files.push(name);
        } else {
          files.push(
            new File({
              name,
              fullPath,
              symlink,
              ignoredByName: this.ignoredNames.matches(fullPath),
              useSyncFS: this.useSyncFS,
              stats: flattenStats(stat),
            }),
          );
        }
      }
    }

    return this.sortEntries(directories.concat(files));
  }

  compareEntries(firstName, secondName) {
    return getSortComparator()(firstName, secondName);
  }

  normalizeEntryName(value) {
    return value.name ? value.name : value;
  }

  sortEntries(combinedEntries, options = null) {
    if (options?.sortFoldersBeforeFiles ?? lumine.config.get("tree-view.sortFoldersBeforeFiles")) {
      return combinedEntries;
    } else {
      return sortEntriesByName(combinedEntries, options);
    }
  }

  // Public: Perform a synchronous reload of the directory.
  reload() {
    this.cancelListing();
    const newEntries = [];
    const removedEntries = new Map(this.entries);

    let index = 0;
    for (let entry of this.getEntries()) {
      if (this.entries.has(entry)) {
        removedEntries.delete(entry);
        index++;
        continue;
      }

      entry.indexInParentDirectory = index;
      index++;
      newEntries.push(entry);
    }

    let entriesRemoved = false;
    for (let [name, entry] of removedEntries) {
      entriesRemoved = true;
      entry.destroy();

      if (this.entries.has(name)) {
        this.entries.delete(name);
      }

      if (this.expansionState.entries.has(name)) {
        this.expansionState.entries.delete(name);
      }
    }

    // Convert removedEntries to a Set containing only the entries for O(1) lookup
    if (entriesRemoved) {
      this.emitter.emit("did-remove-entries", new Set(removedEntries.values()));
    }

    if (newEntries.length > 0) {
      for (let entry of newEntries) {
        this.entries.set(entry.name, entry);
      }
      this.emitter.emit("did-add-entries", newEntries);
    }
  }

  cancelListing() {
    this.listingGeneration = (this.listingGeneration || 0) + 1;
    const task = this.listingTask;
    this.listingTask = null;
    task?.cancel();
  }

  // Keep the synchronous API for explicit callers. Normal expansion and
  // watcher refreshes read metadata off the renderer thread. Publish each
  // completed listing once: repeated partial renders restyle the growing
  // mounted tree and cost more than the filesystem work they try to spread.
  reloadAsync({ rescan = false } = {}) {
    if (this.destroyed) return Promise.resolve();
    if (this.listingTask) {
      this.listingTask.rescan ||= rescan;
      return this.listingTask.promise;
    }
    const generation = (this.listingGeneration || 0) + 1;
    this.listingGeneration = generation;
    let cancel;
    const cancellation = new Promise((resolve) => {
      cancel = resolve;
    });
    const task = { generation, cancel, rescan: false, promise: null };
    this.listingTask = task;
    const isCurrent = () =>
      !this.destroyed && this.listingTask === task && generation === this.listingGeneration;
    task.promise = Promise.race([this.loadEntriesAsync(task, isCurrent), cancellation]).finally(
      () => {
        if (this.listingTask === task) this.listingTask = null;
      },
    );
    return task.promise;
  }

  async loadEntriesAsync(task, isCurrent) {
    const readDirectoryEntries = require("./directory-reader");
    do {
      task.rescan = false;
      const options = {
        sortMethod: lumine.config.get("tree-view.sortMethod"),
        sortByBase: lumine.config.get("tree-view.sortByBase"),
        sortFoldersBeforeFiles: lumine.config.get("tree-view.sortFoldersBeforeFiles"),
      };
      const hideNames = lumine.config.get("tree-view.hideIgnoredNames");
      const repository = lumine.config.get("tree-view.hideVcsIgnoredFiles")
        ? repoForPath(this.path)
        : null;
      const records = await readDirectoryEntries(this, {
        isCurrent,
        isPathIgnored: (fullPath) =>
          repository?.isPathIgnoredCached(fullPath) ||
          (hideNames && this.ignoredNames.matches(fullPath)),
      });
      if (!isCurrent()) return;
      sortEntriesByName(records, options);
      const directories = records.filter((record) => record.kind === "directory");
      const files = records.filter((record) => record.kind === "file");
      const ordered = this.sortEntries(directories.concat(files), options);
      const removed = new Map(this.entries);
      for (const record of ordered) {
        if (this.hasEntryOfKind(record.name, record.kind)) {
          removed.delete(record.name);
        }
      }
      for (const [name, entry] of removed) {
        entry.destroy();
        this.entries.delete(name);
        this.expansionState.entries.delete(name);
      }
      if (removed.size) this.emitter.emit("did-remove-entries", new Set(removed.values()));
      if (!isCurrent()) return;

      const newEntries = [];
      for (let index = 0; index < ordered.length; index++) {
        if (!isCurrent()) return;
        const record = ordered[index];
        if (!this.entries.has(record.name)) {
          const common = {
            name: record.name,
            fullPath: record.fullPath,
            symlink: record.symlink,
            useSyncFS: this.useSyncFS,
            stats: flattenStats(record.stat),
          };
          const entry =
            record.kind === "directory"
              ? new Directory({
                  ...common,
                  expansionState: this.expansionState.entries.get(record.name),
                  ignoredNames: this.ignoredNames,
                  preparedEntry: record,
                })
              : new File({
                  ...common,
                  ignoredByName: this.ignoredNames.matches(record.fullPath),
                  realPath: record.realPath,
                });
          if (!isCurrent()) {
            entry.destroy();
            return;
          }
          entry.indexInParentDirectory = index;
          this.entries.set(entry.name, entry);
          newEntries.push(entry);
        }
      }
      if (newEntries.length && isCurrent()) this.emitter.emit("did-add-entries", newEntries);
    } while (task.rescan && isCurrent());
    // Release ownership before the async function fulfills. A refresh queued
    // by the final add event must start a fresh scan, not join an already
    // finished task whose promise still has completion microtasks pending.
    if (this.listingTask === task) this.listingTask = null;
  }

  // Public: Collapse this directory and stop watching it.
  collapse() {
    this.expansionState.isExpanded = false;
    this.expansionState = this.serializeExpansionState();
    this.unwatch();
    this.emitter.emit("did-collapse");
  }

  // Public: Expand this directory, load its children, and start watching it for
  // changes.
  expand() {
    if (this.destroyed) return Promise.resolve();
    if (this.expansionPromise) return this.expansionPromise;
    this.expansionState.isExpanded = true;
    const generation = this.expansionGeneration || 0;
    try {
      if (this.useSyncFS) this.reload();
    } catch (error) {
      return Promise.reject(error);
    }
    const loading = this.useSyncFS ? Promise.resolve() : this.reloadAsync();
    this.entriesLoadedPromise = loading;
    let cancel;
    const cancellation = new Promise((resolve) => {
      cancel = resolve;
    });
    this.cancelExpansion = cancel;
    const isCurrent = () =>
      !this.destroyed &&
      this.expansionState.isExpanded &&
      generation === (this.expansionGeneration || 0);
    const operation = loading.then(async () => {
      if (!isCurrent()) return;
      await this.watch();
      if (isCurrent()) this.emitter.emit("did-expand");
    });
    const promise = Promise.race([operation, cancellation]).finally(() => {
      if (this.expansionPromise === promise) {
        this.expansionPromise = null;
        this.cancelExpansion = null;
      }
    });
    this.expansionPromise = promise;
    return promise;
  }

  serializeExpansionState({ forStorage = false } = {}) {
    const expansionState = {
      isExpanded: this.expansionState.isExpanded,
      // A collapsed directory has no live entries, but its cached descendants
      // still describe what should reopen the next time it is expanded.
      entries: new Map(this.expansionState.entries),
    };
    for (let [name, entry] of this.entries) {
      if (entry.expansionState == null) continue;
      expansionState.entries.set(name, entry.serializeExpansionState());
    }
    return forStorage ? expansionStateForStorage(expansionState) : expansionState;
  }

  squashDirectoryNames(fullPath) {
    const squashedDirs = [this.name];
    let contents;
    while (true) {
      try {
        contents = fs.listSync(fullPath);
      } catch {
        break;
      }

      if (contents.length !== 1) break;
      if (!fs.isDirectorySync(contents[0])) break;
      const relativeDir = path.relative(fullPath, contents[0]);
      squashedDirs.push(relativeDir);
      fullPath = path.join(fullPath, relativeDir);
    }

    if (squashedDirs.length > 1) {
      this.squashedNames = [
        squashedDirs.slice(0, squashedDirs.length - 1).join(path.sep) + path.sep,
        squashedDirs[squashedDirs.length - 1],
      ];
    }

    return fullPath;
  }

  filePathIsChildOfDirectory(filePath) {
    let dirname = path.dirname(filePath);
    return this.path === dirname || this.realPath === dirname;
  }
};

function flattenStats(stat) {
  // Existing entries keep their model and stats; only new models need a copy.
  // Node 24 stores dates in prototype getters, so copy them explicitly.
  const result = Object.assign({}, stat);
  for (const key of ["atime", "birthtime", "ctime", "mtime"]) {
    const date = stat[key];
    result[key] = date && date.getTime();
  }
  return result;
}

function expansionStateForStorage(expansionState) {
  const entries = expansionState?.entries;
  let pairs;
  if (entries instanceof Map || Array.isArray(entries)) {
    pairs = entries;
  } else {
    pairs = Object.entries(entries ?? {});
  }

  return {
    isExpanded: expansionState?.isExpanded === true,
    entries: Array.from(pairs, ([name, state]) => [name, expansionStateForStorage(state)]),
  };
}

const naturalCompare = require("natural-compare-lite");
const collatorCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
  .compare;

function getCompareFn(method = lumine.config.get("tree-view.sortMethod")) {
  return method === "natural" ? naturalCompare : collatorCompare;
}

function parseEntryName(value) {
  const name = typeof value === "string" ? value : value.name || "";
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return { base: name.slice(0, dot).toLowerCase(), ext: name.slice(dot).toLowerCase() };
  }
  return { base: name.toLowerCase(), ext: "" };
}

function getSortComparator() {
  const cmp = getCompareFn();
  const byBase = lumine.config.get("tree-view.sortByBase");
  if (byBase) {
    return (first, second) => {
      const a = parseEntryName(first);
      const b = parseEntryName(second);
      const result = cmp(a.base, b.base);
      return result !== 0 ? result : cmp(a.ext, b.ext);
    };
  }
  return (first, second) => {
    const a = typeof first === "string" ? first.toLowerCase() : (first.name || "").toLowerCase();
    const b = typeof second === "string" ? second.toLowerCase() : (second.name || "").toLowerCase();
    return cmp(a, b);
  };
}

function sortEntriesByName(entries, options = null) {
  if (entries.length < 2) return entries;
  const cmp = getCompareFn(options?.sortMethod);
  const byBase = options?.sortByBase ?? lumine.config.get("tree-view.sortByBase");
  // Parse/lowercase each name once, rather than allocating keys for every
  // comparison. Keep this cache scoped to the sort so renamed entries and
  // changed settings are picked up by the next directory reload.
  const keyedEntries = entries.map((value) => {
    const key = byBase
      ? parseEntryName(value)
      : {
          base: (typeof value === "string" ? value : value.name || "").toLowerCase(),
          ext: "",
        };
    return { value, ...key };
  });
  keyedEntries.sort((first, second) => {
    const result = cmp(first.base, second.base);
    return byBase && result === 0 ? cmp(first.ext, second.ext) : result;
  });
  for (let index = 0; index < entries.length; index++) {
    entries[index] = keyedEntries[index].value;
  }
  return entries;
}
