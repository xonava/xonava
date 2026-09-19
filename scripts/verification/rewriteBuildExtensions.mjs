import { access, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
const root = join(process.argv[2] ?? ".", "dist")
async function walk(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    if ((await stat(path)).isDirectory()) await walk(path)
    else if (name.endsWith(".js")) {
      const source = await readFile(path, "utf8")
      const pattern = /(from\s+["']|import\s*\(["'])(\.\.?\/[^"']+?)(["'])/g
      let rewritten = ""
      let cursor = 0
      for (const match of source.matchAll(pattern)) {
        const [all, prefix, specifier, quote] = match
        const start = match.index
        rewritten += source.slice(cursor, start)
        if (/\.(?:js|json|node)$/.test(specifier)) {
          rewritten += all
        } else {
          const adjacentFile = resolve(dirname(path), `${specifier}.js`)
          let suffix = ".js"
          try {
            await access(adjacentFile)
          } catch {
            const directoryIndex = resolve(dirname(path), specifier, "index.js")
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
await walk(root)
