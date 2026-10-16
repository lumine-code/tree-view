const naturalCompare = require("natural-compare-lite");
const collatorCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
  .compare;

function getCompareFn(method = lumine.config.get("tree-view.sortMethod")) {
  return method === "natural" ? naturalCompare : collatorCompare;
}

function parseEntryName(value) {
  const name = typeof value === "string" ? value : value.name || "";
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return { base: name.slice(0, dot).toLowerCase(), ext: name.slice(dot).toLowerCase() };
  }
  return { base: name.toLowerCase(), ext: "" };
}

function getSortComparator() {
  const cmp = getCompareFn();
  const byBase = lumine.config.get("tree-view.sortByBase") ?? true;
  if (byBase) {
    return (first, second) => {
      const a = parseEntryName(first);
      const b = parseEntryName(second);
      const result = cmp(a.base, b.base);
      return result !== 0 ? result : cmp(a.ext, b.ext);
    };
  }
  return (first, second) => {
    const a = typeof first === "string" ? first.toLowerCase() : (first.name || "").toLowerCase();
    const b = typeof second === "string" ? second.toLowerCase() : (second.name || "").toLowerCase();
    return cmp(a, b);
  };
}

function sortEntriesByName(entries, options = null) {
  if (entries.length < 2) return entries;
  const cmp = getCompareFn(options?.sortMethod);
  const byBase = options?.sortByBase ?? lumine.config.get("tree-view.sortByBase") ?? true;
  // Parse/lowercase each name once, rather than allocating keys for every
  // comparison. Keep this cache scoped to the sort so renamed entries and
  // changed settings are picked up by the next directory reload.
  const keyedEntries = entries.map((value) => {
    const key = byBase
      ? parseEntryName(value)
      : {
          base: (typeof value === "string" ? value : value.name || "").toLowerCase(),
          ext: "",
        };
    return { value, ...key };
  });
  keyedEntries.sort((first, second) => {
    const result = cmp(first.base, second.base);
    return byBase && result === 0 ? cmp(first.ext, second.ext) : result;
  });
  for (let index = 0; index < entries.length; index++) {
    entries[index] = keyedEntries[index].value;
  }
  return entries;
}

module.exports = { getSortComparator, sortEntriesByName };
