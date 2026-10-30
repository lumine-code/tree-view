const fs = require("fs");
const os = require("os");
const path = require("path");
const TreeView = require("../lib/tree-view");

describe("Tree View scrollbar with sticky directory headers", () => {
  let originalPaths, projectPath, fixture, treeView, stylesheet;

  beforeEach(async () => {
    originalPaths = lumine.project.getPaths();
    projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-rail-")));
    const nested = path.join(projectPath, "source", "nested");
    fs.mkdirSync(nested, { recursive: true });
    for (let index = 0; index < 100; index++) {
      fs.writeFileSync(
        path.join(nested, `sample-${String(index).padStart(3, "0")}.txt`),
        "sample\n",
      );
    }
    lumine.project.setPaths([projectPath]);
    stylesheet = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(__dirname, "../styles/main.css"), "utf8"),
      { priority: 1000 },
    );
    fixture = document.createElement("div");
    fixture.className = "item-views";
    fixture.style.cssText =
      "position:fixed;left:40px;top:40px;width:320px;height:220px;z-index:10000";
    treeView = new TreeView({});
    treeView.element.style.cssText = "width:100%;height:100%";
    fixture.appendChild(treeView.element);
    jasmine.attachToDOM(fixture);
    await treeView.roots[0].expand();
    await treeView.treeEntryForPath(path.join(projectPath, "source")).expand();
    await treeView.treeEntryForPath(nested).expand();
    await settle();
  });

  afterEach(async () => {
    await treeView?.destroy();
    fixture?.remove();
    stylesheet?.dispose();
    lumine.project.setPaths(originalPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function settle() {
    let frames = 0;
    await waitForFrames(() => ++frames === 3);
  }

  function pointer(target, type, x, y) {
    target.dispatchEvent(
      new PointerEvent(type, {
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        pointerId: 1,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function expectWholeTrack(track, expectedViewport) {
    const rect = track.getBoundingClientRect();
    const viewport = treeView.scroller.getBoundingClientRect();
    const geometry = lumine.scrollbars.getGeometry(treeView.scroller);
    expect(geometry.layout).toBe("overlay");
    expect(geometry.viewportHeight).toBe(expectedViewport);
    expect(geometry.canScrollHorizontally).toBeFalse();
    expect(rect.top).toBe(viewport.top);
    expect(rect.bottom).toBe(viewport.bottom);
    // Test actual pointer targets, including the part painted by every pinned
    // directory. A visually complete rail behind those rows is still unusable.
    for (let y = rect.top + 2; y < rect.bottom; y += 8) {
      expect(track.contains(document.elementFromPoint(rect.right - 3, y))).toBeTrue();
    }
    return rect;
  }

  it("keeps the full track reachable with no, root-only and multiple taller sticky headers", async () => {
    const height = treeView.scroller.clientHeight;
    const track = lumine.scrollbars.getVerticalTrack(treeView.scroller);
    for (const [mode, count] of [
      ["none", 0],
      ["roots", 1],
      ["directories", 3],
    ]) {
      treeView.setStickyHeaderMode(mode);
      treeView.setScrollTop(200);
      await settle();
      expect(treeView.stickyHeaderList.children.length).toBe(count);
      expectWholeTrack(track, height);
    }
    treeView.element.style.setProperty("--tree-view-root-header-height", "48px");
    treeView.element.style.setProperty("--ui-row-height", "32px");
    await settle();
    expect(treeView.stickyHeaderList.getBoundingClientRect().height).toBeGreaterThan(100);
    expectWholeTrack(track, height);
  });

  it("jumps and drags through the whole viewport while sticky headers appear and disappear", async () => {
    treeView.setStickyHeaderMode("directories");
    treeView.setScrollTop(200);
    await settle();
    const track = lumine.scrollbars.getVerticalTrack(treeView.scroller);
    const rect = expectWholeTrack(track, treeView.scroller.clientHeight);
    const x = rect.right - 3;
    const y = rect.top + 45;
    const target = document.elementFromPoint(x, y);
    expect(track.contains(target)).toBeTrue();
    pointer(target, "pointerdown", x, y);
    // A click under the sticky stack jumps in the same event, with no scroll
    // animation and no deduction for the stack's changing painted height.
    expect(treeView.scroller.scrollTop).toBeGreaterThan(200);
    pointer(track, "pointermove", x, rect.bottom);
    expect(treeView.scroller.scrollTop).toBe(
      treeView.scroller.scrollHeight - treeView.scroller.clientHeight,
    );
    await settle();
    expectWholeTrack(track, treeView.scroller.clientHeight);
    pointer(track, "pointermove", x, rect.top);
    expect(treeView.scroller.scrollTop).toBe(0);
    await settle();
    expect(treeView.stickyHeaderList.children.length).toBe(0);
    expectWholeTrack(track, treeView.scroller.clientHeight);
    pointer(track, "pointerup", x, rect.top);
    await treeView.destroy();
    expect(track.isConnected).toBeFalse();
  });
});
