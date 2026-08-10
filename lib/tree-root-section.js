const path = require("path");
const fs = require("./fs-compat");
const Directory = require("./directory");
const File = require("./file");
const IgnoredNames = require("./ignored-names");
const TreeEntry = require("./tree-entry");

function pathKey(entryPath) {
  const normalized = path.normalize(entryPath);
  return fs.isCaseInsensitive() ? normalized.toLowerCase() : normalized;
}

// The date fields are prototype getters as of Node 24, so a plain spread drops
// them. `Directory` and `File` both expect the flattened shape.
function flattenStats(stats) {
  const flat = Object.assign({}, stats);
  for (const key of ["atime", "birthtime", "ctime", "mtime"]) {
    flat[key] = stats[key] && stats[key].getTime();
  }
  return flat;
}

module.exports = class TreeRootSection {
  constructor(treeView, config, expansionStates = new Map()) {
    this.treeView = treeView;
    this.config = config;
    this.expansionStates = expansionStates;
    this.isExpanded = true;
    this.isVisible = true;
    this.entries = [];
    this.entriesByPath = new Map();
    this.ignoredNames = new IgnoredNames();

    this.element = document.createElement("ol");
    this.element.classList.add(config.className, "tree-view-special", "list-tree");
    const firstProjectRow = Array.from(this.treeView.list.children).find((child) =>
      child.classList.contains("tree-view-row"),
    );
    this.treeView.list.insertBefore(this.element, firstProjectRow ?? null);

    const syntheticPath = `special-root://${config.name.toLowerCase().replace(/\s+/g, "-")}`;
    const item = {
      name: config.name,
      path: syntheticPath,
      status: null,
      contains: () => false,
      isPathEqual: (pathToCompare) => pathToCompare === syntheticPath,
      getEntries: () => config.getEntries(),
    };
    this.root = new TreeEntry(treeView, {
      item,
      kind: "directory",
      specialRoot: true,
      section: this,
      name: config.name,
      rootClassName: `${config.className}-root`,
      iconClass: config.iconClass,
    });
    this.root.isExpanded = true;
    this.treeView.registerTreeEntry(this.root, { project: false });
    this.refresh();
  }

  expand() {
    if (this.isExpanded) return Promise.resolve();
    this.isExpanded = true;
    this.root.isExpanded = true;
    this.refresh();
    return Promise.resolve();
  }

  collapse() {
    if (!this.isExpanded) return;
    this.isExpanded = false;
    this.root.isExpanded = false;
    this.treeView.releaseSelectionInSection(this);
    this.treeView.rebuildVisibleRows();
  }

  toggleExpansion() {
    if (this.isExpanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  // Build the entry for one pinned path. A directory is backed by the same
  // `Directory` model a project root uses, so it expands, watches, sorts and
  // reports Git status exactly like the rest of the tree.
  createEntry(entryPath) {
    const name = path.basename(entryPath) || entryPath;
    let stats = fs.lstatSyncNoException(entryPath);
    const symlink = Boolean(stats) && stats.isSymbolicLink();
    if (symlink) stats = fs.statSyncNoException(entryPath);
    const exists = Boolean(stats);
    const isDirectory = exists && stats.isDirectory();
    const flatStats = exists ? flattenStats(stats) : undefined;

    if (isDirectory) {
      const directory = new Directory({
        name,
        fullPath: entryPath,
        symlink,
        // A pinned folder names itself; squashing would relabel it after a
        // descendant, so opt out the way a project root does.
        isRoot: true,
        expansionState: this.expansionStates.get(pathKey(entryPath)) ?? { isExpanded: false },
        ignoredNames: this.ignoredNames,
        useSyncFS: this.treeView.useSyncFS,
        stats: flatStats,
      });
      return this.treeView.createDirectoryTreeEntry(directory, this.root, {
        special: true,
        section: this,
        entryClassName: this.config.entryClassName,
      });
    }

    const file = new File({
      name,
      fullPath: entryPath,
      symlink,
      ignoredByName: this.ignoredNames.matches(entryPath),
      useSyncFS: this.treeView.useSyncFS,
      stats: flatStats,
    });
    return this.treeView.createFileTreeEntry(file, this.root, {
      special: true,
      section: this,
      entryClassName: this.config.entryClassName,
      exists,
    });
  }

  destroyEntry(entry) {
    this.rememberExpansionState(entry);
    entry.item?.destroy?.();
    this.treeView.unregisterTreeEntry(entry);
  }

  rememberExpansionState(entry) {
    if (entry.kind !== "directory") return;
    const state = entry.item?.serializeExpansionState?.();
    if (state) this.expansionStates.set(pathKey(entry.getPath()), state);
  }

  // A pinned entry survives a refresh whenever its path and kind are unchanged,
  // so expanding a folder is not undone by the next store write.
  isReusable(entry, entryPath) {
    if (entry.getPath() !== entryPath) return false;
    const isDirectory = fs.isDirectorySync(entryPath);
    if (isDirectory !== (entry.kind === "directory")) return false;
    if (entry.kind === "file" && entry.exists !== fs.existsSync(entryPath)) return false;
    return !entry.item?.destroyed;
  }

  refresh() {
    const kept = new Map();
    const entries = [];

    for (const entryPath of this.config.getEntries()) {
      const key = pathKey(entryPath);
      if (kept.has(key)) continue;
      const existing = this.entriesByPath.get(key);
      let entry;
      if (existing && this.isReusable(existing, entryPath)) {
        entry = existing;
      } else {
        if (existing) this.destroyEntry(existing);
        entry = this.createEntry(entryPath);
      }
      kept.set(key, entry);
      entries.push(entry);
    }

    for (const [key, entry] of this.entriesByPath) {
      if (kept.get(key) !== entry) this.destroyEntry(entry);
    }

    this.entriesByPath = kept;
    this.entries = entries;
    this.root.children = this.entries;
    this.treeView.rebuildVisibleRows();
  }

  toggleVisible() {
    this.isVisible = !this.isVisible;
    if (!this.isVisible) this.treeView.releaseSelectionInSection(this);
    this.treeView.rebuildVisibleRows();
  }

  isRenderable() {
    return this.isVisible && this.entries.length > 0;
  }

  destroy() {
    for (const entry of this.entries) {
      this.rememberExpansionState(entry);
      entry.item?.destroy?.();
    }
    this.root.children = this.entries;
    this.treeView.unregisterTreeEntry(this.root);
    this.entries = [];
    this.entriesByPath.clear();
    this.element.remove();
  }
};
