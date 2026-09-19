import { readFile, readdir } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url))
const coreRoot = join(repositoryRoot, "packages/core")

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  }))
  return nested.flat()
}

function isProductionSource(path) {
  return extname(path) === ".ts"
    && !path.endsWith(".d.ts")
    && !path.endsWith(".test.ts")
    && !path.endsWith(".spec.ts")
    && !path.includes(`${join("", "__tests__")}/`)
}

function analyzeModule(source, path) {
  const results = []
  const runtimeGlobals = new Set()
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    let specifier
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        specifier = node.arguments[0].text
      }
    }
    if (specifier && !specifier.startsWith(".") && !specifier.startsWith("/")) results.push(specifier)
    if (ts.isIdentifier(node) && ["process", "Buffer", "__dirname", "__filename"].includes(node.text)) {
      runtimeGlobals.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { specifiers: results, runtimeGlobals }
}

const packageJson = JSON.parse(await readFile(join(coreRoot, "package.json"), "utf8"))
const failures = []
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  const values = packageJson[field] ?? {}
  if (Object.keys(values).length > 0) failures.push(`packages/core/package.json ${field} must be empty`)
}

const sourceFiles = (await filesUnder(join(coreRoot, "src"))).filter(isProductionSource)
for (const path of sourceFiles) {
  const source = await readFile(path, "utf8")
  const analysis = analyzeModule(source, path)
  for (const specifier of analysis.specifiers) {
    failures.push(`${relative(repositoryRoot, path)} imports runtime module ${JSON.stringify(specifier)}`)
  }
  for (const globalName of analysis.runtimeGlobals) {
    failures.push(`${relative(repositoryRoot, path)} uses Node-specific runtime global ${globalName}`)
  }
}

const distRoot = join(coreRoot, "dist")
try {
  const distFiles = (await filesUnder(distRoot)).filter((path) => extname(path) === ".js")
  for (const path of distFiles) {
    const source = await readFile(path, "utf8")
    for (const specifier of analyzeModule(source, path).specifiers) {
      failures.push(`${relative(repositoryRoot, path)} imports runtime module ${JSON.stringify(specifier)}`)
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}

if (failures.length > 0) {
  console.error("packages/core purity verification failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"))
  process.exitCode = 1
} else {
  console.log(`packages/core purity verified: ${sourceFiles.length} production source files, zero runtime dependencies or host-runtime imports`)
}
