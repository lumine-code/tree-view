const FileOperationEvents = require("../lib/file-operation-events");

describe("tree-view.file-operations", () => {
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
    ]);
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
