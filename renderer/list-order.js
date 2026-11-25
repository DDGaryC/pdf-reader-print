// Keeping a list of files in order, without any screen.

export function moveItem(items, item, before) {
  if (before === item) return items;
  const rest = items.filter((other) => other !== item);
  const index = before ? rest.indexOf(before) : rest.length;
  rest.splice(index, 0, item);
  return rest;
}

export function samePath(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

// Keeps the paths not on the list yet, and each path only once.
export function newPaths(items, paths) {
  const fresh = [];
  for (const path of paths) {
    const known = [...items.map((item) => item.path), ...fresh];
    if (!known.some((other) => samePath(other, path))) fresh.push(path);
  }
  return fresh;
}
