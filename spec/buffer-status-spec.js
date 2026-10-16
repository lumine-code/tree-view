const fs = require("fs");
const os = require("os");
const path = require("path");
const { Disposable } = require("lumine");
const File = require("../lib/file");
const Directory = require("../lib/directory");
const observer = require("../lib/buffer-status-observer");

describe("tree entries with unsaved buffers", () => {
  let root, filePath, buffer, models, repository, summary, ignored;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-buffer-status-"));
    filePath = path.join(root, "example.txt");
    fs.writeFileSync(filePath, "original\n");
    models = [];
    summary = null;
    ignored = false;
    repository = {
      getStatusSnapshot: () => ({ initialized: true, files: [] }),
      getPathStatusSummary: () => summary,
      getDirectoryStatusSummary: () => summary,
      isPathIgnoredCached: () => ignored,
      onDidChangeStatusSnapshot: () => new Disposable(),
    };
    spyOn(lumine.repositories, "getForPath").and.returnValue(repository);
    buffer = lumine.project.bufferForPathSync(filePath);
  });

  afterEach(() => {
    for (const model of models) model.destroy();
    buffer.destroy();
    lumine.repositories.getForPath.and.callThrough();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function file(candidate = filePath) {
    const model = new File({
      name: path.basename(candidate),
      fullPath: candidate,
      realPath: candidate,
    });
    models.push(model);
    return model;
  }

  function directory() {
    const model = new Directory({
      name: "project",
      fullPath: root,
      isRoot: true,
      useSyncFS: true,
    });
    models.push(model);
    return model;
  }

  it("updates the file and its directory before save and clears them on undo", () => {
    const entry = file();
    const parent = directory();
    buffer.insert([0, 0], "changed");
    expect(entry.status).toBe("modified");
    expect(parent.status).toBe("modified");
    expect(fs.readFileSync(filePath, "utf8")).toBe("original\n");
    buffer.undo();
    expect(entry.status).toBeNull();
    expect(parent.status).toBeNull();
  });

  it("reads buffers already modified before the tree entry is created", () => {
    buffer.insert([0, 0], "changed");
    expect(file().status).toBe("modified");
    expect(directory().status).toBe("modified");
  });

  for (const status of ["added", "conflicted", "ignored"]) {
    it(`preserves ${status} coloring in files and directories`, () => {
      summary = { [status]: true };
      ignored = status === "ignored";
      const entry = file();
      const parent = directory();
      buffer.insert([0, 0], "changed");
      expect(entry.status).toBe(status);
      expect(parent.status).toBe(status);
    });
  }

  it("restores the saved Git state after undo instead of clearing it", () => {
    summary = { modified: true };
    const entry = file();
    buffer.insert([0, 0], "changed");
    buffer.undo();
    expect(entry.status).toBe("modified");
  });

  it("updates both paths when a dirty buffer moves", () => {
    const original = file();
    const otherPath = path.join(root, "renamed.txt");
    fs.writeFileSync(otherPath, "original\n");
    const renamed = file(otherPath);
    buffer.insert([0, 0], "changed");
    buffer.setPath(otherPath);
    expect(original.status).toBeNull();
    expect(renamed.status).toBe("modified");
  });

  it("clears the overlay when the buffer is destroyed", () => {
    const entry = file();
    const parent = directory();
    buffer.insert([0, 0], "changed");
    buffer.destroy();
    expect(entry.status).toBeNull();
    expect(parent.status).toBeNull();
  });

  it("does not update unrelated entries on a buffer change", () => {
    file();
    const unrelated = file(path.join(root, "other.txt"));
    spyOn(unrelated, "updateStatus").and.callThrough();
    buffer.insert([0, 0], "changed");
    expect(unrelated.updateStatus).not.toHaveBeenCalled();
  });

  it("releases buffer observers with the last entry and resumes on reopening", () => {
    const entry = file();
    entry.destroy();
    models = [];
    expect(observer.subscription).toBeNull();
    expect(observer.buffers.size).toBe(0);
    buffer.insert([0, 0], "changed");
    expect(file().status).toBe("modified");
  });

  it("clears the overlay on save when Git reports no changes", async () => {
    const entry = file();
    buffer.insert([0, 0], "changed");
    await buffer.save();
    expect(entry.status).toBeNull();
  });
});
