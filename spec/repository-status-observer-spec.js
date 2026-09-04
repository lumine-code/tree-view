const { Disposable } = require("lumine");

const { RepositoryStatusObserver } = require("../lib/repository-status-observer");

function repositoryForTest(name) {
  const callbacks = new Set();
  return {
    name,
    subscriptionCount: 0,
    onDidChangeStatusSnapshot(callback) {
      this.subscriptionCount++;
      callbacks.add(callback);
      return new Disposable(() => callbacks.delete(callback));
    },
    notify() {
      for (const callback of Array.from(callbacks)) callback();
    },
    subscriberCount() {
      return callbacks.size;
    },
  };
}

function schedulerForTest() {
  const callbacks = [];
  return {
    callbacks,
    schedule(callback) {
      callbacks.push(callback);
      return () => {
        const index = callbacks.indexOf(callback);
        if (index !== -1) callbacks.splice(index, 1);
      };
    },
    runNext() {
      callbacks.shift()?.();
    },
    runAll() {
      while (callbacks.length > 0) callbacks.shift()();
    },
  };
}

describe("RepositoryStatusObserver", () => {
  it("shares one repository subscription and fans snapshots out in bounded batches", () => {
    const repository = repositoryForTest("main");
    const scheduler = schedulerForTest();
    const observer = new RepositoryStatusObserver({
      getRepository: (model) => model.repository,
      schedule: (callback) => scheduler.schedule(callback),
      batchSize: 2,
      timeSliceMs: Infinity,
    });
    const updates = [];
    const registrations = Array.from({ length: 5 }, (_, index) => {
      const model = { path: { repository }, index };
      return observer.observe(model, {
        onSnapshot: (currentRepository) => updates.push([index, currentRepository.name]),
      });
    });

    expect(repository.subscriptionCount).toBe(1);
    expect(repository.subscriberCount()).toBe(1);

    repository.notify();
    expect(updates).toEqual([]);
    expect(scheduler.callbacks.length).toBe(1);

    scheduler.runNext();
    expect(updates).toEqual([
      [0, "main"],
      [1, "main"],
    ]);
    expect(scheduler.callbacks.length).toBe(1);

    scheduler.runNext();
    expect(updates).toEqual([
      [0, "main"],
      [1, "main"],
      [2, "main"],
      [3, "main"],
    ]);
    scheduler.runAll();
    expect(updates.at(-1)).toEqual([4, "main"]);

    for (const registration of registrations) registration.dispose();
    expect(repository.subscriberCount()).toBe(0);
    observer.destroy();
  });

  it("cancels queued work when a model is destroyed or moves to another repository", () => {
    const firstRepository = repositoryForTest("first");
    const secondRepository = repositoryForTest("second");
    const scheduler = schedulerForTest();
    const model = { path: { repository: firstRepository } };
    const updates = [];
    const observer = new RepositoryStatusObserver({
      getRepository: (modelPath) => modelPath.repository,
      schedule: (callback) => scheduler.schedule(callback),
      batchSize: 1,
      timeSliceMs: Infinity,
    });
    const registration = observer.observe(model, {
      onSnapshot: (repository) => updates.push(`snapshot:${repository.name}`),
      onRepositoryChange: (repository) => updates.push(`route:${repository.name}`),
    });

    firstRepository.notify();
    model.path.repository = secondRepository;
    observer.repositoriesChanged();
    scheduler.runAll();

    expect(updates).toEqual(["route:second"]);
    expect(firstRepository.subscriberCount()).toBe(0);
    expect(secondRepository.subscriberCount()).toBe(1);

    secondRepository.notify();
    registration.dispose();
    scheduler.runAll();

    expect(updates).toEqual(["route:second"]);
    expect(secondRepository.subscriberCount()).toBe(0);
    observer.destroy();
  });

  it("time-slices repository rerouting and ignores registrations destroyed between slices", () => {
    const repository = repositoryForTest("main");
    const scheduler = schedulerForTest();
    const routes = new Map();
    const observer = new RepositoryStatusObserver({
      getRepository: (modelPath) => routes.get(modelPath) ?? null,
      schedule: (callback) => scheduler.schedule(callback),
      batchSize: 2,
      timeSliceMs: Infinity,
    });
    const changed = [];
    const models = Array.from({ length: 5 }, (_, index) => ({ path: `path-${index}` }));
    const registrations = models.map((model, index) =>
      observer.observe(model, {
        onSnapshot: () => {},
        onRepositoryChange: (currentRepository) =>
          changed.push([index, currentRepository?.name ?? null]),
      }),
    );
    for (const model of models) routes.set(model.path, repository);

    observer.repositoriesChanged();
    scheduler.runNext();
    expect(changed).toEqual([
      [0, "main"],
      [1, "main"],
    ]);

    registrations[2].dispose();
    scheduler.runAll();
    expect(changed).toEqual([
      [0, "main"],
      [1, "main"],
      [3, "main"],
      [4, "main"],
    ]);
    expect(repository.subscriberCount()).toBe(1);

    for (const registration of registrations) registration.dispose();
    observer.destroy();
  });
});
