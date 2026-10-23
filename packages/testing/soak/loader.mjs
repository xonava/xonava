export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try { return await nextResolve(`${specifier.slice(0, -3)}.ts`, context) } catch { /* not a TypeScript source: resolve it as written */ }
  }
  return nextResolve(specifier, context)
}
