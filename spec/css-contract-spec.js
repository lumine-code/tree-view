const fs = require("fs");
const path = require("path");

describe("Tree View selection colors", () => {
  let stylesheet, tree, entry, sticky, button;
  beforeEach(() => {
    stylesheet = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(__dirname, "../styles/main.css"), "utf8"),
      { priority: 1000 },
    );
    tree = document.createElement("div");
    tree.className = "tree-view";
    tree.tabIndex = 0;
    for (const [name, value] of Object.entries({
      "background-color-selected": "rgb(10, 20, 30)",
      "text-color-selected": "rgb(220, 230, 240)",
      "accent-background-color": "rgb(40, 50, 60)",
      "accent-foreground-color": "rgb(200, 210, 220)",
      "button-background-color-selected": "rgb(90, 100, 110)",
    }))
      tree.style.setProperty(`--${name}`, value);
    tree.innerHTML = `<ol class="list-tree"><li class="entry selected list-item"><span class="name">file.txt</span></li></ol>
      <ul class="tree-view-sticky-header-list"><li class="tree-view-sticky-header selected list-nested-item"><div class="tree-view-sticky-header-row"><div class="list-item"><span class="name">Project</span></div></div></li></ul>
      <button class="btn btn-primary">Add Folders</button>`;
    jasmine.attachToDOM(tree);
    entry = tree.querySelector(".entry");
    sticky = tree.querySelector(".tree-view-sticky-header-row");
    button = tree.querySelector("button");
  });
  afterEach(() => stylesheet.dispose());

  it("keeps unfocused row and sticky text paired with the generic selection background", () => {
    expect(getComputedStyle(entry, "::before").backgroundColor).toBe("rgb(10, 20, 30)");
    expect(getComputedStyle(entry.querySelector(".name")).color).toBe("rgb(220, 230, 240)");
    expect(getComputedStyle(sticky).backgroundColor).toBe("rgb(10, 20, 30)");
    expect(getComputedStyle(sticky.querySelector(".name")).color).toBe("rgb(220, 230, 240)");
  });

  it("uses a tree-owned focused pair for ordinary and sticky rows without retinting buttons", () => {
    tree.style.setProperty("--tree-view-selection-background-color", "rgb(15, 25, 35)");
    tree.style.setProperty("--tree-view-selection-foreground-color", "rgb(225, 235, 245)");
    tree.focus();
    expect(getComputedStyle(entry, "::before").backgroundColor).toBe("rgb(15, 25, 35)");
    expect(getComputedStyle(entry.querySelector(".name")).color).toBe("rgb(225, 235, 245)");
    expect(getComputedStyle(sticky).backgroundColor).toBe("rgb(15, 25, 35)");
    expect(getComputedStyle(sticky.querySelector(".name")).color).toBe("rgb(225, 235, 245)");
    expect(getComputedStyle(button).backgroundColor).toBe("rgb(40, 50, 60)");
    expect(getComputedStyle(button).color).toBe("rgb(200, 210, 220)");
  });
});
