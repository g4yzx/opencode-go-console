'use strict'

/**
 * Small file helpers shared by the panel and the bridge.
 *
 * Everything the panel owns is config-sized JSON or an append-only log, so the
 * bar here is simply: never leave a half-written file behind, and never let the
 * logs grow without a ceiling.
 */

const fs = require('node:fs')

/**
 * Write via a sibling temp file and rename it into place.
 *
 * `rename` is atomic on the same volume, so a crash mid-write can only leave a
 * stray `.tmp-<pid>` file — never a truncated config. On Windows a reader may
 * hold the target open without delete sharing (WorkBuddy does this with
 * models.json); in that case fall back to an in-place write so the caller still
 * succeeds instead of losing the user's edit.
 */
function writeFileAtomic (file, data, options) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data, options)
  try {
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    if (err && ['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(err.code)) {
      fs.writeFileSync(file, data, options)
      return false
    }
    throw err
  }
}

/**
 * Move `file` aside once it exceeds `maxBytes`. Keeping exactly one archive
 * means disk use has a hard ceiling of 2x while the dashboard still has a full
 * window of recent data.
 */
function rotateIfBigger (file, maxBytes, archive) {
  let size = 0
  try { size = fs.statSync(file).size } catch { return false }
  if (size <= maxBytes) return false
  const target = archive || `${file}.1`
  try {
    try { fs.unlinkSync(target) } catch {}
    fs.renameSync(file, target)
    return true
  } catch {
    // A locked log is not worth failing a request over.
    return false
  }
}

/** Read at most the last `maxBytes` of a text file, dropping a clipped first line. */
function readTailText (file, maxBytes) {
  const stat = fs.statSync(file)
  if (stat.size <= maxBytes) return fs.readFileSync(file, 'utf8')
  const start = Math.max(0, stat.size - maxBytes)
  const length = stat.size - start
  const buf = Buffer.allocUnsafe(length)
  const fd = fs.openSync(file, 'r')
  try {
    let read = 0
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    const text = buf.toString('utf8', 0, read)
    // Only the byte at `start - 1` tells us whether the slice began on a line
    // boundary; guessing would silently drop or keep a half line.
    const probe = Buffer.allocUnsafe(1)
    fs.readSync(fd, probe, 0, 1, start - 1)
    if (probe[0] === 0x0a) return text
    const cut = text.indexOf('\n')
    return cut === -1 ? text : text.slice(cut + 1)
  } finally {
    fs.closeSync(fd)
  }
}

/** Make a directory without racing another process doing the same thing. */
function ensureDir (dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e
  }
  return dir
}

module.exports = { writeFileAtomic, rotateIfBigger, readTailText, ensureDir }
