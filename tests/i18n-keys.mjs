import fs from 'node:fs'
const src = fs.readFileSync('client.js', 'utf8')
const used = new Set([...src.matchAll(/\bt\('([a-z0-9]+\.[a-zA-Z0-9.]+)'/g)].map(m => m[1]))
// split locales: count occurrences of each key definition
const defs = new Map()
for (const m of src.matchAll(/'([a-z0-9]+\.[a-zA-Z0-9.]+)':/g)) defs.set(m[1], (defs.get(m[1]) ?? 0) + 1)
const missing = [...used].filter(k => !defs.has(k)).sort()
const usedNoDef = missing
const single = [...defs.entries()].filter(([, n]) => n === 1).map(([k]) => k)
const usedSet = used
console.log('used keys:', used.size, 'defined keys:', defs.size)
console.log('used but never defined:', usedNoDef)
console.log('defined only once (should be zh+en => 2):', single)
console.log('used keys missing in one locale (defined once):', single.filter(k => usedSet.has(k)))

process.exit(0)
