const path = require("node:path");
const TreeView = require("../lib/tree-view");

describe("Tree scrollbar navigation activity", () => {
  it("signals handled boundary navigation without revealing for unrelated text", () => {
    const previousPaths = lumine.project.getPaths();
    lumine.project.setPaths([path.resolve(__dirname, "..")]);
    const tree = new TreeView({});
    try {
      tree.selectEntry(tree.roots[0]);
      const reveal = spyOn(lumine.scrollbars, "reveal");
      const before = tree.scroller.scrollTop;
      lumine.commands.dispatch(tree.element, "core:move-up");
      expect(tree.selectedEntry()).toBe(tree.roots[0]);
      expect(tree.scroller.scrollTop).toBe(before);
      expect(reveal).toHaveBeenCalledWith(tree.scroller);
      reveal.calls.reset();
      tree.element.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
      lumine.commands.dispatch(tree.element, "unrelated:unhandled");
      expect(reveal).not.toHaveBeenCalled();
    } finally {
      tree.destroy();
      lumine.project.setPaths(previousPaths);
    }
  });
});
