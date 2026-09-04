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
    this.tasks = [];
    this.scheduledCancel = null;
    this.routingVersion = 0;
    this.routingTask = null;
    this.routingPending = false;
    this.destroyed = false;
  }

  observe(model, { onSnapshot, onRepositoryChange = onSnapshot }) {
    if (this.destroyed) throw new Error("Cannot observe a destroyed repository status observer");

    const registration = {
      model,
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
        version: 0,
        task: null,
        subscription: null,
      };
      this.repositoryStates.set(repository, state);
      state.subscription = repository.onDidChangeStatusSnapshot(() => {
        this.repositorySnapshotChanged(state);
      });
    }
    state.registrations.add(registration);
    return true;
  }

  removeFromRepository(registration) {
    const repository = registration.repository;
    if (repository == null) return;

    const state = this.repositoryStates.get(repository);
    state?.registrations.delete(registration);
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

  repositorySnapshotChanged(state) {
    if (this.repositoryStates.get(state.repository) !== state) return;

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
      task.entries = Array.from(state.registrations, (registration) => ({
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
      registration.onSnapshot(state.repository);
    });

    if (
      task.index < task.entries.length ||
      task.runVersion !== state.version ||
      task.routingVersion !== this.routingVersion
    ) {
      return true;
    }

    state.task = null;
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
