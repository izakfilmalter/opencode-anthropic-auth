import { existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const PLUGINS_DIR = resolve(import.meta.dirname, '..', '.opencode', 'plugins')
const SYMLINK_PATHS = [
  resolve(PLUGINS_DIR, 'anthropic-auth'),
  resolve(PLUGINS_DIR, 'anthropic-auth.js'),
]

let removed = false
for (const path of SYMLINK_PATHS) {
  if (!existsSync(path)) continue
  unlinkSync(path)
  removed = true
  console.log(`[dev:clean] Removed symlink: ${path}`)
}

if (!removed) {
  console.log('[dev:clean] No symlink found, nothing to clean')
}
