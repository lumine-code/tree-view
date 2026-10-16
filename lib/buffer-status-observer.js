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
    const state = {
      key: null,
      path: null,
      subscriptions: new CompositeDisposable(),
      pendingSave: null,
    };
    this.buffers.set(buffer, state);
    const update = () => this.updateBuffer(buffer, state);
    state.subscriptions.add(
      buffer.onDidChangeFileState((fileState) => {
        if (fileState === "unmodified") {
          // A successful save emits did-save immediately after this event.
          queueMicrotask(() => {
            if (this.buffers.get(buffer) === state) update();
          });
        } else update();
      }),
      buffer.onDidSave(() => {
        const filePath = buffer.getPath();
        const repository = lumine.repositories.getForPath(filePath);
        if (!state.key || !repository?.refreshStatusSnapshot) return;
        const pending = { path: filePath };
        state.pendingSave = pending;
        const finish = () => {
          if (this.buffers.get(buffer) !== state || state.pendingSave !== pending) return;
          state.pendingSave = null;
          update();
        };
        repository.refreshStatusSnapshot().then(finish, finish);
      }),
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
      !destroyed &&
      (fileState === "modified" ||
        fileState === "conflicted" ||
        state.pendingSave?.path === buffer.getPath())
        ? buffer.getPath()
        : null;
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

  hasModifiedDescendant(directoryPath, owner = lumine.repositories.getForPath(directoryPath)) {
    if (!owner) return false;
    const key = pathKey(directoryPath);
    const prefix = key.endsWith(path.sep) ? key : key + path.sep;
    for (const [fileKey, buffers] of this.modifiedPaths) {
      if (!fileKey.startsWith(prefix)) continue;
      const filePath = buffers.values().next().value;
      const repository = lumine.repositories.getForPath(filePath);
      // A nested checkout belongs to itself, never to its containing project.
      if (repository !== owner) continue;
      const summary = lumine.repositories.getBufferStatusSummary(filePath, {
        repository,
        fileState: "modified",
      });
      if (summary?.bufferModified) return true;
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
