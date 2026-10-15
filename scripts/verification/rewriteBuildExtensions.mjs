import { access, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
async function walk(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    if ((await stat(path)).isDirectory()) await walk(path)
    else if (name.endsWith(".js") || name.endsWith(".d.ts")) {
      // Declarations need the same runtime specifiers: NodeNext resolution rejects extensionless
      // relative imports in .d.ts files too.
      const declaration = name.endsWith(".d.ts")
      const source = await readFile(path, "utf8")
      const pattern = /(from\s+["']|import\s*\(["']|^\s*import\s+["'])(\.\.?\/[^"']+?)(["'])/gm
      let rewritten = ""
      let cursor = 0
      for (const match of source.matchAll(pattern)) {
        const [all, prefix, specifier, quote] = match
        const start = match.index
        rewritten += source.slice(cursor, start)
        if (/\.(?:js|json|node)$/.test(specifier)) {
          rewritten += all
        } else {
          const adjacentFile = resolve(dirname(path), `${specifier}${declaration ? ".d.ts" : ".js"}`)
          let suffix = ".js"
          try {
            await access(adjacentFile)
          } catch {
            const directoryIndex = resolve(dirname(path), specifier, declaration ? "index.d.ts" : "index.js")
            await access(directoryIndex)
            suffix = "/index.js"
          }
          rewritten += `${prefix}${specifier}${suffix}${quote}`
        }
        cursor = start + all.length
      }
      rewritten += source.slice(cursor)
      if (rewritten !== source) await writeFile(path, rewritten)
    }
  }
}
// Referenced projects are re-emitted by `tsc -b --force`, so callers pass every package whose
// dist the build touched, not only their own.
for (const packageDirectory of process.argv.length > 2 ? process.argv.slice(2) : ["."]) await walk(join(packageDirectory, "dist"))
