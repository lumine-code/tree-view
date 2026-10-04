const FileOperationEvents = require("../lib/file-operation-events");

describe("tree-view.file-operations", () => {
  function stage() {
    return {
      commit: jasmine.createSpy("commit").and.resolveTo(true),
      dispose: jasmine.createSpy("dispose"),
    };
  }

  it("collects preparations before committing once in order", async () => {
    const events = new FileOperationEvents();
    const first = stage();
    const second = stage();
    const seen = [];
    first.commit.and.callFake(({ isCurrent }) => {
      expect(isCurrent()).toBe(true);
      seen.push("first");
      return true;
    });
    second.commit.and.callFake(() => seen.push("second"));
    events.on("willRename", () => first);
    events.on("willRename", () => second);

    const preparation = await events.will("willRename", { files: [] });

    expect(seen).toEqual([]);
    const committed = preparation.commit({ isCurrent: () => true });
    expect(preparation.commit()).toBe(committed);
    expect(await committed).toBe(true);
    expect(seen).toEqual(["first", "second"]);
    await preparation.dispose();
    await preparation.dispose();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes collected preparations when a later listener vetoes", async () => {
    const events = new FileOperationEvents();
    const preparation = stage();
    events.on("willRename", () => preparation);
    events.on("willRename", () => false);

    expect(await events.will("willRename", { files: [] })).toBe(false);

    expect(preparation.commit).not.toHaveBeenCalled();
    expect(preparation.dispose).toHaveBeenCalledTimes(1);
  });

  it("cancels an uncooperative pending listener and disposes its late preparation", async () => {
    const events = new FileOperationEvents();
    const controller = new AbortController();
    const preparation = stage();
    let resolve;
    events.on("willRename", () => new Promise((done) => (resolve = done)));
    const later = jasmine.createSpy("later");
    events.on("willRename", later);

    const pending = events.will("willRename", { files: [], signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(false);
    resolve(preparation);
    await conditionPromise(() => preparation.dispose.calls.count() === 1);

    expect(later).not.toHaveBeenCalled();
    expect(preparation.commit).not.toHaveBeenCalled();
  });

  it("passes a live guard into preparation commits and refuses stale work", async () => {
    const events = new FileOperationEvents();
    let finish;
    let current = true;
    const gate = new Promise((resolve) => (finish = resolve));
    const mutate = jasmine.createSpy("mutate");
    const preparation = stage();
    preparation.commit.and.callFake(async ({ isCurrent }) => {
      await gate;
      if (!isCurrent()) return false;
      mutate();
      return true;
    });
    events.on("willCreate", () => preparation);
    const collected = await events.will("willCreate", { paths: [] });

    const pending = collected.commit({ isCurrent: () => current });
    current = false;
    finish();

    expect(await pending).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    await collected.dispose();
  });

  it("awaits will listeners in order and lets one cancel", async () => {
    const events = new FileOperationEvents();
    const seen = [];
    events.on("willRename", async ({ files }) => {
      await Promise.resolve();
      seen.push(files[0].oldPath);
      return true;
    });
    events.on("willRename", () => {
      seen.push("cancel");
      return false;
    });
    events.on("willRename", () => seen.push("too late"));

    expect(
      await events.will("willRename", { files: [{ oldPath: "before", newPath: "after" }] }),
    ).toBe(false);
    expect(seen).toEqual(["before", "cancel"]);
  });

  it("exposes disposable registrations for all six events", async () => {
    const events = new FileOperationEvents();
    const service = events.service();
    const calls = [];
    const registration = service.onDidCreateFiles(({ paths }) => calls.push(paths));

    await events.did("didCreate", { paths: ["first"] });
    registration.dispose();
    await events.did("didCreate", { paths: ["second"] });

    expect(calls).toEqual([["first"]]);
    expect(Object.keys(service).sort()).toEqual([
      "onDidCreateFiles",
      "onDidDeleteFiles",
      "onDidRenameFiles",
      "onWillCreateFiles",
      "onWillDeleteFiles",
      "onWillRenameFiles",
      "supportsStagedPreparations",
    ]);
    expect(service.supportsStagedPreparations()).toBe(true);
  });

  it("turns a rejected will listener into a controlled veto", async () => {
    const events = new FileOperationEvents();
    spyOn(console, "error");
    events.on("willDelete", () => Promise.reject(new Error("unavailable")));

    expect(await events.will("willDelete", { paths: ["file"] })).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("invokes every did listener synchronously and logs synchronous and asynchronous failures", async () => {
    const events = new FileOperationEvents();
    const seen = [];
    const synchronous = new Error("synchronous listener failure");
    const asynchronous = new Error("asynchronous listener failure");
    spyOn(console, "error");
    events.on("didRename", () => {
      seen.push("first");
      throw synchronous;
    });
    events.on("didRename", () => {
      seen.push("second");
      return Promise.reject(asynchronous);
    });
    events.on("didRename", ({ files }) => seen.push(files[0].newPath));

    const notification = events.did("didRename", {
      files: [{ oldPath: "before", newPath: "after" }],
    });

    expect(seen).toEqual(["first", "second", "after"]);
    await expectAsync(notification).toBeResolved();
    expect(console.error).toHaveBeenCalledWith(
      "tree-view file operation listener failed",
      synchronous,
    );
    expect(console.error).toHaveBeenCalledWith(
      "tree-view file operation listener failed",
      asynchronous,
    );
  });
});
