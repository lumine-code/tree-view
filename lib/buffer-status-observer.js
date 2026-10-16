const path = require("path");
const { CompositeDisposable, Disposable } = require("lumine");

function pathKey(filePath) {
  if (!filePath) return null;
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// One subscription per project buffer, shared by every loaded tree entry.
// Notify only that file and its ancestors when its persistence state changes;
// typing must not scan or rebuild the entire tree.
class BufferStatusObserver {
  constructor() {
    this.listeners = new Map();
    this.buffers = new Map();
    this.modifiedPaths = new Map();
  }

  observe(model, callback) {
    if (!this.subscription) {
      this.subscription = lumine.project.observeBuffers((buffer) => this.observeBuffer(buffer));
    }
    const key = pathKey(model.path);
    let listeners = this.listeners.get(key);
    if (!listeners) this.listeners.set(key, (listeners = new Set()));
    listeners.add(callback);
    return new Disposable(() => {
      listeners.delete(callback);
      if (!listeners.size) this.listeners.delete(key);
      if (!this.listeners.size) this.dispose();
    });
  }

  observeBuffer(buffer) {
    if (this.buffers.has(buffer)) return;
    const state = { key: null, path: null, subscriptions: new CompositeDisposable() };
    this.buffers.set(buffer, state);
    const update = () => this.updateBuffer(buffer, state);
    state.subscriptions.add(
      buffer.onDidChangeFileState(update),
      buffer.onDidChangePath(update),
      buffer.onDidDestroy(() => {
        this.buffers.delete(buffer);
        state.subscriptions.dispose();
        this.updateBuffer(buffer, state, true);
      }),
    );
    update();
  }

  updateBuffer(buffer, state, destroyed = false) {
    const fileState = destroyed ? null : buffer.getFileState();
    const filePath =
      fileState === "modified" || fileState === "conflicted" ? buffer.getPath() : null;
    const key = pathKey(filePath);
    if (key === state.key) return;
    const oldKey = state.key;
    if (oldKey) {
      const buffers = this.modifiedPaths.get(oldKey);
      buffers.delete(buffer);
      if (!buffers.size) this.modifiedPaths.delete(oldKey);
    }
    state.key = key;
    state.path = filePath;
    if (key) {
      let buffers = this.modifiedPaths.get(key);
      if (!buffers) this.modifiedPaths.set(key, (buffers = new Map()));
      buffers.set(buffer, filePath);
    }
    const callbacks = new Set();
    for (let current of [oldKey, key]) {
      while (current) {
        for (const callback of this.listeners.get(current) ?? []) callbacks.add(callback);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    for (const callback of callbacks) callback();
  }

  isModified(filePath) {
    return this.modifiedPaths.has(pathKey(filePath));
  }

  hasModifiedDescendant(directoryPath) {
    const key = pathKey(directoryPath);
    const prefix = key.endsWith(path.sep) ? key : key + path.sep;
    for (const [fileKey, buffers] of this.modifiedPaths) {
      if (!fileKey.startsWith(prefix)) continue;
      const filePath = buffers.values().next().value;
      const repository = lumine.repositories.getForPath(filePath);
      if (repository?.isPathIgnoredCached(filePath)) continue;
      // An added file keeps its own Git status, including in its ancestors.
      if (repository?.getPathStatusSummary(filePath)?.added) continue;
      return true;
    }
    return false;
  }

  dispose() {
    this.subscription?.dispose();
    this.subscription = null;
    for (const state of this.buffers.values()) state.subscriptions.dispose();
    this.buffers.clear();
    this.modifiedPaths.clear();
    this.listeners.clear();
  }
}

module.exports = new BufferStatusObserver();
module.exports.BufferStatusObserver = BufferStatusObserver;
