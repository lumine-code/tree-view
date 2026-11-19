const { Emitter } = require("lumine");
const { repoForPath } = require("./helpers");

const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_TIME_SLICE_MS = 4;

function scheduleImmediate(callback) {
  const handle = setImmediate(callback);
  return () => clearImmediate(handle);
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function ignoredPathsSignature(repository) {
  const snapshot = repository.getStatusSnapshot?.();
  if (!snapshot) return null;
  return `${Boolean(snapshot.initialized)}:${Boolean(snapshot.includesIgnored)}:${(
    snapshot.files ?? []
  )
    .filter((entry) => entry.ignored)
    .map((entry) => entry.path)
    .join("\0")}`;
}

function belowChangedDirectory(key, directories) {
  for (let current = key; ;) {
    if (directories.has(current)) return true;
    const separator = current.lastIndexOf("/");
    if (separator === -1) return false;
    current = current.slice(0, separator);
  }
}

// Directory/File instances exist only for the loaded portion of the tree. Keep
// those models behind one listener per repository, then spread cache reads and
// DOM notifications over event-loop turns instead of running them in the
// repository emitter's synchronous callback.
class RepositoryStatusObserver {
  constructor({
    getRepository = repoForPath,
    schedule = scheduleImmediate,
    now = monotonicNow,
    batchSize = DEFAULT_BATCH_SIZE,
    timeSliceMs = DEFAULT_TIME_SLICE_MS,
  } = {}) {
    this.getRepository = getRepository;
    this.schedule = schedule;
    this.now = now;
    this.batchSize = batchSize;
    this.timeSliceMs = timeSliceMs;

    this.registrations = new Set();
    this.repositoryStates = new Map();
    this.emitter = new Emitter();
    this.tasks = [];
    this.scheduledCancel = null;
    this.routingVersion = 0;
    this.routingTask = null;
    this.routingPending = false;
    this.destroyed = false;
  }

  observe(model, { directory = false, onSnapshot, onRepositoryChange = onSnapshot }) {
    if (this.destroyed) throw new Error("Cannot observe a destroyed repository status observer");

    const registration = {
      model,
      directory,
      key: null,
      onSnapshot,
      onRepositoryChange,
      repository: null,
      version: 0,
      disposed: false,
    };
    this.registrations.add(registration);
    this.rebind(registration, this.getRepository(model.path));

    return {
      get repository() {
        return registration.repository;
      },
      dispose: () => this.disposeRegistration(registration),
    };
  }

  onDidChangeIgnoredPaths(callback) {
    return this.emitter.on("did-change-ignored-paths", callback);
  }

  rebind(registration, repository) {
    if (registration.repository === repository) return false;

    this.removeFromRepository(registration);
    registration.repository = repository;
    registration.version++;
    if (repository == null) return true;

    let state = this.repositoryStates.get(repository);
    if (state == null) {
      state = {
        repository,
        registrations: new Set(),
        paths: new Map(),
        pending: new Set(),
        reset: false,
        version: 0,
        task: null,
        subscription: null,
        ignoredSignature: null,
        legacyIgnoredPathsChanged: false,
      };
      this.repositoryStates.set(repository, state);
      if (repository.onDidChangeStatusPaths && repository.getStatusPathKey) {
        state.subscription = repository.onDidChangeStatusPaths((change) => {
          this.repositorySnapshotChanged(state, change);
        });
      } else {
        state.ignoredSignature = ignoredPathsSignature(repository);
        state.subscription = repository.onDidChangeStatusSnapshot(() => {
          this.repositorySnapshotChanged(state);
        });
      }
    }
    state.registrations.add(registration);
    registration.key = repository.getStatusPathKey?.(registration.model.path) ?? null;
    if (registration.key != null) {
      let group = state.paths.get(registration.key);
      if (!group) state.paths.set(registration.key, (group = new Set()));
      group.add(registration);
    }
    return true;
  }

  removeFromRepository(registration) {
    const repository = registration.repository;
    if (repository == null) return;

    const state = this.repositoryStates.get(repository);
    state?.registrations.delete(registration);
    state?.pending.delete(registration);
    const group = state?.paths.get(registration.key);
    if (group?.delete(registration) && group.size === 0) state.paths.delete(registration.key);
    registration.key = null;
    registration.repository = null;
    registration.version++;

    if (state?.registrations.size === 0) {
      state.subscription?.dispose();
      state.subscription = null;
      if (state.task != null) state.task.entries = [];
      this.repositoryStates.delete(repository);
    }
  }

  disposeRegistration(registration) {
    if (registration.disposed) return;

    registration.disposed = true;
    registration.version++;
    this.registrations.delete(registration);
    this.removeFromRepository(registration);
  }

  repositorySnapshotChanged(state, change) {
    if (this.repositoryStates.get(state.repository) !== state) return;

    let affected;
    if (change) {
      state.reset ||= change.reset;
      affected = change.reset;
      let visibilityChanged = change.reset;
      if (!state.reset) {
        for (const key of change.files) {
          affected = this.queuePath(state, key, false) || affected;
          affected = this.queueAncestorDirectories(state, key) || affected;
        }
        for (const key of change.directories)
          affected = this.queuePath(state, key, true) || affected;
        for (const key of change.ignoredFiles) {
          visibilityChanged = this.queuePath(state, key) || visibilityChanged;
          affected = this.queueAncestorDirectories(state, key) || affected;
        }
        if (change.ignoredDirectories.length > 0) {
          const roots = new Set(change.ignoredDirectories);
          for (const key of roots) affected = this.queueAncestorDirectories(state, key) || affected;
          for (const key of state.paths.keys()) {
            if (belowChangedDirectory(key, roots)) {
              visibilityChanged = this.queuePath(state, key) || visibilityChanged;
            }
          }
        }
        affected ||= visibilityChanged;
      }
      // A loaded parent can filter a child owned by another repository.
      // This also covers a root whose model path is a squashed descendant.
      if (!visibilityChanged) {
        const hasLoadedParent = (key) => {
          const parent = key.slice(0, Math.max(0, key.lastIndexOf("/")));
          for (const registration of state.paths.get(parent) ?? []) {
            if (registration.directory) return true;
          }
          return false;
        };
        visibilityChanged =
          change.ignoredFiles.some(hasLoadedParent) ||
          change.ignoredDirectories.some(hasLoadedParent);
      }
      if (visibilityChanged) {
        this.emitter.emit("did-change-ignored-paths", state.repository);
      }
    } else {
      state.reset = true;
      affected = true;
      const signature = ignoredPathsSignature(state.repository);
      if (signature !== state.ignoredSignature) {
        state.ignoredSignature = signature;
        state.legacyIgnoredPathsChanged = true;
      }
    }
    if (!affected) return;
    state.version++;
    if (state.task == null) {
      state.task = {
        kind: "snapshot",
        state,
        entries: [],
        index: 0,
        runVersion: -1,
        routingVersion: -1,
        queued: false,
      };
      this.enqueue(state.task);
    }
  }

  queuePath(state, key, directoriesOnly) {
    let affected = false;
    for (const registration of state.paths.get(key) ?? []) {
      if (directoriesOnly === undefined || registration.directory === directoriesOnly) {
        state.pending.add(registration);
        affected = true;
      }
    }
    return affected;
  }

  queueAncestorDirectories(state, key) {
    // A file becoming ignored, conflicted or untracked can also change the
    // directory's unsaved-buffer overlay while its saved aggregate is stable.
    let affected = false;
    for (let parent = key; parent;) {
      const separator = parent.lastIndexOf("/");
      parent = separator === -1 ? "" : parent.slice(0, separator);
      affected = this.queuePath(state, parent, true) || affected;
    }
    return affected;
  }

  repositoriesChanged() {
    if (this.destroyed) return;

    this.routingVersion++;
    this.routingPending = true;
    if (this.routingTask == null) {
      this.routingTask = {
        kind: "routing",
        entries: [],
        index: 0,
        runVersion: -1,
        queued: false,
      };
      this.enqueue(this.routingTask, { priority: true });
    }
  }

  enqueue(task, { priority = false } = {}) {
    if (task.queued || this.destroyed) return;

    task.queued = true;
    if (priority) {
      this.tasks.unshift(task);
    } else {
      this.tasks.push(task);
    }
    this.scheduleNext();
  }

  scheduleNext() {
    if (this.scheduledCancel != null || this.tasks.length === 0 || this.destroyed) return;

    let calledSynchronously = true;
    const cancel = this.schedule(() => {
      calledSynchronously = false;
      this.scheduledCancel = null;
      this.runNextTask();
    });
    if (calledSynchronously)
      this.scheduledCancel = typeof cancel === "function" ? cancel : () => {};
  }

  runNextTask() {
    if (this.destroyed) return;

    const task = this.tasks.shift();
    if (task == null) return;
    task.queued = false;

    const hasMore =
      task.kind === "routing" ? this.runRoutingTask(task) : this.runSnapshotTask(task);
    if (hasMore) this.enqueue(task, { priority: task.kind === "routing" });
    this.scheduleNext();
  }

  runRoutingTask(task) {
    if (task.runVersion !== this.routingVersion) {
      task.entries = Array.from(this.registrations);
      task.index = 0;
      task.runVersion = this.routingVersion;
    }

    this.runBatch(task, (registration) => {
      if (registration.disposed || !this.registrations.has(registration)) return;
      const repository = this.getRepository(registration.model.path);
      if (this.rebind(registration, repository)) registration.onRepositoryChange(repository);
    });

    if (task.index < task.entries.length || task.runVersion !== this.routingVersion) return true;

    this.routingTask = null;
    this.routingPending = false;
    return false;
  }

  runSnapshotTask(task) {
    const { state } = task;
    if (this.repositoryStates.get(state.repository) !== state) {
      state.task = null;
      return false;
    }
    if (this.routingPending) return true;

    if (task.runVersion !== state.version || task.routingVersion !== this.routingVersion) {
      if (state.reset) {
        state.pending = new Set(state.registrations);
        state.reset = false;
      }
      task.entries = Array.from(state.pending, (registration) => ({
        registration,
        version: registration.version,
      }));
      task.index = 0;
      task.runVersion = state.version;
      task.routingVersion = this.routingVersion;
    }

    this.runBatch(task, ({ registration, version }) => {
      if (
        registration.disposed ||
        registration.version !== version ||
        registration.repository !== state.repository ||
        !state.registrations.has(registration)
      ) {
        return;
      }
      state.pending.delete(registration);
      registration.onSnapshot(state.repository, {
        ignoredPathsChanged: state.legacyIgnoredPathsChanged,
      });
    });

    if (
      task.index < task.entries.length ||
      task.runVersion !== state.version ||
      task.routingVersion !== this.routingVersion
    ) {
      return true;
    }

    state.task = null;
    state.reset = false;
    state.pending.clear();
    state.legacyIgnoredPathsChanged = false;
    return false;
  }

  runBatch(task, callback) {
    const startedAt = this.now();
    let processed = 0;
    while (task.index < task.entries.length && processed < this.batchSize) {
      callback(task.entries[task.index++]);
      processed++;
      if (this.now() - startedAt >= this.timeSliceMs) break;
    }
  }

  destroy() {
    if (this.destroyed) return;

    this.destroyed = true;
    this.scheduledCancel?.();
    this.scheduledCancel = null;
    this.tasks = [];
    for (const state of this.repositoryStates.values()) state.subscription?.dispose();
    this.repositoryStates.clear();
    this.emitter.dispose();
    for (const registration of this.registrations) {
      registration.disposed = true;
      registration.repository = null;
      registration.version++;
    }
    this.registrations.clear();
    this.routingTask = null;
    this.routingPending = false;
  }
}

const repositoryStatusObserver = new RepositoryStatusObserver();

module.exports = repositoryStatusObserver;
module.exports.RepositoryStatusObserver = RepositoryStatusObserver;
